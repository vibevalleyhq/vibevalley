use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;

use super::bash::Bash;
use super::edit::EditFile;
use super::find::Find;
use super::grep::Grep;
use super::ls::Ls;
use super::read::ReadFile;
use super::truncate::{truncate_bytes, truncate_lines};
use super::workspace::Workspace;
use super::write::WriteFile;
use super::{ReplayPolicy, Tool, ToolContext, TypedTool, TypedToolAdapter, coding_tools, read_only_tools};
use crate::ai::CancelHandle;

#[test]
fn coding_and_read_only_toolsets_expose_expected_names_and_replay_policies() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path());

    let coding = coding_tools(&ws);
    let coding_names: Vec<String> = coding.iter().map(|t| t.spec().name).collect();
    assert_eq!(coding_names, vec!["read", "write", "edit", "bash", "grep", "find", "ls"]);
    let coding_safe: Vec<bool> = coding.iter().map(|t| t.replay_safe()).collect();
    assert_eq!(coding_safe, vec![true, false, false, false, true, true, true]);

    let ro = read_only_tools(&ws);
    let ro_names: Vec<String> = ro.iter().map(|t| t.spec().name).collect();
    assert_eq!(ro_names, vec!["read", "grep", "find", "ls"]);
    assert!(ro.iter().all(|t| t.replay_safe()));
}

#[test]
fn typed_tool_adapter_generates_json_schema_and_rejects_bad_args() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path());
    let adapter = TypedToolAdapter(ReadFile(ws));
    let spec = adapter.spec();
    assert_eq!(spec.name, "read");
    assert_eq!(spec.parameters["type"], "object");
    assert!(spec.parameters["properties"].get("path").is_some());
    assert!(spec.parameters["properties"].get("offset").is_some());
    assert!(spec.parameters["properties"].get("limit").is_some());
    assert_eq!(spec.parameters["required"], json!(["path"]));

    let missing_path = adapter.execute(&json!({}));
    assert!(missing_path.is_error);
    assert!(missing_path.text.contains("invalid arguments for `read`"), "{}", missing_path.text);

    let bad_offset = adapter.execute(&json!({"path": "a.txt", "offset": "not_a_number"}));
    assert!(bad_offset.is_error);
    assert!(bad_offset.text.contains("invalid arguments for `read`"), "{}", bad_offset.text);
}

#[test]
fn truncate_lines_and_bytes_report_totals_and_continuation_hints() {
    let lines: String = (1..=10).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
    let tl = truncate_lines(&lines, 4);
    assert!(tl.truncated);
    assert_eq!(tl.shown_lines, 4);
    assert_eq!(tl.total_lines, 10);
    assert!(tl.text.contains("showing lines 1..4 of 10"), "{}", tl.text);
    assert!(tl.text.contains("pass offset=5 to continue"), "{}", tl.text);
    assert!(!truncate_lines(&lines, 10).truncated);

    // Multi-byte UTF-8 characters must never split mid-codepoint.
    let utf8_text = "第一行测试内容\n第二行测试内容\n第三行测试内容";
    let tb = truncate_bytes(utf8_text, 24);
    assert!(tb.truncated);
    assert_eq!(tb.total_bytes, utf8_text.len());
    assert_eq!(tb.total_lines, 3);
    assert!(tb.text.contains("of 3"), "{}", tb.text);
    assert!(!truncate_bytes(utf8_text, 1000).truncated);
}

#[test]
fn read_reports_total_lines_slice_and_continuation_hint() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path());
    let content: String = (1..=25).map(|i| format!("row {i}\n")).collect();
    std::fs::write(dir.path().join("many.txt"), content).unwrap();
    std::fs::write(dir.path().join("empty.txt"), "").unwrap();

    let tool = ReadFile(ws);
    assert_eq!(tool.replay(), ReplayPolicy::Safe);
    let ctx = ToolContext::background();

    let first = tool
        .execute(
            super::read::ReadArgs {
                path: "many.txt".into(),
                offset: Some(1),
                limit: Some(5),
            },
            &ctx,
        )
        .unwrap();
    assert!(first.text.contains("     1\trow 1\n"));
    assert!(first.text.contains("     5\trow 5\n"));
    assert!(!first.text.contains("row 6"));
    assert!(first.text.contains("showing lines 1..5 of 25; pass offset=6 to continue"), "{}", first.text);
    let details = first.details.unwrap();
    assert_eq!((details.total_lines, details.start_line, details.end_line, details.truncated), (25, 1, 5, true));

    let tail = tool
        .execute(
            super::read::ReadArgs {
                path: "many.txt".into(),
                offset: Some(21),
                limit: Some(10),
            },
            &ctx,
        )
        .unwrap();
    assert!(tail.text.contains("    25\trow 25\n"));
    assert!(tail.text.contains("showing lines 21..25 of 25"));
    assert!(!tail.text.contains("pass offset="));
    assert!(!tail.details.unwrap().truncated);

    let empty = tool
        .execute(
            super::read::ReadArgs {
                path: "empty.txt".into(),
                offset: None,
                limit: None,
            },
            &ctx,
        )
        .unwrap();
    assert_eq!(empty.text, "(empty file, 0 lines)");

    let past_eof = tool.execute(
        super::read::ReadArgs {
            path: "many.txt".into(),
            offset: Some(26),
            limit: None,
        },
        &ctx,
    );
    assert!(past_eof.unwrap_err().contains("25 lines total"));
}

#[test]
fn write_creates_parent_directories() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path());
    let tool = TypedToolAdapter(WriteFile(ws));
    assert!(!tool.replay_safe());

    let out = tool.execute(&json!({
        "path": "nested/deep/file.txt",
        "content": "hello\nworld\n"
    }));
    assert!(!out.is_error, "{}", out.text);
    assert_eq!(std::fs::read_to_string(dir.path().join("nested/deep/file.txt")).unwrap(), "hello\nworld\n");
}

#[test]
fn edit_enforces_uniqueness_and_supports_replace_all() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path());
    std::fs::write(dir.path().join("f.txt"), "foo bar foo baz").unwrap();

    let tool = TypedToolAdapter(EditFile(ws));
    assert!(!tool.replay_safe());

    let missing = tool.execute(&json!({"path": "f.txt", "old_text": "nope", "new_text": "x"}));
    assert!(missing.is_error && missing.text.contains("not found"));

    let ambiguous = tool.execute(&json!({"path": "f.txt", "old_text": "foo", "new_text": "qux"}));
    assert!(ambiguous.is_error && ambiguous.text.contains("2 times"));

    let unique = tool.execute(&json!({"path": "f.txt", "old_text": "bar", "new_text": "BAR"}));
    assert!(!unique.is_error, "{}", unique.text);
    assert_eq!(std::fs::read_to_string(dir.path().join("f.txt")).unwrap(), "foo BAR foo baz");

    let all = tool.execute(&json!({
        "path": "f.txt",
        "old_text": "foo",
        "new_text": "qux",
        "replace_all": true
    }));
    assert!(!all.is_error, "{}", all.text);
    assert!(all.text.contains("2 replacement(s)"), "{}", all.text);
    assert_eq!(std::fs::read_to_string(dir.path().join("f.txt")).unwrap(), "qux BAR qux baz");
}

#[test]
fn bash_streams_updates_respects_timeout_and_cancels_mid_run_under_500ms() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace {
        bash_timeout: Duration::from_millis(300),
        ..Workspace::new(dir.path())
    };
    let tool = TypedToolAdapter(Bash(ws.clone()));
    assert!(!tool.replay_safe());

    let updates = Arc::new(Mutex::new(Vec::new()));
    let updates_ref = updates.clone();
    let mut ctx = ToolContext::background();
    ctx.on_update = Some(Arc::new(move |u| {
        updates_ref.lock().unwrap().push(u.text);
    }));

    let ok = tool.execute_with_context(&json!({"command": "echo hi; sleep 0.05; echo err >&2"}), &ctx);
    assert!(!ok.is_error, "{}", ok.text);
    assert_eq!(ok.text, "hi\nerr\n");
    let streamed = updates.lock().unwrap().concat();
    assert_eq!(streamed, "hi\nerr\n");

    let fail = tool.execute(&json!({"command": "exit 3"}));
    assert!(fail.is_error && fail.text.contains("exit status 3"), "{}", fail.text);

    let slow = tool.execute(&json!({"command": "sleep 5"}));
    assert!(slow.is_error && slow.text.contains("timed out"), "{}", slow.text);

    let cancel_ws = Workspace {
        bash_timeout: Duration::from_secs(30),
        ..Workspace::new(dir.path())
    };
    let cancel_tool = TypedToolAdapter(Bash(cancel_ws));
    let handle = CancelHandle::new();
    let cancel_ctx = ToolContext::with_cancel(handle.token());

    let cancel_at = std::thread::scope(|scope| {
        let running = scope.spawn(|| cancel_tool.execute_with_context(&json!({"command": "sleep 30"}), &cancel_ctx));
        std::thread::sleep(Duration::from_millis(50));
        let started = Instant::now();
        handle.cancel();
        let out = running.join().unwrap();
        let elapsed = started.elapsed();
        assert!(out.is_error, "{out:?}");
        assert_eq!(out.text, "aborted by the user");
        elapsed
    });
    assert!(cancel_at < Duration::from_millis(500), "cancel took {cancel_at:?}");
}

#[test]
fn grep_respects_gitignore_glob_case_insensitive_and_cancel() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::create_dir_all(root.join("ignored")).unwrap();
    std::fs::write(root.join(".gitignore"), "ignored/\n*.log\n").unwrap();
    std::fs::write(root.join("src/main.rs"), "fn main() {\n    println!(\"Needle\");\n}\n").unwrap();
    std::fs::write(root.join("src/lib.rs"), "pub fn needle_two() {}\n").unwrap();
    std::fs::write(root.join("README.md"), "needle in readme\n").unwrap();
    std::fs::write(root.join("ignored/secret.rs"), "needle in ignored\n").unwrap();
    std::fs::write(root.join("app.log"), "needle in log\n").unwrap();
    std::fs::write(root.join("bin.dat"), b"\0\0needle\0\0").unwrap();

    let tool = TypedToolAdapter(Grep(Workspace::new(root)));
    assert!(tool.replay_safe());

    let rs_only = tool.execute(&json!({
        "pattern": "needle",
        "glob": "*.rs",
        "case_insensitive": true
    }));
    assert!(!rs_only.is_error, "{}", rs_only.text);
    assert!(rs_only.text.contains("src/main.rs:2:"), "{}", rs_only.text);
    assert!(rs_only.text.contains("src/lib.rs:1:"), "{}", rs_only.text);
    assert!(!rs_only.text.contains("README.md"), "{}", rs_only.text);
    assert!(!rs_only.text.contains("ignored"), "{}", rs_only.text);
    assert!(!rs_only.text.contains("app.log"), "{}", rs_only.text);
    assert!(!rs_only.text.contains("bin.dat"), "{}", rs_only.text);

    let limited = tool.execute(&json!({"pattern": "needle", "case_insensitive": true, "max_results": 1}));
    assert!(!limited.is_error);
    assert!(limited.text.contains("truncated at 1 matches"), "{}", limited.text);

    let none = tool.execute(&json!({"pattern": "definitely_missing_token"}));
    assert!(!none.is_error);
    assert_eq!(none.text, "no matches found");

    let handle = CancelHandle::new();
    handle.cancel();
    let cancelled = tool.execute_with_context(&json!({"pattern": "needle"}), &ToolContext::with_cancel(handle.token()));
    assert!(cancelled.is_error && cancelled.text.contains("aborted by the user"));
}

#[test]
fn find_respects_gitignore_glob_and_cancel() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("src/nested")).unwrap();
    std::fs::create_dir_all(root.join("target")).unwrap();
    std::fs::write(root.join(".gitignore"), "target/\n").unwrap();
    std::fs::write(root.join("src/lib.rs"), "").unwrap();
    std::fs::write(root.join("src/nested/mod.rs"), "").unwrap();
    std::fs::write(root.join("README.md"), "").unwrap();
    std::fs::write(root.join("target/out.rs"), "").unwrap();

    let tool = TypedToolAdapter(Find(Workspace::new(root)));
    assert!(tool.replay_safe());

    let out = tool.execute(&json!({"pattern": "*.rs"}));
    assert!(!out.is_error, "{}", out.text);
    assert!(out.text.contains("src/lib.rs"), "{}", out.text);
    assert!(out.text.contains("src/nested/mod.rs"), "{}", out.text);
    assert!(!out.text.contains("README.md"), "{}", out.text);
    assert!(!out.text.contains("target/out.rs"), "{}", out.text);

    let capped = tool.execute(&json!({"pattern": "*.rs", "max_results": 1}));
    assert!(capped.text.contains("truncated at 1 files"), "{}", capped.text);

    let handle = CancelHandle::new();
    handle.cancel();
    let cancelled = tool.execute_with_context(&json!({"pattern": "*.rs"}), &ToolContext::with_cancel(handle.token()));
    assert!(cancelled.is_error && cancelled.text.contains("aborted by the user"));
}

#[test]
fn ls_lists_sorted_entries_with_kinds_and_sizes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("zeta")).unwrap();
    std::fs::create_dir_all(root.join("alpha")).unwrap();
    std::fs::create_dir_all(root.join("empty_dir")).unwrap();
    std::fs::write(root.join("b.txt"), "12345").unwrap();
    std::fs::write(root.join("A.txt"), "hi").unwrap();
    std::os::unix::fs::symlink(root.join("b.txt"), root.join("link")).unwrap();

    let tool = TypedToolAdapter(Ls(Workspace::new(root)));
    assert!(tool.replay_safe());

    let out = tool.execute(&json!({}));
    assert!(!out.is_error, "{}", out.text);
    let lines: Vec<&str> = out.text.lines().collect();
    assert_eq!(
        lines,
        vec![
            "alpha/ (dir)",
            "empty_dir/ (dir)",
            "zeta/ (dir)",
            "A.txt (2 bytes)",
            "b.txt (5 bytes)",
            "link@ (symlink)",
        ]
    );

    let capped = tool.execute(&json!({"max_entries": 2}));
    assert!(capped.text.contains("showing 2 of 6 entries"), "{}", capped.text);

    let empty = tool.execute(&json!({"path": "empty_dir"}));
    assert!(!empty.is_error);
    assert_eq!(empty.text, "(empty directory)");
}
