use std::io::Write;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use crate::support::{execute_sql, inspect_db};
use serde_json::json;
use vibevalley_protocol::{MessageKind, Outcome};
use vibevalley_runtime::agent::durable::SubmissionStatus;
use vibevalley_runtime::oar::Registry;
use vibevalley_runtime::oar::scripted::{Script, ScriptedRuntime, Step};
use vibevalley_server::{App, Config, create_app_blocking};

use super::{call, git, until};

const HOME_KEY: &str = "VV_TEST_ISSUE_REPLY_HOME";
const WINDOW_KEY: &str = "VV_TEST_ISSUE_REPLY_WINDOW";
const FOLLOW_UP: &str = "save confirmed change";
const UNKNOWN: &str = "save change before disconnect";

fn launch(home: &Path, window: &str) -> (App, vibevalley_server::gateway::http::Listener) {
    let crash_after_commit = window == "git";
    let mut registry = Registry::new();
    registry.register(Arc::new(ScriptedRuntime::new(
        "scripted",
        Script::computed(Arc::new(move |ask| {
            let summary = if ask.prompt.contains(UNKNOWN) {
                UNKNOWN
            } else if ask.prompt.contains(FOLLOW_UP) {
                FOLLOW_UP
            } else {
                "initial"
            };
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(ask.cwd.join("delivery.txt"))
                .unwrap();
            writeln!(file, "{summary}").unwrap();
            git(&ask.cwd, &["add", "delivery.txt"]);
            git(
                &ask.cwd,
                &[
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.com",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "-qm",
                    summary,
                ],
            );
            if crash_after_commit && summary == UNKNOWN {
                std::process::exit(83);
            }
            Ok(vec![
                Step::text(summary),
                Step::Emit(vibevalley_runtime::oar::EventKind::TurnFinished {
                    reason: vibevalley_runtime::oar::StopReason::Completed,
                    usage: vibevalley_runtime::oar::Usage {
                        input_tokens: Some(12),
                        output_tokens: Some(4),
                        cost_usd: None,
                        ..Default::default()
                    },
                }),
            ])
        })),
    )));
    let server = create_app_blocking(Config {
        registry: Some(Arc::new(registry)),
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        orchestrator_listens: false,
        ..Config::under(home)
    })
    .unwrap();
    let listener = vibevalley_server::gateway::http::serve(server.server(), "127.0.0.1:0".parse().unwrap()).unwrap();
    server.set_mcp_url(format!("{}/mcp", listener.url()));
    (server, listener)
}

fn issue_thread(server: &App) -> (String, String) {
    let issue = crate::support::board_issue(server.test_internals().board, "1").unwrap();
    let thread = until(server, "issue thread", || server.test_internals().channel.issue_thread_id(&issue.id));
    (issue.id, thread)
}

fn count_notes(server: &App, thread: &str, summary: &str) -> usize {
    vibevalley_runtime::rt::block_on(server.test_internals().channel.history_async(thread, None, None))
        .unwrap()
        .iter()
        .filter(|m| m.kind == MessageKind::Report && m.text == summary)
        .count()
}

fn reply_id(server: &App, thread: &str, key: &str) -> String {
    let messages = vibevalley_runtime::rt::block_on(server.test_internals().channel.history_async(thread, None, None)).unwrap();
    let mut matches = messages.iter().filter(|m| m.send_key.as_deref() == Some(key));
    let id = matches.next().expect("reply persisted").id.clone();
    assert!(matches.next().is_none(), "duplicate chat reply: {key}");
    id
}

fn comment(url: &str, issue: &str, text: &str) {
    call(url, "issue.comment.create", json!({"id":issue,"text":text,"sendKey":text}));
}

fn crash_scenario(home: &Path, window: &str, expected_exit: i32) {
    let crashed = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "mainline::recovery::regression_replies_and_reports_across_process_exit",
            "--nocapture",
        ])
        .env(HOME_KEY, home)
        .env(WINDOW_KEY, window)
        .output()
        .unwrap();
    assert_eq!(
        crashed.status.code(),
        Some(expected_exit),
        "{window}: {}\n{}",
        String::from_utf8_lossy(&crashed.stdout),
        String::from_utf8_lossy(&crashed.stderr)
    );
}

#[test]
fn regression_replies_and_reports_across_process_exit() {
    if let Some(home) = std::env::var_os(HOME_KEY) {
        let window = std::env::var(WINDOW_KEY).unwrap();
        let (server, listener) = launch(Path::new(&home), &window);
        let url = listener.url();
        if window == "message" {
            call(&url, "repo.create", json!({"name":"demo"}));
            let mut profile = vibevalley_runtime::rt::block_on(server.test_internals().agent.profile.store.install_template_async("reviewer")).unwrap();
            profile.runtime = "scripted".into();
            profile.name = "Worker".into();
            vibevalley_runtime::rt::block_on(server.test_internals().agent.profile.store.save_async(profile)).unwrap();
            let issue = call(&url, "issue.create", json!({"title":"Write a file","repo":"demo","agent":"Worker"}));
            call(&url, "issue.status.update", json!({"id": issue["id"],"status":"todo"}));
            let (issue, thread) = issue_thread(&server);
            until(&server, "first report", || (count_notes(&server, &thread, "initial") == 1).then_some(()));
            // Hold the issue dispatcher before accepting the next chat write, leaving its delivery pending in SQLite.
            vibevalley_runtime::rt::block_on(server.test_internals().issue_chat.close_async());
            comment(&url, &issue, FOLLOW_UP);
            assert!(
                vibevalley_runtime::rt::block_on(server.test_internals().channel.history_async(&thread, None, None))
                    .unwrap()
                    .iter()
                    .any(|m| m.send_key.as_deref() == Some(FOLLOW_UP))
            );
            assert_eq!(
                vibevalley_runtime::rt::block_on(server.test_internals().board.runs_async(&issue))
                    .unwrap()
                    .len(),
                1
            );
            std::process::exit(81);
        }
        let (issue, thread) = issue_thread(&server);
        let store = server.test_internals().runtime.durable_store();
        if matches!(window.as_str(), "report" | "posted") {
            let run = until(&server, "settled reply", || {
                vibevalley_runtime::rt::block_on(server.test_internals().board.runs_async(&issue))
                    .unwrap()
                    .into_iter()
                    .find(|r| r.summary == FOLLOW_UP)
            });
            assert_eq!(run.outcome, Some(Outcome::Completed));
            let request = reply_id(&server, &thread, FOLLOW_UP);
            assert!(run.heard.contains(&request));
            let conv = format!("issue:{issue}");
            let req = request.clone();
            let sub = vibevalley_runtime::rt::block_on(store.read_async(|tx| {
                let conv = conv.clone();
                let req = req.clone();
                Box::pin(async move { tx.submission_by_request_async(&conv, &req).await })
            }))
            .unwrap()
            .unwrap();
            assert_eq!(sub.status, SubmissionStatus::Done);
            assert_eq!(sub.result["runId"], run.id);
            let run_id = run.id.clone();
            assert!(
                vibevalley_runtime::rt::block_on(store.read_async(|tx| {
                    let run_id = run_id.clone();
                    Box::pin(async move { tx.document_async("run", &run_id, "issue.report").await })
                }),)
                .unwrap()
                .is_some()
            );
            if window == "posted" {
                until(&server, "report posted before outbox acknowledgement", || {
                    (count_notes(&server, &thread, FOLLOW_UP) == 1).then_some(())
                });
                std::process::exit(84);
            }
            assert_eq!(count_notes(&server, &thread, FOLLOW_UP), 0);
            std::process::exit(82);
        }
        assert_eq!(window, "git");
        until(&server, "replayed report", || (count_notes(&server, &thread, FOLLOW_UP) == 1).then_some(()));
        comment(&url, &issue, FOLLOW_UP);
        assert_eq!(
            vibevalley_runtime::rt::block_on(server.test_internals().board.runs_async(&issue))
                .unwrap()
                .len(),
            2
        );
        comment(&url, &issue, UNKNOWN);
        until(&server, "scripted helper exits after the Git commit", || None::<()>);
    }

    let home = tempfile::tempdir().unwrap();
    crash_scenario(home.path(), "message", 81);
    let mut db = inspect_db(&home.path().join("server.db"));
    execute_sql(
        &mut db,
        "CREATE TRIGGER hold_report BEFORE INSERT ON channel_message WHEN NEW.kind='report' BEGIN SELECT RAISE(ABORT,'report delivery held'); END;",
    );
    crash_scenario(home.path(), "report", 82);
    execute_sql(
        &mut db,
        "DROP TRIGGER hold_report;
                      CREATE TRIGGER hold_ack BEFORE DELETE ON durable_document WHEN OLD.doc_kind='issue.report' BEGIN SELECT RAISE(ABORT,'ack held'); END;",
    );
    crash_scenario(home.path(), "posted", 84);
    execute_sql(&mut db, "DROP TRIGGER hold_ack");
    crash_scenario(home.path(), "git", 83);
    execute_sql(
        &mut db,
        "CREATE TRIGGER hold_recovery BEFORE INSERT ON durable_document WHEN NEW.doc_kind='workspace.reconciliation' BEGIN SELECT RAISE(ABORT,'recovery held'); END;",
    );
    let failed = create_app_blocking(Config {
        probe_runtimes: false,
        tick_crons: false,
        link_previews: false,
        orchestrator_listens: false,
        ..Config::under(home.path())
    });
    assert!(failed.err().expect("interrupted recovery should fail").to_string().contains("recovery held"));
    execute_sql(&mut db, "DROP TRIGGER hold_recovery");
    let (server, listener) = launch(home.path(), "verify");
    let (issue, thread) = issue_thread(&server);
    let url = listener.url();
    for text in [FOLLOW_UP, UNKNOWN] {
        comment(&url, &issue, text);
        reply_id(&server, &thread, text);
    }
    let runs = vibevalley_runtime::rt::block_on(server.test_internals().board.runs_async(&issue)).unwrap();
    assert_eq!(runs.len(), 3);
    assert_eq!(runs[2].outcome, Some(Outcome::Interrupted));
    let wire = call(&url, "issue.run.list", json!({"id":issue}));
    assert!(wire[0].get("needsReconciliation").is_none());
    assert!(wire[1].get("needsReconciliation").is_none());
    assert_eq!(wire[2]["needsReconciliation"], true);
    let session = call(&url, "session.get", json!({"id": runs[2].session}));
    assert_eq!(session["lastRun"]["needsReconciliation"], true);
    let bundle = crate::support::board_bundle(server.test_internals().board);
    assert!(
        bundle
            .sessions
            .sessions
            .iter()
            .find(|s| s.id == runs[2].session)
            .unwrap()
            .last_run
            .as_ref()
            .unwrap()
            .needs_reconciliation
    );

    let request = reply_id(&server, &thread, UNKNOWN);
    assert!(runs[2].heard.contains(&request));
    let conv = format!("issue:{issue}");
    let req = request.clone();
    let unknown = vibevalley_runtime::rt::block_on(server.test_internals().runtime.durable_store().read_async(|tx| {
        let conv = conv.clone();
        let req = req.clone();
        Box::pin(async move { tx.submission_by_request_async(&conv, &req).await })
    }))
    .unwrap()
    .unwrap();
    assert_eq!(unknown.status, SubmissionStatus::Unanswered);
    assert_eq!(unknown.result["runId"], runs[2].id);
    assert_eq!(count_notes(&server, &thread, FOLLOW_UP), 1);
    assert_eq!(count_notes(&server, &thread, UNKNOWN), 0);
    let history = vibevalley_runtime::rt::block_on(server.test_internals().channel.history_async(&thread, None, None)).unwrap();
    let confirmed = history.iter().find(|m| m.kind == MessageKind::Report && m.text == FOLLOW_UP).unwrap();
    assert_eq!(confirmed.spent.as_ref().map(|s| s.tokens), Some(16));
    assert!(runs[2].spent.is_none(), "interrupted before its receipt");
    let session = crate::support::board_session(server.test_internals().board, &runs[2].session).unwrap();
    let worktree = Path::new(session.cwd.as_deref().unwrap());
    assert_eq!(
        std::fs::read_to_string(worktree.join("delivery.txt")).unwrap(),
        format!("initial\n{FOLLOW_UP}\n{UNKNOWN}\n")
    );
    let git_log = git(worktree, &["log", "--format=%s", "HEAD"]);
    for summary in [FOLLOW_UP, UNKNOWN] {
        assert_eq!(git_log.lines().filter(|s| *s == summary).count(), 1);
    }
    server.close_blocking();
}
