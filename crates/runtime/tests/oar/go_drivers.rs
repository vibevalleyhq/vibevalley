use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use vibevalley_runtime::oar::{ControlAction, ControlStatus, EventKind, SessionOptions, StopReason};

#[test]
fn all_go_driver_families_replay_through_child_processes() {
    let directory = tempfile::tempdir().unwrap();
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_vv_test_fixture"));
    let registry = vibevalley_runtime::oar::default_runtimes();
    for (id, family, resume) in [
        ("claude", "claude", Some("092b52de-330b-4d1d-abde-1dee9e56a8df")),
        ("codex", "codex", Some("vendor-root")),
        ("qwen", "qwen", None),
        ("qoder", "qoder", None),
        ("opencode", "acp", None),
        ("grok", "acp", None),
        ("kimi", "acp", None),
        ("codebuddy", "acp", None),
    ] {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/go-{family}.json"));
        let runtime = registry.require(id).unwrap();
        assert!(runtime.capabilities().usage, "{id} can project vendor-reported usage");
        let session = runtime
            .open(SessionOptions {
                bin_path: Some(executable.clone()),
                cwd: directory.path().into(),
                resume: resume.map(String::from),
                env: vec![
                    ("VV_FIXTURE".into(), "cli_replay".into()),
                    ("OAR_REPLAY_FILE".into(), fixture.to_string_lossy().into_owned()),
                ],
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
                && let EventKind::TurnFinished { reason, usage } = ev.kind
            {
                assert_eq!(reason, StopReason::Completed, "{id}");
                let expected = match family {
                    "qwen" => (Some(30), Some(12)),
                    "acp" => (Some(650), Some(155)),
                    "qoder" => (None, None),
                    _ => (Some(150), Some(55)),
                };
                assert_eq!((usage.input_tokens, usage.output_tokens), expected, "{id}: root turn accounting");

                break;
            }
        }
        let records = session.records();
        assert!(records.iter().any(|r| r.span_id == "span-1" && !r.raw.is_empty()), "{id}: missing raw trace");
        let actual: Vec<_> = records
            .iter()
            .flat_map(|r| r.events.iter().map(|e| serde_json::json!({"type":r.frame_type,"path":r.agent_path,"event":e})))
            .collect();
        let gold: Value = serde_json::from_str(include_str!("../fixtures/go-events.json")).unwrap();
        let key = if family == "acp" { "opencode" } else { family };
        assert_eq!(serde_json::json!(actual), gold[key], "every normalized Go event, in frame order ({id})");
        if family == "qoder" {
            assert!(session.usage().is_none());
        } else {
            let tokens = session.usage().unwrap_or_else(|| panic!("{id}: usage absent"));
            let expected = match family {
                "qwen" => (30, 12, 0),
                "acp" => (650, 155, 290),
                _ => (150, 55, 90),
            };
            assert_eq!((tokens.input_tokens, tokens.output_tokens, tokens.cache_read_tokens), expected, "{id}");
        }
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
