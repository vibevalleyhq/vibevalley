use serde_json::{Value, json};
use std::{fs, io::Cursor, os::unix::fs::PermissionsExt, path::Path, sync::Arc, time::Duration};
use vibevalley_oar::{
    ControlAction as A, ControlStatus as S, EventKind, SessionOptions,
    subagent::{Pool, parse_depth},
    voyage::{Reader, Writer},
};

#[test]
fn go_voyage_round_trips_and_rejects_broken_evidence() {
    let gold = include_bytes!("fixtures/go-voyage.jsonl");
    let mut reader = Reader::new(Cursor::new(gold)).unwrap();
    let mut bytes = vec![];
    let mut writer = Writer::new(&mut bytes, reader.header.clone()).unwrap();
    let mut rows = vec![];
    while let Some(r) = reader.read().unwrap() {
        writer.write(&r).unwrap();
        rows.push(r);
    }
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].raw, vec![0, 1, 255]);
    assert!(rows[0].agent_path.is_empty());
    assert_eq!(rows[1].agent_path, ["child"]);
    assert!(writer.write(&rows[2]).is_err());
    let mut restored = Reader::new(Cursor::new(bytes)).unwrap();
    for row in rows {
        assert_eq!(restored.read().unwrap().unwrap(), row);
    }
    assert!(restored.read().unwrap().is_none());
    let with_bad = |rec: Value| format!("{{\"format\":\"oar-voyage/3\",\"version\":3}}\n{rec}\n");
    for bad in [
        json!({"seq":0,"kind":"frame","sessionId":"1","agentPath":null}),
        json!({"seq":-1,"kind":"frame","sessionId":"1","agentPath":[]}),
        json!({"seq":0,"kind":"frame","sessionId":"","agentPath":[]}),
        json!({"seq":0,"kind":"frame","sessionId":"1","agentPath":[],"raw":"!"}),
    ] {
        let s = with_bad(bad);
        assert!(Reader::new(Cursor::new(s)).unwrap().read().is_err());
    }
}

#[test]
fn child_slots_are_released_after_failure_dispose_and_close() {
    let pool = Pool::with_limits(Arc::new(vibevalley_oar::default_runtimes()), 1, 1, Some(0));
    let cwd = tempfile::tempdir().unwrap();
    let opts = || SessionOptions {
        cwd: cwd.path().into(),
        ..Default::default()
    };
    assert!(pool.spawn("missing", opts()).is_err());
    assert_eq!(pool.active(), 0);
    let first = pool.spawn("scripted", opts()).unwrap();
    assert!(matches!(pool.spawn("scripted",opts()),Err(e) if e.rejection_code()==Some("concurrency_limit")));
    first.dispose();
    assert_eq!(pool.active(), 0);
    let next = pool.spawn("scripted", opts()).unwrap();
    pool.close();
    assert_eq!(pool.active(), 0);
    assert_eq!(next.control(A::Prompt, "later", "", "").unwrap().status, S::NotRunning);
    assert!(matches!(pool.spawn("scripted",opts()),Err(e) if e.rejection_code()==Some("pool_closed")));
    assert_eq!(parse_depth("").unwrap(), 0);
    assert!(parse_depth("-1").is_err());
    let capped = Pool::with_limits(Arc::new(vibevalley_oar::default_runtimes()), 1, 1, Some(1));
    assert!(matches!(capped.spawn("scripted",opts()),Err(e) if e.rejection_code()==Some("depth_limit")));
}

#[test]
fn queue_withdraw_raw_frames_cursors_and_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("session.jsonl");
    let binary = dir.path().join("replay");
    fs::write(&binary, include_bytes!("fixtures/cli_replay.py")).unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/go-claude.json");
    let mut sequence: Value = serde_json::from_slice(&fs::read(fixture).unwrap()).unwrap();
    sequence["hold"] = json!([]);
    sequence["release"] = sequence["user"].clone();
    let script = dir.path().join("script.json");
    fs::write(&script, sequence.to_string()).unwrap();
    let opts = SessionOptions {
        bin_path: Some(binary),
        cwd: dir.path().into(),
        record_to: Some(file.clone()),
        env: vec![("OAR_REPLAY_FILE".into(), script.display().to_string())],
        ..Default::default()
    };
    let runtime = vibevalley_oar::default_runtimes().require("claude").unwrap();
    let session = runtime.open(opts.clone()).unwrap();
    assert_eq!(session.control(A::Abort, "", "", "").unwrap().code, "no_active_turn");
    let events = session.events();
    assert_eq!(session.control(A::Prompt, "hold", "", "my-span").unwrap().status, S::Accepted);
    assert_eq!(session.control(A::Compact, "", "", "").unwrap().code, "busy");
    assert_eq!(session.control(A::Prompt, "second", "", "").unwrap().code, "busy");
    session.control(A::Queue, "drop", "drop-id", "").unwrap();
    session.control(A::Queue, "keep", "keep-id", "second-span").unwrap();
    assert_eq!(session.control(A::Withdraw, "drop-id", "", "").unwrap().status, S::Accepted);
    assert_eq!(session.control(A::Withdraw, "drop-id", "", "").unwrap().code, "not_found");
    session.control(A::Steer, "release", "", "").unwrap();
    let mut turns = 0;
    while turns != 2 {
        let e = events.recv_timeout(Duration::from_secs(6)).unwrap();
        if matches!(e.kind, EventKind::TurnFinished { .. }) && e.agent_path.is_empty() {
            turns += 1;
        }
    }
    let records = session.records();
    assert!(records.iter().any(|r| r.agent_path.len() == 2), "missing nested child");
    assert!(records.iter().any(|r| r.events.iter().any(|e| e["input"] == "keep")));
    assert!(!records.iter().any(|r| r.events.iter().any(|e| e["input"] == "drop")));
    assert!(records.iter().any(|r| r.span_id == "second-span" && !r.raw.is_empty()));
    let final_index = records.last().unwrap().seq;
    let follow = session.subscribe_records(Some(final_index));
    session.dispose();
    assert_eq!(follow.recv_timeout(Duration::from_secs(5)).unwrap().seq, final_index + 1);
    let original_len = session.records().len();
    runtime.open(opts).unwrap().dispose();
    let mut reader = Reader::new(std::io::BufReader::new(fs::File::open(file).unwrap())).unwrap();
    let mut rows = 0;
    while reader.read().unwrap().is_some() {
        rows += 1;
    }
    assert!(rows > original_len);
}
