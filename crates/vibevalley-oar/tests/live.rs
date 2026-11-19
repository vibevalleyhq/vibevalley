//! Live smoke tests against the real CLIs on this machine. Each spends a
//! little of the user's quota, so they only run when asked:
//!
//! ```text
//! cargo test -p vibevalley-oar --test live -- --ignored --test-threads=1
//! ```
//!
//! Every run works in a fresh temporary directory.

use std::time::Duration;

use vibevalley_oar::{ContentBlock, EventKind, Installation, PermissionMode, SessionOptions, SessionStatus, StopReason, default_runtimes};

fn reply_ok(runtime: &str, model: Option<&str>) {
    let registry = default_runtimes();
    let runtime = registry.require(runtime).unwrap();
    if !matches!(runtime.installation(), Installation::Available { .. }) {
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
        .unwrap();
    let events = session.events();
    session.prompt(vec![ContentBlock::Text("Reply with the single word ok".into())]).unwrap();
    let mut text = String::new();
    loop {
        let event = events.recv_timeout(Duration::from_secs(180)).expect("an event within 3 minutes");
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
    session.dispose();
}

fn abort_a_turn(runtime: &str, model: Option<&str>) {
    let registry = default_runtimes();
    let runtime = registry.require(runtime).unwrap();
    if !matches!(runtime.installation(), Installation::Available { .. }) {
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
        .unwrap();
    let events = session.events();
    session
        .prompt(vec![ContentBlock::Text("Count slowly from 1 to 500, one number per line.".into())])
        .unwrap();
    // Abort once the model has started answering.
    loop {
        let event = events.recv_timeout(Duration::from_secs(180)).expect("output");
        if matches!(event.kind, EventKind::TextDelta { .. } | EventKind::ThinkingDelta { .. }) {
            break;
        }
    }
    session.abort().unwrap();
    loop {
        let event = events.recv_timeout(Duration::from_secs(60)).expect("the turn ends after abort");
        if let EventKind::TurnFinished { reason, .. } = event.kind {
            assert_eq!(reason, StopReason::Aborted);
            break;
        }
    }
    session.dispose();
}

#[test]
#[ignore = "spends quota"]
fn claude_replies() {
    reply_ok("claude", Some("haiku"));
}

#[test]
#[ignore = "spends quota"]
fn claude_aborts() {
    abort_a_turn("claude", Some("haiku"));
}

#[test]
#[ignore = "spends quota"]
fn codex_replies() {
    reply_ok("codex", None);
}

#[test]
#[ignore = "spends quota"]
fn codex_aborts() {
    abort_a_turn("codex", None);
}

/// Reads the signed-in accounts' usage; sends no prompt, spends nothing.
#[test]
#[ignore]
fn live_account_usage() {
    let registry = default_runtimes();
    for id in ["claude", "codex"] {
        let usage = registry.require(id).unwrap().account_usage().unwrap();
        let wire = serde_json::to_value(&usage).unwrap();
        println!("{id}: {} windows={}", wire["kind"], wire["windows"].as_array().map(Vec::len).unwrap_or(0));
        assert!(matches!(
            usage,
            vibevalley_oar::AccountUsage::Available { .. }
                | vibevalley_oar::AccountUsage::ReauthRequired { .. }
                | vibevalley_oar::AccountUsage::Unsupported { .. }
        ));
    }
}
