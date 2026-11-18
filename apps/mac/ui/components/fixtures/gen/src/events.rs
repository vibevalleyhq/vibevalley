//! Agent event streams for the agent views, built from `vibevalley_oar`'
//! own types so the serde shape is the real one. Content follows the
//! captured traces in `crates/vibevalley-oar/tests/fixtures/` (Claude's
//! `Write` of hello.txt, Codex's `commandExecution` with its approval,
//! opencode's quota error), stretched into a longer, realistic run.

use vibevalley_oar::{Event, EventKind, FileChangeKind, PermissionDecision, StopReason, Usage};
use serde_json::json;

pub struct Stream {
    at: u64,
    seq: u64,
    pub events: Vec<Event>,
}

impl Stream {
    pub fn new(at: u64) -> Stream {
        Stream { at, seq: 0, events: Vec::new() }
    }

    /// Adds `kind` `after` milliseconds after the previous event.
    pub fn push(&mut self, after: u64, kind: EventKind) -> &mut Stream {
        self.at += after;
        self.seq += 1;
        self.events.push(Event { seq: self.seq, agent_path: Vec::new(), at_ms: self.at, kind });
        self
    }
}

fn started(id: &str, name: &str, input: serde_json::Value) -> EventKind {
    EventKind::ToolCallStarted { id: id.into(), name: name.into(), input }
}

fn finished(id: &str, ok: bool, output: &str) -> EventKind {
    EventKind::ToolCallFinished { id: id.into(), ok, output: output.into() }
}

const TEST_OUT: &str = "running 14 tests
test hosted::tests::frame_round_trip ... ok
test hosted::tests::applied_rev_is_recorded ... ok
test terminal::tests::resize_keeps_cursor ... FAILED
test terminal::tests::scrollback_survives_resize ... ok
test terminal::tests::selection_survives_relayout ... ok
test terminal::tests::wide_chars_take_two_cells ... ok
test theme::tests::tokens_match_ui ... ok
test theme::tests::dark_ring_has_no_drop ... ok
test layout::tests::split_ratio_is_kept ... ok
test layout::tests::focus_returns_to_last_terminal ... ok
test layout::tests::closing_last_pane_keeps_project ... ok
test files::tests::preview_is_read_only ... ok
test files::tests::ignored_dirs_are_listed ... ok
test git::tests::status_parses_renames ... ok

failures:

---- terminal::tests::resize_keeps_cursor stdout ----
thread 'terminal::tests::resize_keeps_cursor' panicked at apps/mac/src/terminal/mod.rs:412:9:
assertion `left == right` failed: cursor row after resize
  left: 23
 right: 24

failures:
    terminal::tests::resize_keeps_cursor

test result: FAILED. 13 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.84s";

/// A Claude Code turn: reads, searches, a failing test, an edit, a
/// permission ask, a passing test.
pub fn claude_run(t0: u64) -> Vec<Event> {
    let mut s = Stream::new(t0);
    s.push(0, EventKind::SessionStarted { session_id: "84096e9b-a517-4261-815d-c275a69c35cf".into(), model: Some("claude-fable-5-2".into()) })
        .push(40, EventKind::TurnStarted { prompt: "Fix the resize jitter in the terminal pane: the cursor row must stay put when the window is resized.".into() })
        .push(900, EventKind::ThinkingDelta { text: "The cursor row is computed before the PTY sees SIGWINCH. Look at how resize is ordered.".into() })
        .push(1300, started("toolu_01", "Read", json!({ "file_path": "apps/mac/src/terminal/mod.rs" })))
        .push(180, finished("toolu_01", true, "   400\t    fn resize(&mut self, cols: u16, rows: u16) {\n   401\t        self.grid.resize(cols, rows);\n   402\t        self.pty.resize(cols, rows);\n   403\t    }"))
        .push(600, started("toolu_02", "Grep", json!({ "pattern": "fn resize", "path": "crates", "output_mode": "files_with_matches" })))
        .push(240, finished("toolu_02", true, "crates/vibevalley-terminal/src/lib.rs\napps/mac/src/terminal/mod.rs"))
        .push(700, started("toolu_03", "Bash", json!({ "command": "cargo test -p vibevalley-mac terminal", "description": "Run the terminal tests" })))
        .push(8400, finished("toolu_03", false, TEST_OUT))
        .push(500, EventKind::TextDelta { text: "The test confirms it: the grid resizes before the PTY. Swapping the order.".into() })
        .push(900, started("toolu_04", "Edit", json!({
            "file_path": "apps/mac/src/terminal/mod.rs",
            "old_string": "        self.grid.resize(cols, rows);\n        self.pty.resize(cols, rows);",
            "new_string": "        self.pty.resize(cols, rows);\n        self.grid.resize(cols, rows);"
        })))
        .push(120, finished("toolu_04", true, "The file apps/mac/src/terminal/mod.rs has been updated."))
        .push(5, EventKind::FileChanged { path: "apps/mac/src/terminal/mod.rs".into(), change: FileChangeKind::Modified })
        .push(400, EventKind::PermissionRequested {
            request_id: "perm-1".into(),
            tool: "Bash".into(),
            input: json!({ "command": "rm -rf target-app/debug/incremental", "description": "Clear stale incremental cache" }),
            summary: "Run: rm -rf target-app/debug/incremental".into(),
        })
        .push(3200, EventKind::PermissionResolved { request_id: "perm-1".into(), decision: PermissionDecision::AllowOnce })
        .push(10, started("toolu_05", "Bash", json!({ "command": "rm -rf target-app/debug/incremental" })))
        .push(300, finished("toolu_05", true, ""))
        .push(200, started("toolu_06", "Bash", json!({ "command": "cargo test -p vibevalley-mac terminal" })))
        .push(9100, finished("toolu_06", true, &TEST_OUT.replace("resize_keeps_cursor ... FAILED", "resize_keeps_cursor ... ok").split("\n\nfailures:").next().unwrap_or("").to_string()))
        .push(600, EventKind::TextDelta { text: "Fixed: the PTY now resizes before the grid, so the cursor row stays put. All 14 terminal tests pass.".into() })
        .push(50, EventKind::TurnFinished { reason: StopReason::Completed, usage: Usage { input_tokens: Some(48_210), output_tokens: Some(1_934), cost_usd: Some(0.214) } });
    s.events
}

/// The captured Codex trace: one command that asks for approval first.
pub fn codex_run(t0: u64) -> Vec<Event> {
    let mut s = Stream::new(t0);
    let command = "/bin/zsh -lc 'printf ok > hello.txt'";
    s.push(0, EventKind::SessionStarted { session_id: "01a1d082-8706-7b31-9604-c5317914845a".into(), model: Some("gpt-5.5-codex".into()) })
        .push(30, EventKind::TurnStarted { prompt: "Create a file named hello.txt containing the single word ok, then reply with the single word done.".into() })
        .push(3075, EventKind::TextDelta { text: "I’ll create hello.txt with the requested content.\n".into() })
        .push(634, EventKind::PermissionRequested {
            request_id: "0".into(),
            tool: "commandExecution".into(),
            input: json!({ "command": command, "cwd": "/tmp/tmp.S2NNjqYT1L" }),
            summary: format!("Run: {command}"),
        })
        .push(1, started("exec-0893a359-78ec-4c82-99f1-d7c3f8d34154", "commandExecution", json!({ "command": command, "cwd": "/tmp/tmp.S2NNjqYT1L" })))
        .push(2400, EventKind::PermissionResolved { request_id: "0".into(), decision: PermissionDecision::AllowOnce })
        .push(2800, finished("exec-0893a359-78ec-4c82-99f1-d7c3f8d34154", true, "completed"))
        .push(5, EventKind::FileChanged { path: "/tmp/tmp.S2NNjqYT1L/hello.txt".into(), change: FileChangeKind::Created })
        .push(100, EventKind::TextDelta { text: "done".into() })
        .push(10, EventKind::TurnFinished { reason: StopReason::Completed, usage: Usage { input_tokens: Some(38_590), output_tokens: Some(52), cost_usd: None } });
    s.events
}

/// The captured opencode trace: the prompt fails on the provider's quota.
pub fn error_run(t0: u64) -> Vec<Event> {
    let mut s = Stream::new(t0);
    s.push(0, EventKind::SessionStarted { session_id: "ses_e2efdf212ffeKagrujdaRA8SH0".into(), model: Some("opencode/gemini-4-carbon".into()) })
        .push(20, EventKind::TurnStarted { prompt: "Reply with the single word ok".into() })
        .push(640, EventKind::Error { message: "Internal error: Insufficient balance. Top up at https://opencode.ai/console/org_REDACTED/billing?credits=1.".into() })
        .push(2, EventKind::TurnFinished { reason: StopReason::Error, usage: Usage::default() });
    s.events
}

/// Long text in both languages: a 200-character summary, a long output,
/// and a permission whose command is long.
pub fn long_run(t0: u64, long_en: &str, long_zh: &str) -> Vec<Event> {
    let mut s = Stream::new(t0);
    let many: String = (1..=120).map(|i| format!("{i:>4}  第 {i} 行：渲染终端网格时每个字形都要对齐到像素边界 / glyph {i} snapped to the pixel grid\n")).collect();
    s.push(0, EventKind::SessionStarted { session_id: "long".into(), model: Some("claude-fable-5-2".into()) })
        .push(10, EventKind::TurnStarted { prompt: long_zh.into() })
        .push(800, EventKind::ThinkingDelta { text: long_en.into() })
        .push(900, started("toolu_l1", "mcp:nowledge-mem/search_memories", json!({ "query": long_zh, "limit": 5 })))
        .push(1500, finished("toolu_l1", true, &many))
        .push(300, started("toolu_l2", "WebFetch", json!({ "url": "https://nsh.dev/docs/gpui", "prompt": long_en })))
        .push(4000, finished("toolu_l2", false, long_zh))
        .push(200, EventKind::PermissionRequested {
            request_id: "perm-long".into(),
            tool: "Bash".into(),
            input: json!({ "command": format!("git commit -m \"{long_en}\"") }),
            summary: format!("Run: git commit -m \"{long_zh}\""),
        });
    s.events
}
