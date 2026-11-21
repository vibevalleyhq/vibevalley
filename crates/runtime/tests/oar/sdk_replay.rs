use serde_json::Value;
use std::{fs, os::unix::fs::PermissionsExt, path::Path, time::Duration};
use vibevalley_runtime::oar::{ContentBlock, EventKind, McpServer, SessionOptions, StopReason};

#[test]
fn sdk_streams_keep_secrets_private_and_resume_with_the_vendors_id() {
    let root = tempfile::tempdir().unwrap();
    let binary = root.path().join("sdk-replay");
    fs::write(&binary, include_bytes!("../fixtures/sdk_replay.py")).unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    let registry = vibevalley_runtime::oar::default_runtimes();
    for id in ["qwen", "qoder"] {
        let runtime = registry.require(id).unwrap();
        vibevalley_runtime::oar::set_binary(id, Some(binary.clone()));
        let log = root.path().join(id);
        let opts = SessionOptions {
            cwd: root.path().into(),
            system_prompt: Some("system\nexample".into()),
            append_system_prompt: Some("append\nexample".into()),
            env: vec![
                ("REPLAY_LOG".into(), log.display().to_string()),
                ("QODER_EXPOSE_TOKEN_USAGE".into(), "0".into()),
            ],
            mcp_servers: vec![McpServer::Http {
                name: "demo".into(),
                url: "https://example.test/mcp".into(),
                headers: vec![("Authorization".into(), "fixture-token".into())],
            }],
            ..Default::default()
        };
        let session = runtime.open(opts).unwrap();
        let events = session.events_with_history();
        session.prompt(vec![ContentBlock::Text("multiline\nprompt".into())]).unwrap();
        let mut heard = false;
        loop {
            match events.recv_timeout(Duration::from_secs(5)).unwrap().kind {
                EventKind::TextDelta { text } => heard |= text == "hello sdk",
                EventKind::TurnFinished { reason, usage } => {
                    assert_eq!(reason, StopReason::Completed);
                    assert_eq!(
                        (usage.input_tokens, usage.output_tokens),
                        if id == "qwen" { (Some(30), Some(12)) } else { (None, None) }
                    );
                    break;
                }
                _ => {}
            }
        }
        assert!(heard);
        assert_eq!(session.resume_id().as_deref(), Some("vendor-42"));
        session.dispose();
        let rows: Vec<Value> = fs::read_to_string(log).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        let launch = &rows[0];
        assert!(!launch["argv"].to_string().contains("fixture-token"));
        if id == "qwen" {
            assert_eq!(rows[1]["request"]["subtype"], "initialize");
            assert_eq!(rows[1]["request"]["mcpServers"]["demo"]["httpUrl"], "https://example.test/mcp");
            assert_eq!(rows[1]["request"]["mcpServers"]["demo"]["headers"]["Authorization"], "fixture-token");
        } else {
            assert_eq!(launch["usage"], "1");
            assert!(!launch["argv"].to_string().contains("example"));
            for key in ["prompt", "append", "mcp"] {
                let file = &launch[key];
                assert_eq!(file[1], 0o700);
                assert_eq!(file[2], 0o600);
                assert!(!Path::new(file[0].as_str().unwrap()).parent().unwrap().exists());
            }
            assert_eq!(launch["prompt"][3], "system\nexample");
            assert_eq!(launch["append"][3], "append\nexample");
            assert!(launch["mcp"][3].as_str().unwrap().contains("fixture-token"));
        }
        assert_eq!(rows.last().unwrap()["message"]["content"], "multiline\nprompt");
        vibevalley_runtime::oar::set_binary(id, None);
    }
}
