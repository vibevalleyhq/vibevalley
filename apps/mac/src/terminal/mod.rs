//! The terminal pane: owns one `TermSession`, turns GPUI input into session
//! calls, and repaints when the session says it is dirty.

mod element;
mod keys;

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use gpui_kit::{
    App, AppContext as _, ClipboardItem, Context, EventEmitter, FocusHandle, Focusable, InteractiveElement as _, IntoElement, KeyDownEvent, Modifiers,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement as _, Pixels, Render, ScrollEvent, Styled as _, Window, div, px,
};
use vibevalley_terminal::{Mods, MouseButton as TermButton, MouseInput, MouseKind, SelectionMode, Snapshot, SpawnOptions, TermEvent, TermSession, TermSize};

pub use element::Geometry;
use element::{RowCache, TerminalElement};

use crate::theme::Ui;

gpui_kit::actions!(terminal, [Copy, Paste, Clear, ScrollPageUp, ScrollPageDown, ScrollToBottom]);

#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub cwd: PathBuf,
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
    Exited,
}

enum State {
    /// Waiting for the first layout, which decides the grid size.
    Unsized,
    Spawning,
    Running(TermSession),
    Failed(String),
}

pub struct TerminalView {
    state: State,
    spec: SpawnSpec,
    focus: FocusHandle,
    pub(crate) marked: Option<String>,
    pub(crate) geometry: Option<Geometry>,
    pub(crate) row_cache: Rc<RefCell<RowCache>>,
    pub(crate) blink_on: bool,
    focused: bool,
    title: Option<String>,
    running_command: Option<String>,
    last_running: Option<(String, String)>,
    exited: bool,
    scroll_remainder: Pixels,
    /// Left button went down inside the grid (selection or reported drag).
    dragging: bool,
    /// Cell where a click started, and whether its selection is still unstarted.
    drag_anchor: Option<(vibevalley_terminal::Point, bool)>,
}

fn mods(m: Modifiers) -> Mods {
    Mods {
        shift: m.shift,
        ctrl: m.control,
        alt: m.alt,
        cmd: m.platform,
    }
}

impl TerminalView {
    pub fn new(spec: SpawnSpec, cx: &mut Context<Self>) -> Self {
        // The session normally starts at the first layout. A window that is
        // not drawn (hidden, on a locked screen) never lays out, so start at
        // a default size; the first layout resizes it.
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(500)).await;
            let _ = this.update(cx, |view, cx| {
                if matches!(view.state, State::Unsized) {
                    view.spawn(
                        TermSize {
                            cols: 100,
                            rows: 30,
                            cell_width_px: 8,
                            cell_height_px: 17,
                        },
                        cx,
                    );
                }
            });
        })
        .detach();
        // Cursor blink. Wakes twice a second and only repaints while the
        // focused terminal shows a blinking cursor.
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(530)).await;
                let alive = this.update(cx, |view, cx| {
                    let blinking = view.focused && Ui::get(cx).settings.cursor_blink && view.snapshot().is_some_and(|s| s.cursor.visible && s.cursor.blinking);
                    if blinking {
                        view.blink_on = !view.blink_on;
                        cx.notify();
                    } else if !view.blink_on {
                        view.blink_on = true;
                        cx.notify();
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();

        TerminalView {
            state: State::Unsized,
            spec,
            focus: cx.focus_handle(),
            marked: None,
            geometry: None,
            row_cache: Rc::default(),
            blink_on: true,
            focused: false,
            title: None,
            running_command: None,
            last_running: None,
            exited: false,
            scroll_remainder: px(0.0),
            dragging: false,
            drag_anchor: None,
        }
    }

    pub fn session(&self) -> Option<&TermSession> {
        match &self.state {
            State::Running(session) => Some(session),
            _ => None,
        }
    }

    pub fn snapshot(&self) -> Option<Arc<Snapshot>> {
        self.session().map(|s| s.snapshot())
    }

    pub fn title(&self) -> Option<&str> {
        self.title.as_deref()
    }

    /// Detects whether an agent (`codex`, `claude`, `opencode`, ...) or command
    /// is actively running in this terminal: returns `(agent_id, display_label)`.
    pub fn running_status(&self) -> Option<(String, String)> {
        if self.exited {
            return None;
        }
        if let Some(cmd) = self.running_command.as_deref() {
            if let Some(agent) = detect_agent_token(cmd) {
                return Some((agent.to_string(), agent.to_string()));
            }
            let head = first_command_token(cmd).unwrap_or(cmd);
            return Some(("cmd".into(), head.to_string()));
        }
        if let Some(title) = self.title.as_deref()
            && let Some(agent) = detect_agent_token(title)
        {
            return Some((agent.to_string(), agent.to_string()));
        }
        let snap = self.snapshot()?;
        if snap.alt_screen {
            for row in &snap.rows {
                let line: String = row.runs.iter().map(|r| r.text.as_str()).collect();
                if let Some(agent) = detect_agent_token(&line) {
                    return Some((agent.to_string(), agent.to_string()));
                }
            }
            let label = self.title.clone().unwrap_or_else(|| "运行中".into());
            return Some(("cmd".into(), label));
        }
        // Inline agent TUIs (like Codex or Claude Code) that do not use alt_screen:
        // check the non-empty lines near the cursor if the cursor row is not an idle shell prompt.
        let cursor_row = snap.cursor.row as usize;
        let max_row = cursor_row.min(snap.rows.len().saturating_sub(1));
        let mut window_lines = Vec::new();
        for row in snap.rows.iter().take(max_row + 1).rev().take(12) {
            let line: String = row.runs.iter().map(|r| r.text.as_str()).collect();
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                window_lines.push(trimmed.to_lowercase());
            }
        }
        let last_non_empty = window_lines.first().map(String::as_str).unwrap_or("");
        let is_idle_prompt = last_non_empty.ends_with('%')
            || last_non_empty.ends_with('$')
            || last_non_empty.ends_with('#')
            || last_non_empty.ends_with('❯')
            || last_non_empty.ends_with('➜');
        if !is_idle_prompt {
            for line in &window_lines {
                if line.contains("openai codex")
                    || line.starts_with("codex")
                    || line.contains("% codex")
                    || line.contains("$ codex")
                    || line.contains("❯ codex")
                {
                    return Some(("codex".into(), "codex".into()));
                }
                if line.contains("claude code")
                    || line.starts_with("claude")
                    || line.contains("% claude")
                    || line.contains("$ claude")
                    || line.contains("❯ claude")
                {
                    return Some(("claude".into(), "claude".into()));
                }
                if line.contains("opencode") {
                    return Some(("opencode".into(), "opencode".into()));
                }
            }
        }
        None
    }

    pub fn has_exited(&self) -> bool {
        self.exited
    }

    /// Types text as if pasted (used to run `$EDITOR file`).
    pub fn send_line(&self, line: &str) {
        if let Some(session) = self.session() {
            session.send_text(line);
            session.send_key(vibevalley_terminal::KeyInput {
                key: vibevalley_terminal::Key::Enter,
                mods: Mods::default(),
                text: None,
            });
        }
    }

    /// Called at prepaint with the grid the element measured. Starts the
    /// session on the first call and resizes it afterwards.
    pub(crate) fn set_geometry(&mut self, geometry: Geometry, cx: &mut Context<Self>) {
        let previous = self.geometry.replace(geometry);
        match &self.state {
            State::Unsized => self.spawn(geometry.size, cx),
            State::Running(session) if previous.map(|g| g.size) != Some(geometry.size) => session.resize(geometry.size),
            _ => {}
        }
    }

    fn spawn(&mut self, size: TermSize, cx: &mut Context<Self>) {
        self.state = State::Spawning;
        let ui = Ui::get(cx);
        let mut env = self.spec.env.clone();
        env.push(("TERM_PROGRAM".into(), "VibeValley".into()));
        env.push(("COLORTERM".into(), "truecolor".into()));
        let opts = SpawnOptions {
            cwd: self.spec.cwd.clone(),
            program: self.spec.program.clone(),
            args: self.spec.args.clone(),
            env,
            size,
            scrollback_lines: ui.settings.scrollback_lines,
            theme: ui.colors.term.clone(),
        };
        let (tx, rx) = flume::unbounded::<TermEvent>();
        let history = self.spec.history.take();
        let spawned = cx.background_spawn(async move {
            let on_event = move |event| {
                let _ = tx.send(event);
            };
            match history {
                Some(history) => TermSession::spawn_with_history(opts, &history, on_event),
                None => TermSession::spawn(opts, on_event),
            }
        });
        cx.spawn(async move |this, cx| {
            let result = spawned.await;
            let ok = this
                .update(cx, |view, cx| match result {
                    Ok(session) => {
                        // The pane may have been resized while the PTY was starting.
                        if let Some(g) = view.geometry
                            && g.size != size
                        {
                            session.resize(g.size);
                        }
                        view.state = State::Running(session);
                        cx.emit(TerminalEvent::Spawned);
                        cx.notify();
                        true
                    }
                    Err(e) => {
                        view.state = State::Failed(e.to_string());
                        cx.emit(TerminalEvent::SpawnFailed(e.to_string()));
                        cx.notify();
                        false
                    }
                })
                .unwrap_or(false);
            if !ok {
                return;
            }
            // Session thread -> UI thread. `Dirty` is coalesced by the
            // backend, so this is one wake-up per changed frame, no polling.
            while let Ok(event) = rx.recv_async().await {
                if this.update(cx, |view, cx| view.on_term_event(event, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
    }

    fn on_term_event(&mut self, event: TermEvent, cx: &mut Context<Self>) {
        match event {
            TermEvent::Dirty => {
                let now_running = self.running_status();
                if now_running != self.last_running {
                    self.last_running = now_running;
                    cx.emit(TerminalEvent::TitleChanged);
                }
                cx.notify();
            }
            TermEvent::TitleChanged(title) => {
                self.title = Some(title).filter(|t| !t.trim().is_empty());
                self.last_running = self.running_status();
                cx.emit(TerminalEvent::TitleChanged);
            }
            TermEvent::CwdChanged(_) => cx.emit(TerminalEvent::TitleChanged),
            TermEvent::Bell => cx.emit(TerminalEvent::Bell),
            TermEvent::CommandStarted(block) => {
                self.running_command = Some(block.command).filter(|c| !c.trim().is_empty());
                self.last_running = self.running_status();
                cx.emit(TerminalEvent::TitleChanged);
            }
            TermEvent::CommandFinished(_) => {
                self.running_command = None;
                self.last_running = self.running_status();
                cx.emit(TerminalEvent::CommandFinished);
            }
            TermEvent::Exited { .. } => {
                self.running_command = None;
                self.last_running = None;
                self.exited = true;
                cx.emit(TerminalEvent::Exited);
                cx.notify();
            }
        }
    }

    pub fn apply_theme(&mut self, cx: &mut Context<Self>) {
        if let Some(session) = self.session() {
            session.set_theme(Ui::get(cx).colors.term.clone());
        }
        cx.notify();
    }

    pub(crate) fn set_marked(&mut self, marked: Option<String>, cx: &mut Context<Self>) {
        self.marked = marked.filter(|m| !m.is_empty());
        cx.notify();
    }

    pub(crate) fn commit_text(&mut self, text: &str, cx: &mut Context<Self>) {
        self.marked = None;
        if let Some(session) = self.session()
            && !text.is_empty()
        {
            session.scroll_to_bottom();
            session.send_text(text);
        }
        self.wake_cursor(cx);
    }

    fn wake_cursor(&mut self, cx: &mut Context<Self>) {
        self.blink_on = true;
        cx.notify();
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        // While composing, every key belongs to the input method.
        if self.marked.is_some() {
            return;
        }
        let Some(session) = self.session() else { return };
        let option_as_meta = Ui::get(cx).settings.option_as_meta;
        if let Some(input) = keys::map_keystroke(&event.keystroke, option_as_meta) {
            session.selection_clear();
            session.scroll_to_bottom();
            session.send_key(input);
            cx.stop_propagation();
            self.wake_cursor(cx);
        }
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        let Some(session) = self.session().cloned() else { return };
        // `selection_text` is a blocking round-trip to the session thread.
        let text = cx.background_spawn(async move { session.selection_text() });
        cx.spawn(async move |_, cx| {
            if let Some(text) = text.await.filter(|t| !t.is_empty()) {
                cx.update(|cx| cx.write_to_clipboard(ClipboardItem::new_string(text)));
            }
        })
        .detach();
    }

    fn paste(&mut self, _: &Paste, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(session) = self.session()
            && let Some(text) = cx.read_from_clipboard().and_then(|item| item.text())
        {
            session.scroll_to_bottom();
            session.paste(&text);
        }
    }

    fn clear(&mut self, _: &Clear, _: &mut Window, _: &mut Context<Self>) {
        if let Some(session) = self.session() {
            session.send_key(vibevalley_terminal::KeyInput {
                key: vibevalley_terminal::Key::Char("l".into()),
                mods: Mods { ctrl: true, ..Mods::default() },
                text: None,
            });
        }
    }

    fn scroll_page(&mut self, pages: i32) {
        if let (Some(session), Some(g)) = (self.session(), self.geometry) {
            session.scroll_lines(pages * (g.size.rows as i32 - 1).max(1));
        }
    }

    fn reports_mouse(&self, modifiers: Modifiers) -> bool {
        // Shift bypasses the program's mouse mode, as in every terminal.
        !modifiers.shift && self.snapshot().is_some_and(|s| s.mouse_reporting)
    }

    fn on_mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        let (Some(session), Some(g)) = (self.session(), self.geometry) else { return };
        let at = g.cell_at(event.position);
        let button = match event.button {
            MouseButton::Left => TermButton::Left,
            MouseButton::Middle => TermButton::Middle,
            MouseButton::Right => TermButton::Right,
            _ => return,
        };
        if self.reports_mouse(event.modifiers) {
            session.send_mouse(MouseInput {
                kind: MouseKind::Press(button),
                at,
                mods: mods(event.modifiers),
            });
            self.dragging = button == TermButton::Left;
            return;
        }
        if button != TermButton::Left {
            return;
        }
        if event.modifiers.platform
            && let Some(url) = self.hyperlink_at(at)
        {
            cx.open_url(&url);
            return;
        }
        if event.modifiers.shift {
            session.selection_extend(at);
        } else {
            let mode = match event.click_count {
                0 | 1 => SelectionMode::Cell,
                2 => SelectionMode::Word,
                _ => SelectionMode::Line,
            };
            session.selection_clear();
            if event.click_count > 1 {
                session.selection_start(at, mode);
            }
        }
        self.dragging = true;
        self.drag_anchor = Some((at, event.click_count <= 1));
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, _: &mut Context<Self>) {
        let (Some(session), Some(g)) = (self.session().cloned(), self.geometry) else {
            return;
        };
        let at = g.cell_at(event.position);
        if self.reports_mouse(event.modifiers) {
            session.send_mouse(MouseInput {
                kind: MouseKind::Move,
                at,
                mods: mods(event.modifiers),
            });
            return;
        }
        if self.dragging && event.pressed_button == Some(MouseButton::Left) {
            // A plain click must not leave a one-cell selection behind, so
            // the selection only starts once the pointer leaves the cell.
            if let Some((anchor, true)) = self.drag_anchor {
                if anchor == at {
                    return;
                }
                session.selection_start(anchor, SelectionMode::Cell);
                self.drag_anchor = Some((anchor, false));
            }
            session.selection_extend(at);
        }
    }

    fn on_mouse_up(&mut self, event: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        let was_dragging = std::mem::take(&mut self.dragging);
        self.drag_anchor = None;
        let (Some(session), Some(g)) = (self.session(), self.geometry) else { return };
        let button = match event.button {
            MouseButton::Left => TermButton::Left,
            MouseButton::Middle => TermButton::Middle,
            MouseButton::Right => TermButton::Right,
            _ => return,
        };
        if self.reports_mouse(event.modifiers) && (was_dragging || button != TermButton::Left) {
            session.send_mouse(MouseInput {
                kind: MouseKind::Release(button),
                at: g.cell_at(event.position),
                mods: mods(event.modifiers),
            });
        }
    }

    fn on_scroll(&mut self, event: &ScrollEvent, _: &mut Window, _: &mut Context<Self>) {
        let (Some(session), Some(g)) = (self.session().cloned(), self.geometry) else {
            return;
        };
        let total = self.scroll_remainder + event.delta.pixel_delta(g.line_height).y;
        let lines = (total / g.line_height).trunc() as i32;
        self.scroll_remainder = total - g.line_height * lines as f32;
        if lines == 0 {
            return;
        }
        let Some(snapshot) = self.snapshot() else { return };
        if self.reports_mouse(event.modifiers) {
            session.send_mouse(MouseInput {
                kind: MouseKind::Wheel { lines },
                at: g.cell_at(event.position),
                mods: mods(event.modifiers),
            });
        } else if snapshot.alternate_scroll {
            // Alternate scroll (DEC 1007): the full-screen program wants
            // the wheel as arrow keys.
            let key = if lines > 0 {
                vibevalley_terminal::Key::Up
            } else {
                vibevalley_terminal::Key::Down
            };
            for _ in 0..lines.unsigned_abs().min(50) {
                session.send_key(vibevalley_terminal::KeyInput {
                    key: key.clone(),
                    mods: Mods::default(),
                    text: None,
                });
            }
        } else {
            session.scroll_lines(lines);
        }
    }

    fn hyperlink_at(&self, at: vibevalley_terminal::Point) -> Option<String> {
        let snapshot = self.snapshot()?;
        let row = snapshot.rows.get(at.row as usize)?;
        row.runs
            .iter()
            .find(|run| at.col >= run.start_col && at.col < run.start_col + run.cols)
            .and_then(|run| run.hyperlink.as_ref())
            .map(|url| url.to_string())
    }
}

impl EventEmitter<TerminalEvent> for TerminalView {}

impl Focusable for TerminalView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

fn first_command_token(cmd: &str) -> Option<&str> {
    cmd.split_whitespace()
        .find(|tok| !tok.contains('=') && *tok != "sudo" && *tok != "env" && *tok != "npx")
        .map(|tok| tok.rsplit('/').next().unwrap_or(tok))
}

fn detect_agent_token(text: &str) -> Option<&'static str> {
    let lower = text.to_lowercase();
    for word in lower.split(|c: char| !c.is_alphanumeric() && c != '-' && c != '_') {
        match word {
            "codex" | "codex-cli" => return Some("codex"),
            "claude" | "claude-code" => return Some("claude"),
            "opencode" => return Some("opencode"),
            "gemini" | "gemini-cli" => return Some("gemini"),
            "cursor" | "cursor-agent" => return Some("cursor"),
            "kimi" => return Some("kimi"),
            _ => {}
        }
    }
    None
}

impl Render for TerminalView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.focused = self.focus.is_focused(window);
        let colors = &Ui::get(cx).colors;
        let message = match &self.state {
            State::Failed(error) => Some(format!("Could not start the shell: {error}")),
            _ if self.exited => Some("[process exited]".to_string()),
            _ => None,
        };
        div()
            .id("terminal")
            .size_full()
            .relative()
            .bg(colors.bg)
            .track_focus(&self.focus)
            .key_context("Terminal")
            .on_key_down(cx.listener(Self::on_key_down))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::clear))
            .on_action(cx.listener(|this, _: &ScrollPageUp, _, _| this.scroll_page(1)))
            .on_action(cx.listener(|this, _: &ScrollPageDown, _, _| this.scroll_page(-1)))
            .on_action(cx.listener(|this, _: &ScrollToBottom, _, _| {
                if let Some(session) = this.session() {
                    session.scroll_to_bottom();
                }
            }))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_down(MouseButton::Middle, cx.listener(Self::on_mouse_down))
            .on_mouse_down(MouseButton::Right, cx.listener(Self::on_mouse_down))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up(MouseButton::Middle, cx.listener(Self::on_mouse_up))
            .on_mouse_up(MouseButton::Right, cx.listener(Self::on_mouse_up))
            .on_scroll(cx.listener(Self::on_scroll))
            .child(TerminalElement::new(cx.entity(), self.focus.clone()))
            .children(message.map(|text| {
                div()
                    .absolute()
                    .bottom_2()
                    .right_3()
                    .px_2()
                    .rounded_md()
                    .bg(colors.elevated)
                    .text_color(colors.muted)
                    .text_size(px(12.0))
                    .child(text)
            }))
    }
}
