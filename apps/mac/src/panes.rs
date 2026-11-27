//! Pane entity variants, titlebar geometry constants, and terminal display title
//! resolution. Shell layout rendering lives in `crate::shell::pane_layout`.

use gpui::{AnyElement, App, Entity, FocusHandle, Focusable, IntoElement};

use crate::diff::DiffView;
use crate::diorama::DioramaView;
use crate::host_types::{is_default_title, shell_name};
use crate::hosted::HostedView;
use crate::markdown_pane::MarkdownView;
use crate::viewer::FileViewer;

pub(crate) const TITLEBAR_HEIGHT: f32 = 36.0;
pub(crate) const WINDOW_DRAG_SLOP: f32 = 3.0;

pub(crate) fn is_titlebar_hit(y: f32) -> bool {
    (0.0..TITLEBAR_HEIGHT).contains(&y)
}

pub(crate) fn exceeded_window_drag_slop(origin: (f32, f32), current: (f32, f32)) -> bool {
    (current.0 - origin.0).abs() > WINDOW_DRAG_SLOP || (current.1 - origin.1).abs() > WINDOW_DRAG_SLOP
}

#[derive(Clone)]
pub enum PaneEntity {
    File(Entity<FileViewer>),
    Markdown(Entity<MarkdownView>),
    Diff(Entity<DiffView>),
    Hosted(Entity<HostedView>),
    Diorama(Entity<DioramaView>),
}

impl PaneEntity {
    pub fn focus_handle(&self, cx: &App) -> FocusHandle {
        match self {
            PaneEntity::File(v) => v.read(cx).focus_handle(cx),
            PaneEntity::Markdown(v) => v.read(cx).focus_handle(cx),
            PaneEntity::Diff(v) => v.read(cx).focus_handle(cx),
            PaneEntity::Hosted(view) => view.read(cx).focus_handle(cx),
            PaneEntity::Diorama(v) => v.read(cx).focus_handle(cx),
        }
    }

    pub(crate) fn element(&self) -> AnyElement {
        match self {
            PaneEntity::File(v) => v.clone().into_any_element(),
            PaneEntity::Markdown(v) => v.clone().into_any_element(),
            PaneEntity::Diff(v) => v.clone().into_any_element(),
            PaneEntity::Hosted(view) => view.clone().into_any_element(),
            PaneEntity::Diorama(v) => v.clone().into_any_element(),
        }
    }
}

/// Resolves a terminal tab's display title: link titles win, then cleaned OSC
/// session titles (stripping spinners, command echoes, and redundant agent
/// prefixes), then canonical agent names for coding agents, else the shell name.
pub fn terminal_name(t: &crate::terminal::TerminalView) -> String {
    let status = t.terminal_status();
    resolve_terminal_name(t.link_title(), t.osc_title(), t.running_command(), &status, &shell_name())
}

pub(crate) fn resolve_terminal_name(
    link_title: Option<&str>,
    osc_title: Option<&str>,
    running_command: Option<&str>,
    status: &crate::terminal::TerminalStatus,
    fallback_shell: &str,
) -> String {
    if let Some(title) = link_title.map(str::trim).filter(|s| !s.is_empty() && !is_default_title(s)) {
        return title.to_owned();
    }
    if let Some(raw) = osc_title
        && let Some(cleaned) = clean_osc_session_title(raw, status.agent.as_deref(), running_command)
    {
        return cleaned;
    }
    if status.is_coding_agent()
        && let Some(agent) = status.agent.as_deref()
    {
        return crate::terminal::agent_display_name(agent, status.label.as_deref().unwrap_or(agent));
    }
    fallback_shell.to_owned()
}

fn is_spinner_or_status_glyph(c: char) -> bool {
    matches!(
        c,
        '\u{2800}'
            ..='\u{28FF}'
                | '\u{FE0F}'
                | '✳'
                | '✱'
                | '✽'
                | '✻'
                | '✶'
                | '✦'
                | '✧'
                | '●'
                | '○'
                | '◉'
                | '◌'
                | '◐'
                | '◑'
                | '◒'
                | '◓'
                | '▪'
                | '▫'
                | '▸'
                | '▹'
                | '›'
                | '⏳'
                | '⌛'
                | '⚡'
                | '✨'
                | '🤖'
                | '🟢'
                | '🟡'
                | '🔴'
                | '🔵'
                | '🟠'
                | '⚪'
                | '🟣'
                | '✓'
                | '✔'
                | '✗'
                | '✘'
    )
}

fn strip_leading_glyphs(mut s: &str) -> &str {
    loop {
        let trimmed = s.trim_start();
        let Some(c) = trimmed.chars().next() else {
            return "";
        };
        if is_spinner_or_status_glyph(c) {
            s = &trimmed[c.len_utf8()..];
        } else {
            return trimmed.trim_end();
        }
    }
}

fn starts_with_ci<'a>(haystack: &'a str, needle: &str) -> Option<&'a str> {
    if haystack.len() < needle.len() || !haystack.is_char_boundary(needle.len()) {
        return None;
    }
    let (head, tail) = haystack.split_at(needle.len());
    head.eq_ignore_ascii_case(needle).then_some(tail)
}

fn is_command_echo(cleaned: &str, running_command: Option<&str>) -> bool {
    let Some(cmd) = running_command.map(str::trim).filter(|c| !c.is_empty()) else {
        return false;
    };
    if cleaned.eq_ignore_ascii_case(cmd) {
        return true;
    }
    let Some(first_tok) = crate::terminal::first_command_token(cmd) else {
        return false;
    };
    if cleaned.eq_ignore_ascii_case(first_tok) {
        return true;
    }
    let starts_with_tok = starts_with_ci(cleaned, first_tok).is_some_and(|rest| rest.is_empty() || rest.starts_with(char::is_whitespace));
    if !starts_with_tok {
        return false;
    }
    if starts_with_ci(cmd, cleaned).is_some() {
        return true;
    }
    // Also catch commands prefixed by `env`/`sudo`/env assignments (e.g. `RUST_LOG=info cargo test`).
    cmd.find(first_tok).is_some_and(|idx| starts_with_ci(&cmd[idx..], cleaned).is_some())
}

fn strip_agent_prefix(text: &str) -> &str {
    const PREFIXES: &[&str] = &["antigravity cli", "antigravity", "claude code", "claude", "codex", "opencode", "cursor", "kimi"];
    for prefix in PREFIXES {
        let Some(rest) = starts_with_ci(text, prefix) else {
            continue;
        };
        let rest = rest.trim_start();
        for sep in ['—', '–', '-', ':', '·', '|', '/'] {
            if let Some(after) = rest.strip_prefix(sep) {
                let after = after.trim();
                if !after.is_empty() {
                    return after;
                }
            }
        }
    }
    text
}

fn is_bare_agent_name(text: &str) -> bool {
    let lower = text.trim().to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "antigravity" | "antigravity cli" | "agy" | "claude" | "claude code" | "codex" | "opencode" | "cursor" | "kimi" | "pi" | "grok"
    )
}

fn clean_osc_session_title(raw: &str, agent: Option<&str>, running_command: Option<&str>) -> Option<String> {
    let cleaned = strip_leading_glyphs(raw);
    if cleaned.is_empty() || is_default_title(cleaned) || is_command_echo(cleaned, running_command) {
        return None;
    }
    let is_coding_agent = agent.is_some_and(|a| a != "cmd");
    let result = if is_coding_agent {
        let stripped = strip_agent_prefix(cleaned);
        if stripped.is_empty() || is_default_title(stripped) || is_bare_agent_name(stripped) {
            return None;
        }
        stripped
    } else {
        cleaned
    };
    Some(result.to_owned())
}

#[cfg(test)]
mod name_tests {
    use crate::terminal::{RunningState, TerminalStatus};

    use super::{is_default_title, resolve_terminal_name};

    fn agent_status(agent: &str, state: RunningState) -> TerminalStatus {
        TerminalStatus {
            state,
            agent: Some(agent.into()),
            label: Some(agent.into()),
        }
    }

    fn cmd_status(cmd: &str) -> TerminalStatus {
        TerminalStatus {
            state: RunningState::Working,
            agent: Some("cmd".into()),
            label: Some(cmd.into()),
        }
    }

    #[test]
    fn a_shells_own_title_is_not_a_name() {
        assert!(is_default_title("lucasay@Caos-MacBook-Pro:~/farm"));
        assert!(is_default_title("lucasay@mac"));
        assert!(is_default_title("zsh — lucasay@mac: ~/orca/projects/vibevalley"));
        assert!(is_default_title("~/orca/projects/vibevalley"));
        assert!(is_default_title("/Users/lucasay/orca/projects/vibevalley"));
        assert!(is_default_title("-zsh"));
        assert!(is_default_title("me@host"));
        assert!(!is_default_title("vim notes.md"));
        assert!(!is_default_title("@team"));
    }

    #[test]
    fn link_title_always_wins_over_osc_and_running_agent() {
        let status = agent_status("antigravity", RunningState::Working);
        assert_eq!(
            resolve_terminal_name(Some("  Release Worker  "), Some("✳ Other Title"), Some("agy"), &status, "zsh"),
            "Release Worker"
        );
    }

    #[test]
    fn coding_agent_osc_title_strips_spinners_and_redundant_engine_prefixes() {
        let agy = agent_status("antigravity", RunningState::Working);
        assert_eq!(
            resolve_terminal_name(None, Some("✳ Fix terminal titles"), Some("agy"), &agy, "zsh"),
            "Fix terminal titles"
        );
        assert_eq!(
            resolve_terminal_name(None, Some("⠋ Unified Content Hub"), Some("agy"), &agy, "zsh"),
            "Unified Content Hub"
        );
        assert_eq!(
            resolve_terminal_name(None, Some("Antigravity — Refactor sidebar"), Some("agy"), &agy, "zsh"),
            "Refactor sidebar"
        );
        assert_eq!(
            resolve_terminal_name(None, Some("Antigravity CLI · Swarm V1"), Some("agy"), &agy, "zsh"),
            "Swarm V1"
        );
        let claude = agent_status("claude", RunningState::Ready);
        assert_eq!(
            resolve_terminal_name(None, Some("Claude Code: Fix bug"), Some("claude"), &claude, "zsh"),
            "Fix bug"
        );
    }

    #[test]
    fn bare_agent_launch_echo_falls_back_to_canonical_display_name() {
        let agy = agent_status("antigravity", RunningState::Working);
        assert_eq!(
            resolve_terminal_name(None, Some("agy --resume"), Some("agy --resume abc"), &agy, "zsh"),
            "Antigravity"
        );
        assert_eq!(resolve_terminal_name(None, Some("✳ Antigravity"), Some("agy"), &agy, "zsh"), "Antigravity");
        let claude = agent_status("claude", RunningState::Ready);
        assert_eq!(resolve_terminal_name(None, Some("Claude Code"), Some("claude"), &claude, "zsh"), "Claude Code");
        assert_eq!(resolve_terminal_name(None, None, Some("claude"), &claude, "zsh"), "Claude Code");
        let codex = agent_status("codex", RunningState::Working);
        assert_eq!(resolve_terminal_name(None, Some("codex"), Some("codex"), &codex, "zsh"), "Codex");
        assert!(!super::is_bare_agent_name("dsh"));
    }

    #[test]
    fn regular_shell_command_never_shows_command_name_or_preexec_echo() {
        let cargo = cmd_status("cargo");
        assert_eq!(resolve_terminal_name(None, Some("cargo test"), Some("cargo test"), &cargo, "zsh"), "zsh");
        assert_eq!(resolve_terminal_name(None, Some("cargo"), Some("cargo test --all"), &cargo, "zsh"), "zsh");
        assert_eq!(resolve_terminal_name(None, None, Some("cargo test"), &cargo, "zsh"), "zsh");
        let git = cmd_status("git");
        assert_eq!(resolve_terminal_name(None, Some("git status"), Some("git status -sb"), &git, "zsh"), "zsh");
    }

    #[test]
    fn explicit_custom_osc_title_on_idle_shell_is_preserved() {
        let idle = TerminalStatus::idle();
        assert_eq!(resolve_terminal_name(None, Some("API Server"), None, &idle, "zsh"), "API Server");
        assert_eq!(resolve_terminal_name(None, Some("vim notes.md"), None, &idle, "zsh"), "vim notes.md");
        assert_eq!(resolve_terminal_name(None, Some("~/repo"), None, &idle, "zsh"), "zsh");
    }

    #[test]
    fn titlebar_hit_uses_strict_half_open_36px_strip() {
        assert!(!super::is_titlebar_hit(-0.1));
        assert!(super::is_titlebar_hit(0.0));
        assert!(super::is_titlebar_hit(18.0));
        assert!(super::is_titlebar_hit(35.99));
        assert!(!super::is_titlebar_hit(36.0));
        assert!(!super::is_titlebar_hit(40.0));
        assert!(!super::is_titlebar_hit(f32::NAN));
    }

    #[test]
    fn window_drag_slop_requires_movement_beyond_3px_threshold() {
        let origin = (100.0, 18.0);
        assert!(!super::exceeded_window_drag_slop(origin, (100.0, 18.0)));
        assert!(!super::exceeded_window_drag_slop(origin, (103.0, 21.0)));
        assert!(!super::exceeded_window_drag_slop(origin, (97.0, 15.0)));
        assert!(super::exceeded_window_drag_slop(origin, (103.1, 18.0)));
        assert!(super::exceeded_window_drag_slop(origin, (100.0, 14.9)));
    }
}
