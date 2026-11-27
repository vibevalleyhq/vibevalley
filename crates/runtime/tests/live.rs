//! Live smoke tests against the real CLIs on this machine. Each spends a
//! little of the user's quota, so they only run when asked:
//!
//! ```text
//! cargo test -p vibevalley-runtime --test live -- --ignored --test-threads=1
//! ```
//!
//! Every run works in a fresh temporary directory.

use std::time::Duration;

use vibevalley_runtime::oar::{ContentBlock, EventKind, Installation, PermissionMode, SessionOptions, SessionStatus, StopReason, default_runtimes};

async fn reply_ok(runtime: &str, model: Option<&str>) {
    let registry = default_runtimes();
    let runtime = registry.require(runtime).unwrap();
    if !matches!(runtime.installation().await, Installation::Available { .. }) {
        eprintln!("skipped: {} is not usable here", runtime.id());
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let session = runtime
        .open(SessionOptions {
            cwd: dir.path().to_path_buf(),
            model: model.map(str::to_string),
            permission_mode: PermissionMode::Plan,
            ..Default::default()
        })
        .await
        .unwrap();
    let mut events = session.events();
    session.prompt(vec![ContentBlock::Text("Reply with the single word ok".into())]).await.unwrap();
    let mut text = String::new();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(180), events.recv())
            .await
            .expect("an event within 3 minutes")
            .expect("channel open");
        match event.kind {
            EventKind::TextDelta { text: t } => text.push_str(&t),
            EventKind::TurnFinished { reason, .. } => {
                assert_eq!(reason, StopReason::Completed);
                break;
            }
            _ => {}
        }
    }
    assert!(text.to_lowercase().contains("ok"), "{text:?}");
    assert_eq!(session.status(), SessionStatus::Idle);
    session.dispose().await;
}

async fn abort_a_turn(runtime: &str, model: Option<&str>) {
    let registry = default_runtimes();
    let runtime = registry.require(runtime).unwrap();
    if !matches!(runtime.installation().await, Installation::Available { .. }) {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let session = runtime
        .open(SessionOptions {
            cwd: dir.path().to_path_buf(),
            model: model.map(str::to_string),
            permission_mode: PermissionMode::Plan,
            ..Default::default()
        })
        .await
        .unwrap();
    let mut events = session.events();
    session
        .prompt(vec![ContentBlock::Text("Count slowly from 1 to 500, one number per line.".into())])
        .await
        .unwrap();
    // Abort once the model has started answering.
    loop {
        let event = tokio::time::timeout(Duration::from_secs(180), events.recv())
            .await
            .expect("output")
            .expect("channel open");
        if matches!(event.kind, EventKind::TextDelta { .. } | EventKind::ThinkingDelta { .. }) {
            break;
        }
    }
    session.abort().await.unwrap();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(60), events.recv())
            .await
            .expect("the turn ends after abort")
            .expect("channel open");
        if let EventKind::TurnFinished { reason, .. } = event.kind {
            assert_eq!(reason, StopReason::Aborted);
            break;
        }
    }
    session.dispose().await;
}

#[tokio::test]
#[ignore = "spends quota"]
async fn claude_replies() {
    reply_ok("claude", Some("haiku")).await;
}

#[tokio::test]
#[ignore = "spends quota"]
async fn claude_aborts() {
    abort_a_turn("claude", Some("haiku")).await;
}

#[tokio::test]
#[ignore = "spends quota"]
async fn codex_replies() {
    reply_ok("codex", None).await;
}

#[tokio::test]
#[ignore = "spends quota"]
async fn codex_aborts() {
    abort_a_turn("codex", None).await;
}

/// Reads the signed-in accounts' usage; sends no prompt, spends nothing.
#[tokio::test]
#[ignore]
async fn live_account_usage() {
    let registry = default_runtimes();
    for id in ["claude", "codex"] {
        let usage = registry.require(id).unwrap().account_usage().await.unwrap();
        let wire = serde_json::to_value(&usage).unwrap();
        println!("{id}: {} windows={}", wire["kind"], wire["windows"].as_array().map(Vec::len).unwrap_or(0));
        assert!(matches!(
            usage,
            vibevalley_runtime::oar::AccountUsage::Available { .. }
                | vibevalley_runtime::oar::AccountUsage::ReauthRequired { .. }
                | vibevalley_runtime::oar::AccountUsage::Unsupported { .. }
        ));
    }
}

/// Non-destructive ACP capability & handshake checks for installed external CLIs without sending any prompt.
async fn probe_acp_without_spend(runtime_id: &str) {
    let registry = default_runtimes();
    let runtime = registry.require(runtime_id).unwrap();
    let Installation::Available { version, path } = runtime.installation().await else {
        eprintln!("skipped: {runtime_id} is not usable on this host");
        return;
    };
    assert!(!path.as_os_str().is_empty());
    let models = runtime.list_models().await.unwrap();
    println!("{runtime_id} version={version:?} models={}", models.len());
    let dir = tempfile::tempdir().unwrap();
    let session = runtime
        .open(SessionOptions {
            cwd: dir.path().to_path_buf(),
            permission_mode: PermissionMode::Ask,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(session.status(), SessionStatus::Idle);
    session.dispose().await;
}

#[tokio::test]
#[ignore = "requires local opencode CLI binary; sends no LLM prompt"]
async fn opencode_probes_acp_without_spend() {
    probe_acp_without_spend("opencode").await;
}

#[tokio::test]
#[ignore = "requires local grok CLI binary; sends no LLM prompt"]
async fn grok_probes_acp_without_spend() {
    probe_acp_without_spend("grok").await;
}

#[tokio::test]
#[ignore = "requires local kimi CLI binary; sends no LLM prompt"]
async fn kimi_probes_acp_without_spend() {
    probe_acp_without_spend("kimi").await;
}
