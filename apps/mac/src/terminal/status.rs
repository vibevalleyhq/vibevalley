use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use vibevalley_terminal::{LinkMatch, LinkTarget, Row, TermEvent, TermSession};

#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub cwd: PathBuf,
    /// Owning workspace project root, used as fallback when resolving relative links.
    pub project_root: Option<PathBuf>,
    pub title: Option<String>,
    pub program: Option<String>,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Saved output shown above the new shell's prompt (a restored terminal).
    pub history: Option<String>,
}

impl SpawnSpec {
    pub fn shell(cwd: PathBuf) -> Self {
        SpawnSpec {
            cwd,
            project_root: None,
            title: None,
            program: None,
            args: Vec::new(),
            env: Vec::new(),
            history: None,
        }
    }
}

#[derive(Debug, Clone)]
pub enum TerminalEvent {
    /// The session exists now; the registry can adopt it.
    Spawned,
    SpawnFailed(String),
    TitleChanged,
    Bell,
    CommandFinished,
    /// An interactive coding agent finished a turn and settled back to its prompt.
    AgentTurnFinished {
        agent: String,
        label: String,
    },
    Exited,
    OpenLink(LinkTarget),
}

pub(super) enum Input {
    Key(vibevalley_terminal::KeyInput),
    Text(String),
    Paste(String),
}

impl Input {
    pub(super) fn is_submit(&self) -> bool {
        match self {
            Input::Key(key) => matches!(key.key, vibevalley_terminal::Key::Enter) && !key.mods.shift && !key.mods.alt,
            Input::Text(text) | Input::Paste(text) => text.contains('\n') || text.contains('\r'),
        }
    }

    pub(super) fn deliver(self, session: &TermSession) {
        session.scroll_to_bottom();
        match self {
            Input::Key(key) => {
                session.selection_clear();
                session.send_key(key);
            }
            Input::Text(text) => session.send_text(&text),
            Input::Paste(text) => session.paste(&text),
        }
    }
}

pub(super) enum State {
    /// Waiting for the first layout, which decides the grid size.
    Unsized,
    Spawning,
    Running(TermSession),
    Failed(String),
}

/// How actively a terminal is running work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RunningState {
    /// Actively producing output or executing a foreground command.
    Working,
    /// An interactive agent CLI or full-screen TUI is open and waiting at its prompt.
    Ready,
    /// Plain idle shell with no active command or agent.
    #[default]
    Idle,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TerminalStatus {
    pub state: RunningState,
    pub agent: Option<String>,
    pub label: Option<String>,
}

impl TerminalStatus {
    pub fn idle() -> Self {
        Self::default()
    }

    pub fn is_coding_agent(&self) -> bool {
        self.agent.as_deref().is_some_and(|agent| agent != "cmd")
    }
}

pub fn agent_display_name(agent: &str, label: &str) -> String {
    match agent {
        "antigravity" => "Antigravity".into(),
        "claude" => "Claude Code".into(),
        "codex" => "Codex".into(),
        "opencode" => "OpenCode".into(),
        "cursor" => "Cursor".into(),
        "kimi" => "Kimi".into(),
        "pi" => "Pi".into(),
        "grok" => "Grok".into(),
        _ if !label.trim().is_empty() => label.trim().to_string(),
        _ => agent.to_string(),
    }
}

/// PTY output within this window treats an interactive agent/TUI as actively
/// working rather than sitting idle at its input prompt.
pub(super) const ACTIVE_OUTPUT_WINDOW: Duration = Duration::from_secs(3);

/// Local keystroke echo arrives within this window of typing; ignore it when
/// deciding whether a coding agent has started an actual turn.
const KEYSTROKE_ECHO_WINDOW: Duration = Duration::from_millis(300);

#[derive(Debug, Default)]
pub(super) struct AgentTurnTracker {
    turn_active: bool,
    last_non_submit_input_at: Option<Instant>,
    notified_for_turn: bool,
}

impl AgentTurnTracker {
    pub(super) fn on_input(&mut self, is_submit: bool, now: Instant) {
        if is_submit {
            self.last_non_submit_input_at = None;
            self.notified_for_turn = false;
        } else {
            self.last_non_submit_input_at = Some(now);
        }
    }

    pub(super) fn on_output(&mut self, status: &TerminalStatus, now: Instant) {
        if !status.is_coding_agent() {
            self.turn_active = false;
            self.notified_for_turn = false;
            return;
        }
        if status.state == RunningState::Working {
            let is_local_echo = !self.turn_active
                && self
                    .last_non_submit_input_at
                    .is_some_and(|t| now.saturating_duration_since(t) < KEYSTROKE_ECHO_WINDOW);
            if !is_local_echo {
                self.turn_active = true;
                self.notified_for_turn = false;
            }
        }
    }

    pub(super) fn on_bell(&mut self, status: &TerminalStatus) -> Option<(String, String)> {
        if status.is_coding_agent() && (self.turn_active || status.state == RunningState::Working) && !self.notified_for_turn {
            self.notified_for_turn = true;
            self.turn_active = false;
            return Self::notice(status);
        }
        None
    }

    pub(super) fn on_settled(&mut self, previous: &TerminalStatus, current: &TerminalStatus) -> Option<(String, String)> {
        if !current.is_coding_agent() {
            self.turn_active = false;
            self.notified_for_turn = false;
            return None;
        }
        if previous.state == RunningState::Working && current.state == RunningState::Ready && self.turn_active && !self.notified_for_turn {
            self.notified_for_turn = true;
            self.turn_active = false;
            return Self::notice(current);
        }
        None
    }

    pub(super) fn on_command_finished(&mut self, previous: &TerminalStatus) -> Option<(String, String)> {
        let notice = if previous.is_coding_agent() && self.turn_active && !self.notified_for_turn {
            Self::notice(previous)
        } else {
            None
        };
        self.turn_active = false;
        self.notified_for_turn = notice.is_some();
        notice
    }

    pub(super) fn reset(&mut self) {
        self.turn_active = false;
        self.last_non_submit_input_at = None;
        self.notified_for_turn = false;
    }

    fn notice(status: &TerminalStatus) -> Option<(String, String)> {
        let agent = status.agent.clone()?;
        let label = status.label.clone().unwrap_or_else(|| agent.clone());
        Some((agent, label))
    }
}

pub(super) struct HoveredLink {
    pub(super) link: LinkMatch,
    pub(super) snapshot_seq: u64,
    /// Rows that produced `link`, checked via `Arc::ptr_eq` on `Dirty` to drop
    /// stale underlines without running link resolution during output bursts.
    pub(super) row_refs: Vec<(u16, Arc<Row>)>,
}

/// Collapses redundant `TermEvent::Dirty` frames in a queued burst into at most
/// one `Dirty` at the end while preserving all semantic events in order.
pub(super) fn coalesce_term_events(events: impl IntoIterator<Item = TermEvent>) -> Vec<TermEvent> {
    let mut out = Vec::new();
    let mut saw_dirty = false;
    for event in events {
        if matches!(event, TermEvent::Dirty) {
            saw_dirty = true;
        } else {
            out.push(event);
        }
    }
    if saw_dirty {
        out.push(TermEvent::Dirty);
    }
    out
}

pub(crate) fn first_command_token(cmd: &str) -> Option<&str> {
    cmd.split_whitespace()
        .find(|tok| !tok.contains('=') && *tok != "sudo" && *tok != "env" && *tok != "npx")
        .map(|tok| tok.rsplit('/').next().unwrap_or(tok))
}

pub(super) fn looks_like_shell_prompt(line: &str) -> bool {
    line.ends_with('%') || line.ends_with('$') || line.ends_with('#') || line.ends_with('❯') || line.ends_with('➜')
}

pub(super) fn detect_agent_token(text: &str) -> Option<&'static str> {
    let lower = text.to_lowercase();
    for word in lower.split(|c: char| !c.is_alphanumeric() && c != '-' && c != '_') {
        match word {
            "antigravity" | "antigravity-cli" | "agy" => return Some("antigravity"),
            "codex" | "codex-cli" => return Some("codex"),
            "claude" | "claude-code" => return Some("claude"),
            "opencode" => return Some("opencode"),
            "gemini" | "gemini-cli" => return Some("gemini"),
            "cursor" | "cursor-agent" => return Some("cursor"),
            "kimi" | "kimi-cli" => return Some("kimi"),
            "pi" | "pi-cli" => return Some("pi"),
            "grok" | "grok-cli" => return Some("grok"),
            _ => {}
        }
    }
    None
}

fn matches_inline_cli(line: &str, cli: &str) -> bool {
    if line == cli {
        return true;
    }
    if line.starts_with(cli) && line.as_bytes().get(cli.len()).is_some_and(|b| b.is_ascii_whitespace()) {
        return true;
    }
    for prefix in ["% ", "$ ", "❯ ", "➜ "] {
        if let Some(pos) = line.find(prefix) {
            let rest = &line[pos + prefix.len()..];
            if rest == cli || (rest.starts_with(cli) && rest.as_bytes().get(cli.len()).is_some_and(|b| b.is_ascii_whitespace())) {
                return true;
            }
        }
    }
    false
}

pub(super) fn detect_inline_agent(lines: &[String]) -> Option<&'static str> {
    for line in lines {
        if line.contains("antigravity") || matches_inline_cli(line, "agy") {
            return Some("antigravity");
        }
        if line.contains("openai codex") || matches_inline_cli(line, "codex") {
            return Some("codex");
        }
        if line.contains("claude code") || matches_inline_cli(line, "claude") {
            return Some("claude");
        }
        if line.contains("opencode") {
            return Some("opencode");
        }
        if line.contains("cursor-agent") || matches_inline_cli(line, "cursor") {
            return Some("cursor");
        }
        if line.contains("kimi-cli") || matches_inline_cli(line, "kimi") {
            return Some("kimi");
        }
        if matches_inline_cli(line, "pi") {
            return Some("pi");
        }
        if matches_inline_cli(line, "grok") {
            return Some("grok");
        }
    }
    None
}

#[allow(clippy::too_many_arguments)]
pub(super) fn classify_terminal_status(
    exited: bool,
    running_command: Option<&str>,
    program: Option<&str>,
    title: Option<&str>,
    alt_screen: bool,
    alt_lines: &[String],
    inline_lines: &[String],
    is_idle_prompt: bool,
    recent_output: bool,
) -> TerminalStatus {
    if exited {
        return TerminalStatus::idle();
    }
    let interactive_state = if recent_output { RunningState::Working } else { RunningState::Ready };

    if let Some(cmd) = running_command {
        if let Some(agent) = detect_agent_token(cmd) {
            return TerminalStatus {
                state: interactive_state,
                agent: Some(agent.to_string()),
                label: Some(agent.to_string()),
            };
        }
        let head = first_command_token(cmd).unwrap_or(cmd);
        let state = if alt_screen { interactive_state } else { RunningState::Working };
        return TerminalStatus {
            state,
            agent: Some("cmd".into()),
            label: Some(head.to_string()),
        };
    }

    if let Some(prog) = program
        && let Some(agent) = detect_agent_token(prog)
    {
        return TerminalStatus {
            state: interactive_state,
            agent: Some(agent.to_string()),
            label: Some(agent.to_string()),
        };
    }

    if let Some(t) = title
        && let Some(agent) = detect_agent_token(t)
    {
        return TerminalStatus {
            state: interactive_state,
            agent: Some(agent.to_string()),
            label: Some(agent.to_string()),
        };
    }

    if alt_screen {
        for line in alt_lines {
            if let Some(agent) = detect_agent_token(line) {
                return TerminalStatus {
                    state: interactive_state,
                    agent: Some(agent.to_string()),
                    label: Some(agent.to_string()),
                };
            }
        }
        let label = title
            .map(str::trim)
            .filter(|s| !s.is_empty() && !crate::panes::is_default_title(s))
            .map(String::from)
            .unwrap_or_else(|| "运行中".into());
        return TerminalStatus {
            state: interactive_state,
            agent: Some("cmd".into()),
            label: Some(label),
        };
    }

    if !is_idle_prompt && let Some(agent) = detect_inline_agent(inline_lines) {
        return TerminalStatus {
            state: interactive_state,
            agent: Some(agent.to_string()),
            label: Some(agent.to_string()),
        };
    }

    TerminalStatus::idle()
}
