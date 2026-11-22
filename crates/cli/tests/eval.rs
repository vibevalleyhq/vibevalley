//! End-to-end tests for the optional `vibevalley-eval` developer binary (`--features eval`).

use std::process::Command;

use serde_json::{Value, json};

struct Ran {
    code: i32,
    out: String,
    failure: Option<Value>,
}

fn eval_cli(home: &std::path::Path, args: &[&str]) -> Ran {
    let output = Command::new(env!("CARGO_BIN_EXE_vibevalley-eval"))
        .args(args)
        .env("VIBEVALLEY_HOME", home)
        .env_remove("DEEPSEEK_API_KEY")
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ran {
        code: output.status.code().unwrap_or(-1),
        out: String::from_utf8_lossy(&output.stdout).trim_end().to_string(),
        failure: stderr.lines().last().and_then(|l| serde_json::from_str(l).ok()),
    }
}

#[test]
fn eval_export_and_inspect_work_end_to_end_on_sqlite_and_jsonl() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("execution.db");
    let jsonl_dir = dir.path().join("exported-jsonl");
    let html_path = dir.path().join("trace.html");

    for sub in ["export", "inspect", "replay", "run"] {
        let help = eval_cli(dir.path(), &[sub, "--help"]);
        assert_eq!((sub, help.code, help.out.contains("Examples:")), (sub, 0, true), "{}", help.out);
    }

    let store = vibevalley_runtime::agent::durable::Store::open(&db_path).unwrap();
    store
        .write(|tx| {
            tx.create_conversation("conv-cli", "deepseek-flash")?;
            tx.append_entry("conv-cli", "pi.user", &json!({ "text": "hello" }))?;
            tx.append_entry(
                "conv-cli",
                "pi.assistant",
                &json!({
                    "text": "",
                    "toolCalls": [{ "id": "c1", "toolName": "read", "argsJson": { "path": "Cargo.toml" } }]
                }),
            )?;
            tx.append_entry(
                "conv-cli",
                "pi.tool_result",
                &json!({ "toolCallId": "c1", "toolName": "read", "ok": true, "output": "ok" }),
            )?;
            tx.append_entry("conv-cli", "pi.assistant", &json!({ "text": "all good" }))?;
            Ok(())
        })
        .unwrap();
    store.close().unwrap();

    let exported = eval_cli(
        dir.path(),
        &[
            "export",
            "conv-cli",
            "--source",
            db_path.to_str().unwrap(),
            "--out",
            jsonl_dir.to_str().unwrap(),
            "--json",
        ],
    );
    assert_eq!(exported.code, 0, "{:?}", exported.failure);
    let manifest: Value = serde_json::from_str(&exported.out).unwrap();
    assert_eq!(manifest["rootConversationId"], "conv-cli");
    assert_eq!(manifest["entriesExported"], 4);

    let dry = eval_cli(
        dir.path(),
        &[
            "export",
            "conv-cli",
            "--source",
            db_path.to_str().unwrap(),
            "--out",
            jsonl_dir.to_str().unwrap(),
            "--dry-run",
        ],
    );
    assert_eq!(dry.code, 2);

    let inspected_jsonl = eval_cli(
        dir.path(),
        &["inspect", jsonl_dir.to_str().unwrap(), "--html", html_path.to_str().unwrap(), "--json"],
    );
    assert_eq!(inspected_jsonl.code, 0, "{:?}", inspected_jsonl.failure);
    let metrics: Value = serde_json::from_str(&inspected_jsonl.out).unwrap();
    assert_eq!(metrics["conversationId"], "conv-cli");
    assert_eq!(metrics["turns"], 2);
    assert_eq!(metrics["toolCallsTotal"], 1);
    assert!(html_path.is_file());
    assert!(std::fs::read_to_string(&html_path).unwrap().contains("conv-cli"));

    let inspected_sqlite = eval_cli(dir.path(), &["inspect", db_path.to_str().unwrap(), "--timeline"]);
    assert_eq!(inspected_sqlite.code, 0, "{:?}", inspected_sqlite.failure);
    assert!(inspected_sqlite.out.contains("Conversation: conv-cli"));
}
