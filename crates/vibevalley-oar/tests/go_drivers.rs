use serde_json::Value;
use std::{fs, os::unix::fs::PermissionsExt, path::Path, time::Duration};
use vibevalley_oar::{ControlAction, ControlStatus, EventKind, SessionOptions, StopReason};

#[test]
fn all_go_driver_families_replay_through_child_processes() {
    let directory = tempfile::tempdir().unwrap();
    let executable = directory.path().join("replay");
    fs::write(&executable, include_bytes!("fixtures/cli_replay.py")).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let registry = vibevalley_oar::default_runtimes();
    for (id, family, resume) in [
        ("claude", "claude", Some("092b52de-330b-4d1d-abde-1dee9e56a8df")),
        ("codex", "codex", Some("vendor-root")),
        ("opencode", "acp", None),
        ("grok", "acp", None),
        ("kimi", "acp", None),
        ("codebuddy", "acp", None),
    ] {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/go-{family}.json"));
        let session = registry
            .require(id)
            .unwrap()
            .open(SessionOptions {
                bin_path: Some(executable.clone()),
                cwd: directory.path().into(),
                resume: resume.map(String::from),
                env: vec![("OAR_REPLAY_FILE".into(), fixture.to_string_lossy().into_owned())],
                record_to: Some(directory.path().join(format!("{id}.jsonl"))),
                ..Default::default()
            })
            .unwrap_or_else(|e| panic!("{id}: {e}"));
        let stream = session.events();
        let out = session.control(ControlAction::Prompt, "hello", "input1", "span-1").unwrap();
        assert_eq!(out.status, ControlStatus::Accepted, "{id}: {out:?}");
        loop {
            let ev = stream.recv_timeout(Duration::from_secs(6)).unwrap_or_else(|e| panic!("{id}: {e}"));
            if ev.agent_path.is_empty()
                && let EventKind::TurnFinished { reason, .. } = ev.kind
            {
                assert_eq!(reason, StopReason::Completed, "{id}");
                break;
            }
        }
        let records = session.records();
        assert!(records.iter().any(|r| r.span_id == "span-1" && !r.raw.is_empty()), "{id}: missing raw trace");
        let tokens = session.usage().unwrap_or_else(|| panic!("{id}: usage absent"));
        let (input, output) = if family == "acp" { (650, 155) } else { (150, 55) };
        assert_eq!((tokens.input_tokens, tokens.output_tokens), (input, output), "{id}");
        assert_eq!(tokens.cache_read_tokens, if family == "acp" { 290 } else { 90 }, "{id}");
        let text: Vec<_> = records
            .iter()
            .filter(|r| r.agent_path.is_empty())
            .flat_map(|r| &r.events)
            .filter(|e| e["kind"] == "text_delta")
            .filter_map(|e| e["text"].as_str())
            .collect();
        assert!(!text.is_empty(), "{id}: frame has no root text");
        let prior = records.last().unwrap().seq;
        let stream = session.subscribe_records(Some(prior));
        session.dispose();
        assert!(stream.into_iter().all(|r| r.seq > prior));
        let disk = fs::read_to_string(directory.path().join(format!("{id}.jsonl"))).unwrap();
        let header: Value = serde_json::from_str(disk.lines().next().unwrap()).unwrap();
        assert_eq!(header["format"], "oar-voyage/3");
        assert_eq!(header["version"], 3);
    }
}
