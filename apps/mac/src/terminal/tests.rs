use std::time::{Duration, Instant};

use gpui::{point, px};
use vibevalley_terminal::{TermEvent, TermSize};

use super::status::{AgentTurnTracker, classify_busy_label, classify_terminal_status, coalesce_term_events, detect_agent_token, detect_inline_agent};
use super::{Geometry, RunningState, TerminalStatus};

#[test]
fn geometry_cell_at_exact_rejects_padding_and_out_of_bounds() {
    let g = Geometry {
        origin: point(px(6.0), px(6.0)),
        cell_width: px(8.0),
        line_height: px(16.0),
        size: TermSize {
            cols: 10,
            rows: 4,
            cell_width_px: 8,
            cell_height_px: 16,
        },
    };
    assert_eq!(g.cell_at_exact(point(px(2.0), px(10.0))), None);
    assert_eq!(g.cell_at_exact(point(px(10.0), px(2.0))), None);
    assert_eq!(g.cell_at_exact(point(px(6.0), px(6.0))), Some(vibevalley_terminal::Point { row: 0, col: 0 }));
    assert_eq!(g.cell_at_exact(point(px(85.0), px(69.0))), Some(vibevalley_terminal::Point { row: 3, col: 9 }));
    assert_eq!(g.cell_at_exact(point(px(86.0), px(69.0))), None);
    assert_eq!(g.cell_at_exact(point(px(85.0), px(70.0))), None);
}

#[test]
fn detects_known_agent_tokens() {
    assert_eq!(detect_agent_token("antigravity"), Some("antigravity"));
    assert_eq!(detect_agent_token("agy --resume"), Some("antigravity"));
    assert_eq!(detect_agent_token("/usr/local/bin/agy"), Some("antigravity"));
    assert_eq!(detect_agent_token("Antigravity CLI"), Some("antigravity"));
    assert_eq!(detect_agent_token("claude --dangerously-skip-permissions"), Some("claude"));
    assert_eq!(detect_agent_token("codex"), Some("codex"));
    assert_eq!(detect_agent_token("opencode"), Some("opencode"));
    assert_eq!(detect_agent_token("cursor-agent"), Some("cursor"));
    assert_eq!(detect_agent_token("kimi"), Some("kimi"));
    assert_eq!(detect_agent_token("pi"), Some("pi"));
    assert_eq!(detect_agent_token("dsh"), None);
    assert_eq!(detect_agent_token("grok"), Some("grok"));
    assert_eq!(detect_agent_token("zsh"), None);
    assert_eq!(detect_agent_token("cargo test -p vibevalley-mac"), None);
}

#[test]
fn detects_inline_agents_from_screen_lines() {
    assert_eq!(detect_inline_agent(&["welcome to antigravity".into()]), Some("antigravity"));
    assert_eq!(detect_inline_agent(&["~/repo % agy".into()]), Some("antigravity"));
    assert_eq!(detect_inline_agent(&["❯ pi --model fast".into()]), Some("pi"));
    assert_eq!(detect_inline_agent(&["$ dsh".into()]), None);
    assert_eq!(detect_inline_agent(&["➜ grok".into()]), Some("grok"));
    assert_eq!(detect_inline_agent(&["openai codex v0.1".into()]), Some("codex"));
    assert_eq!(detect_inline_agent(&["claude code".into()]), Some("claude"));
    assert_eq!(detect_inline_agent(&["pip install foo".into()]), None);
}

#[test]
fn classifies_working_ready_and_idle_states() {
    let working_agy = classify_terminal_status(false, Some("agy"), None, None, false, &[], &[], false, true);
    assert_eq!(working_agy.state, RunningState::Working);
    assert_eq!(working_agy.agent.as_deref(), Some("antigravity"));

    let ready_agy = classify_terminal_status(false, Some("agy"), None, None, false, &[], &[], false, false);
    assert_eq!(ready_agy.state, RunningState::Ready);
    assert_eq!(ready_agy.agent.as_deref(), Some("antigravity"));

    let compiling = classify_terminal_status(false, Some("cargo test"), None, None, false, &[], &[], false, false);
    assert_eq!(compiling.state, RunningState::Working);
    assert_eq!(compiling.agent.as_deref(), Some("cmd"));
    assert_eq!(compiling.label.as_deref(), Some("cargo"));

    let idle_alt_agy = classify_terminal_status(false, None, None, None, true, &["Antigravity".into()], &[], false, false);
    assert_eq!(idle_alt_agy.state, RunningState::Ready);
    assert_eq!(idle_alt_agy.agent.as_deref(), Some("antigravity"));

    let idle_shell = classify_terminal_status(false, None, None, Some("zsh"), false, &[], &["~/repo %".into()], true, false);
    assert_eq!(idle_shell, TerminalStatus::idle());

    let exited_agy = classify_terminal_status(true, Some("agy"), None, None, false, &[], &[], false, true);
    assert_eq!(exited_agy, TerminalStatus::idle());
}

#[test]
fn agent_turn_tracker_notifies_once_per_turn_and_ignores_typing_echo() {
    let working_claude = TerminalStatus {
        state: RunningState::Working,
        agent: Some("claude".into()),
        label: Some("claude".into()),
    };
    let ready_claude = TerminalStatus {
        state: RunningState::Ready,
        agent: Some("claude".into()),
        label: Some("claude".into()),
    };
    let working_cmd = TerminalStatus {
        state: RunningState::Working,
        agent: Some("cmd".into()),
        label: Some("cargo".into()),
    };
    let ready_cmd = TerminalStatus {
        state: RunningState::Ready,
        agent: Some("cmd".into()),
        label: Some("cargo".into()),
    };

    let mut tracker = AgentTurnTracker::default();
    let t0 = Instant::now();

    // Typing without submitting only produces local echo within KEYSTROKE_ECHO_WINDOW.
    tracker.on_input(false, t0);
    tracker.on_output(&working_claude, t0 + Duration::from_millis(50));
    assert_eq!(tracker.on_settled(&working_claude, &ready_claude), None);

    // Submitting a prompt and settling after output notifies once.
    tracker.on_input(true, t0 + Duration::from_secs(1));
    tracker.on_output(&working_claude, t0 + Duration::from_secs(2));
    assert_eq!(tracker.on_settled(&working_claude, &ready_claude), Some(("claude".into(), "claude".into())));
    // Duplicate settle without a new turn does not notify again.
    assert_eq!(tracker.on_settled(&working_claude, &ready_claude), None);

    // Next turn emits Bell early; subsequent settle must not double-notify.
    tracker.on_input(true, t0 + Duration::from_secs(10));
    tracker.on_output(&working_claude, t0 + Duration::from_secs(11));
    assert_eq!(tracker.on_bell(&working_claude), Some(("claude".into(), "claude".into())));
    assert_eq!(tracker.on_settled(&working_claude, &ready_claude), None);

    // Plain commands are not coding agents and never trigger agent turn notifications.
    tracker.on_input(true, t0 + Duration::from_secs(20));
    tracker.on_output(&working_cmd, t0 + Duration::from_secs(21));
    assert_eq!(tracker.on_settled(&working_cmd, &ready_cmd), None);
}

#[test]
fn coalesce_term_events_collapses_dirty_bursts_and_preserves_semantic_events() {
    let coalesced = coalesce_term_events(vec![
        TermEvent::Dirty,
        TermEvent::Dirty,
        TermEvent::TitleChanged("build".into()),
        TermEvent::Dirty,
        TermEvent::Bell,
        TermEvent::Dirty,
    ]);
    assert_eq!(coalesced.len(), 3);
    assert!(matches!(&coalesced[0], TermEvent::TitleChanged(title) if title == "build"));
    assert!(matches!(&coalesced[1], TermEvent::Bell));
    assert!(matches!(&coalesced[2], TermEvent::Dirty));

    let semantic_only = coalesce_term_events(vec![TermEvent::Bell]);
    assert_eq!(semantic_only.len(), 1);
    assert!(matches!(&semantic_only[0], TermEvent::Bell));
}

#[test]
fn classify_busy_label_distinguishes_idle_running_agent_and_exited() {
    let idle = TerminalStatus::idle();
    assert_eq!(classify_busy_label(true, false, None, &idle, Some("zsh"), "zsh"), None);

    let cmd = TerminalStatus {
        state: RunningState::Working,
        agent: Some("cmd".into()),
        label: Some("cargo".into()),
    };
    assert_eq!(
        classify_busy_label(true, true, Some("cargo test"), &cmd, Some("cargo"), "zsh"),
        Some("cargo test".into())
    );

    let agent = TerminalStatus {
        state: RunningState::Ready,
        agent: Some("antigravity".into()),
        label: Some("antigravity".into()),
    };
    assert_eq!(
        classify_busy_label(true, true, Some("agy"), &agent, Some("✳ Fix bug"), "zsh"),
        Some("Antigravity".into())
    );

    // Foreground process without OSC 133 preexec falls back to custom OSC title or shell name.
    assert_eq!(classify_busy_label(true, true, None, &idle, Some("zsh"), "zsh"), Some("zsh".into()));
    assert_eq!(
        classify_busy_label(true, true, None, &idle, Some("vim notes.md"), "zsh"),
        Some("vim notes.md".into())
    );

    // Exited terminals are never busy regardless of stale command/status fields.
    assert_eq!(classify_busy_label(false, true, Some("cargo test"), &cmd, Some("cargo"), "zsh"), None);
    assert_eq!(classify_busy_label(false, false, Some("agy"), &agent, None, "zsh"), None);
}
