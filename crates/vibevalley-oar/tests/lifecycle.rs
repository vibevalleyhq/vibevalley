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

#[test]
fn codex_compaction_blocks_queue_until_the_native_end_marker() {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixListener;
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("driver");
    fs::write(&bin, include_bytes!("fixtures/cli_replay.py")).unwrap();
    fs::set_permissions(&bin, fs::Permissions::from_mode(0o700)).unwrap();
    let socket = dir.path().join("gate");
    let listener = UnixListener::bind(&socket).unwrap();
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/go-codex.json");
    let runtime = vibevalley_oar::default_runtimes().require("codex").unwrap();
    let session = runtime
        .open(SessionOptions {
            cwd: dir.path().into(),
            bin_path: Some(bin),
            env: vec![
                ("OAR_REPLAY_FILE".into(), file.display().to_string()),
                ("OAR_REPLAY_GATE".into(), socket.display().to_string()),
            ],
            ..Default::default()
        })
        .unwrap();
    let observed = session.subscribe_records(None);
    assert_eq!(session.control(A::Compact, "", "", "").unwrap().status, S::Accepted);
    let (mut held, _) = listener.accept().unwrap();
    let mut message = [0; 4];
    held.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    held.read_exact(&mut message).unwrap();
    let result = session.control(A::Queue, "later", "id", "").unwrap();
    assert_eq!((result.status, result.code.as_str()), (S::Rejected, "compacting"));
    held.write_all(b"1").unwrap();
    loop {
        let rec = observed.recv_timeout(Duration::from_secs(4)).unwrap();
        if rec.events.iter().any(|e| e["kind"] == "compaction_ended") {
            break;
        }
    }
    assert_eq!(session.control(A::Prompt, "hello", "", "").unwrap().status, S::Accepted);
    session.dispose();
}

#[test]
fn resumed_sessions_with_no_token_baseline_leave_usage_unknown() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("driver");
    fs::write(&bin, include_bytes!("fixtures/cli_replay.py")).unwrap();
    fs::set_permissions(&bin, fs::Permissions::from_mode(0o700)).unwrap();
    for (id, family, reason) in [
        ("codex", "codex", "missing_codex_resume_baseline"),
        ("claude", "claude", "missing_resume_usage_fields"),
        ("grok", "acp", "acp_resume_baseline_unknown"),
    ] {
        let file = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/go-{family}.json"));
        let mut responses: Value = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
        match family {
            "claude" => responses["get_usage"][0]["response"]["response"] = json!({}),
            "codex" => {
                responses["thread/resume"][0]["result"].as_object_mut().unwrap().remove("tokenUsage");
            }
            _ => {}
        }
        let file = dir.path().join(format!("{id}-responses.json"));
        fs::write(&file, responses.to_string()).unwrap();
        let session = vibevalley_oar::default_runtimes()
            .require(id)
            .unwrap()
            .open(SessionOptions {
                bin_path: Some(bin.clone()),
                cwd: dir.path().into(),
                resume: Some(
                    if id == "claude" {
                        "092b52de-330b-4d1d-abde-1dee9e56a8df"
                    } else {
                        "vendor-root"
                    }
                    .to_owned(),
                ),
                env: vec![("OAR_REPLAY_FILE".into(), file.display().to_string())],
                ..Default::default()
            })
            .unwrap();
        let events = session.events();
        session.control(A::Prompt, "hello", "", "").unwrap();
        loop {
            let e = events.recv_timeout(Duration::from_secs(4)).unwrap();
            if e.agent_path.is_empty() && matches!(e.kind, EventKind::TurnFinished { .. }) {
                break;
            }
        }
        assert!(session.usage().is_none(), "{id}");
        assert!(
            session
                .records()
                .iter()
                .any(|r| r.agent_path.is_empty() && r.events.iter().any(|e| e["usage"]["unknownReason"] == reason)),
            "{id}"
        );
        session.dispose();
    }
}

#[test]
fn nonzero_process_exit_fails_the_active_turn_and_waiter() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("replay");
    fs::write(&bin, include_bytes!("fixtures/cli_replay.py")).unwrap();
    fs::set_permissions(&bin, fs::Permissions::from_mode(0o700)).unwrap();
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/go-claude.json");
    let session = vibevalley_oar::default_runtimes()
        .require("claude")
        .unwrap()
        .open(SessionOptions {
            cwd: dir.path().into(),
            bin_path: Some(bin),
            env: vec![
                ("OAR_REPLAY_EXIT".into(), "23".into()),
                ("OAR_REPLAY_FILE".into(), script.display().to_string()),
            ],
            ..Default::default()
        })
        .unwrap();
    session.control(A::Prompt, "run", "", "").unwrap();
    assert!(session.wait().unwrap_err().to_string().contains("23"));
    let records = session.records();
    assert_eq!(records.last().unwrap().events[0], json!({"kind":"exited","code":23}));
    assert!(records.iter().flat_map(|r| &r.events).any(|e| e["outcome"]["kind"] == "failed"));
}

#[test]
fn dispose_removes_the_worker_process_group() {
    use nix::{errno::Errno, sys::signal::kill, unistd::Pid};
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("replay");
    fs::write(&bin, include_bytes!("fixtures/cli_replay.py")).unwrap();
    fs::set_permissions(&bin, fs::Permissions::from_mode(0o700)).unwrap();
    let file = dir.path().join("pids.json");
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/go-claude.json");
    let session = vibevalley_oar::default_runtimes()
        .require("claude")
        .unwrap()
        .open(SessionOptions {
            cwd: dir.path().into(),
            bin_path: Some(bin),
            env: vec![
                ("OAR_REPLAY_CHILD".into(), file.display().to_string()),
                ("OAR_REPLAY_FILE".into(), script.display().to_string()),
            ],
            ..Default::default()
        })
        .unwrap();
    let pids: Vec<i32> = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
    assert_eq!(pids.len(), 2);
    assert!(pids.iter().all(|p| kill(Pid::from_raw(*p), None).is_ok()));
    session.dispose();
    for pid in pids {
        assert_eq!(kill(Pid::from_raw(pid), None), Err(Errno::ESRCH));
    }
}

#[test]
fn every_declared_refusal_precedes_process_spawn() {
    use vibevalley_oar::RefusableOption::*;
    let dir = tempfile::tempdir().unwrap();
    let registry = vibevalley_oar::default_runtimes();
    for id in ["claude", "codex", "opencode", "grok", "kimi", "codebuddy", "qwen", "qoder"] {
        let rt = registry.require(id).unwrap();
        assert_eq!(rt.id(), id);
        for option in rt.refused_options() {
            let mut opts = SessionOptions {
                cwd: dir.path().into(),
                bin_path: Some(dir.path().join("does-not-exist")),
                ..Default::default()
            };
            match option {
                SystemPrompt => opts.system_prompt = Some("p".into()),
                AppendSystemPrompt => opts.append_system_prompt = Some("p".into()),
                Effort => opts.effort = Some("high".into()),
                DisallowedTools => opts.disallowed_tools.push("write".into()),
                AllowedTools => opts.allowed_tools.push("read".into()),
                AdditionalDirectories => opts.additional_directories.push(dir.path().into()),
                OutputSchema => opts.output_schema = Some(json!({"type":"object"})),
                Name => opts.name = Some("named".into()),
                ServiceTier => opts.service_tier = Some("priority".into()),
                LaunchArgs => opts.launch_args.push("flag".into()),
            }
            assert!(matches!(rt.open(opts), Err(vibevalley_oar::AgentError::Unsupported { .. })), "{id} {option:?}");
        }
    }
}
