//! The terminal pane: owns one `TermSession`, turns GPUI input into session
//! calls, and repaints when the session says it is dirty.

mod element;
mod keys;

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui_kit::{
    App, AppContext as _, ClipboardItem, Context, EventEmitter, FocusHandle, Focusable, InteractiveElement as _, IntoElement, KeyDownEvent, Modifiers,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement as _, Pixels, Point, Render, ScrollEvent, Styled as _, Window, div, point, px,
};
use unicode_segmentation::UnicodeSegmentation;
use vibevalley_terminal::{
    Mods, MouseButton as TermButton, MouseInput, MouseKind, Row, SelectionMode, Snapshot, SpawnOptions, TermEvent, TermSession, TermSize,
};

pub use element::Geometry;
use element::{RowCache, TerminalElement};

use crate::theme::Ui;

gpui_kit::actions!(terminal, [Copy, Paste, Clear, ScrollPageUp, ScrollPageDown, ScrollToBottom]);

#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub cwd: PathBuf,
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
    Exited,
    OpenLink(String),
}

enum Input {
    Key(vibevalley_terminal::KeyInput),
    Text(String),
    Paste(String),
}

impl Input {
    fn deliver(self, session: &TermSession) {
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

enum State {
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

impl RunningState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Working => "working",
            Self::Ready => "ready",
            Self::Idle => "idle",
        }
    }
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
}

/// PTY output within this window treats an interactive agent/TUI as actively
/// working rather than sitting idle at its input prompt.
const ACTIVE_OUTPUT_WINDOW: Duration = Duration::from_secs(3);

pub struct TerminalView {
    state: State,
    pending_input: Vec<Input>,
    spec: SpawnSpec,
    focus: FocusHandle,
    pub(crate) marked: Option<String>,
    pub(crate) geometry: Option<Geometry>,
    pub(crate) row_cache: Rc<RefCell<RowCache>>,
    pub(crate) blink_on: bool,
    focused: bool,
    title: Option<String>,
    running_command: Option<String>,
    last_output_at: Option<Instant>,
    settle_pending: bool,
    last_status: TerminalStatus,
    exited: bool,
    scroll_remainder: Pixels,
    /// Left button went down inside the grid (selection or reported drag).
    dragging: bool,
    /// Cell where a click started, and whether its selection is still unstarted.
    drag_anchor: Option<(vibevalley_terminal::Point, bool)>,
    context_menu: Option<Point<Pixels>>,
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

        let initial_title = spec.title.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(str::to_string);
        TerminalView {
            state: State::Unsized,
            pending_input: Vec::new(),
            spec,
            focus: cx.focus_handle(),
            marked: None,
            geometry: None,
            row_cache: Rc::default(),
            blink_on: true,
            focused: false,
            title: initial_title,
            running_command: None,
            last_output_at: None,
            settle_pending: false,
            last_status: TerminalStatus::idle(),
            exited: false,
            scroll_remainder: px(0.0),
            dragging: false,
            drag_anchor: None,
            context_menu: None,
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

    pub fn link_title(&self) -> Option<&str> {
        self.spec.title.as_deref().filter(|title| !title.trim().is_empty())
    }

    pub fn title(&self) -> Option<&str> {
        self.link_title().or(self.title.as_deref())
    }

    /// Structured status distinguishing actively running commands/output (`Working`)
    /// from an interactive agent CLI sitting open at its prompt (`Ready`) and a plain
    /// idle shell (`Idle`).
    pub fn terminal_status(&self) -> TerminalStatus {
        self.terminal_status_at(Instant::now())
    }

    fn terminal_status_at(&self, now: Instant) -> TerminalStatus {
        let recent_output = self.last_output_at.is_some_and(|t| now.saturating_duration_since(t) < ACTIVE_OUTPUT_WINDOW);
        let snap = self.snapshot();
        let mut alt_lines = Vec::new();
        let mut inline_lines = Vec::new();
        let mut is_idle_prompt = false;
        let alt_screen = snap.as_ref().is_some_and(|s| s.alt_screen);

        if let Some(snap) = snap.as_ref() {
            if snap.alt_screen {
                alt_lines = snap.rows.iter().map(|row| row.runs.iter().map(|r| r.text.as_str()).collect()).collect();
            } else {
                let cursor_row = snap.cursor.row as usize;
                let max_row = cursor_row.min(snap.rows.len().saturating_sub(1));
                for row in snap.rows.iter().take(max_row + 1).rev().take(12) {
                    let line: String = row.runs.iter().map(|r| r.text.as_str()).collect();
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        inline_lines.push(trimmed.to_lowercase());
                    }
                }
                let last_non_empty = inline_lines.first().map(String::as_str).unwrap_or("");
                is_idle_prompt = looks_like_shell_prompt(last_non_empty);
            }
        }

        classify_terminal_status(
            self.exited,
            self.running_command.as_deref(),
            self.spec.program.as_deref(),
            self.title.as_deref(),
            alt_screen,
            &alt_lines,
            &inline_lines,
            is_idle_prompt,
            recent_output,
        )
    }

    /// Detects whether an agent (`antigravity`, `codex`, `claude`, `opencode`, ...) or
    /// command is present in this terminal: returns `(agent_id, display_label)`.
    pub fn running_status(&self) -> Option<(String, String)> {
        let status = self.terminal_status();
        match status.state {
            RunningState::Idle => None,
            RunningState::Working | RunningState::Ready => Some((status.agent?, status.label?)),
        }
    }

    fn ensure_settle_timer(&mut self, cx: &mut Context<Self>) {
        if self.settle_pending {
            return;
        }
        self.settle_pending = true;
        cx.spawn(async move |this, cx| {
            loop {
                let wait = this
                    .update(cx, |view, cx| {
                        let Some(last_at) = view.last_output_at else {
                            view.settle_pending = false;
                            return None;
                        };
                        let elapsed = Instant::now().saturating_duration_since(last_at);
                        if elapsed < ACTIVE_OUTPUT_WINDOW {
                            return Some((ACTIVE_OUTPUT_WINDOW - elapsed) + Duration::from_millis(80));
                        }
                        view.settle_pending = false;
                        let now = view.terminal_status();
                        if now != view.last_status {
                            view.last_status = now;
                            cx.emit(TerminalEvent::TitleChanged);
                        }
                        None
                    })
                    .ok()
                    .flatten();
                let Some(delay) = wait else {
                    break;
                };
                cx.background_executor().timer(delay).await;
            }
        })
        .detach();
    }

    pub fn directory(&self) -> PathBuf {
        self.session()
            .and_then(|session| session.local_cwd().or_else(|| session.cwd()))
            .filter(|p| p.is_dir())
            .unwrap_or_else(|| self.spec.cwd.clone())
    }

    pub fn can_reopen_in(&self, target: &std::path::Path) -> bool {
        !self.exited
            && !matches!(self.state, State::Failed(_))
            && self.session().is_none_or(TermSession::is_alive)
            && self.directory().canonicalize().is_ok_and(|cwd| cwd.starts_with(target))
    }

    pub fn has_exited(&self) -> bool {
        self.exited
    }

    fn input(&mut self, input: Input) {
        match &self.state {
            State::Running(session) if !self.exited => input.deliver(session),
            State::Unsized | State::Spawning => self.pending_input.push(input),
            _ => {}
        }
    }

    pub fn send_line(&mut self, line: &str) {
        self.input(Input::Text(line.to_owned()));
        self.input(Input::Key(vibevalley_terminal::KeyInput {
            key: vibevalley_terminal::Key::Enter,
            mods: Mods::default(),
            text: None,
        }));
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
                        for input in view.pending_input.drain(..) {
                            input.deliver(&session);
                        }
                        view.state = State::Running(session);
                        cx.emit(TerminalEvent::Spawned);
                        cx.notify();
                        true
                    }
                    Err(e) => {
                        view.pending_input.clear();
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
                self.last_output_at = Some(Instant::now());
                let now_status = self.terminal_status();
                if now_status.state == RunningState::Working {
                    self.ensure_settle_timer(cx);
                }
                if now_status != self.last_status {
                    self.last_status = now_status;
                    cx.emit(TerminalEvent::TitleChanged);
                }
                cx.notify();
            }
            TermEvent::TitleChanged(title) => {
                let next = Some(title).filter(|t| !t.trim().is_empty());
                if next.as_deref().is_some_and(crate::panes::is_default_title) && self.spec.title.as_deref().is_some_and(|t| !t.trim().is_empty()) {
                    return;
                }
                self.title = next.or_else(|| self.spec.title.clone().filter(|t| !t.trim().is_empty()));
                let now_status = self.terminal_status();
                if now_status.state == RunningState::Working {
                    self.ensure_settle_timer(cx);
                }
                self.last_status = now_status;
                cx.emit(TerminalEvent::TitleChanged);
            }
            TermEvent::CwdChanged(_) => cx.emit(TerminalEvent::TitleChanged),
            TermEvent::Bell => cx.emit(TerminalEvent::Bell),
            TermEvent::CommandStarted(block) => {
                self.running_command = Some(block.command).filter(|c| !c.trim().is_empty());
                self.last_output_at = Some(Instant::now());
                let now_status = self.terminal_status();
                if now_status.state == RunningState::Working {
                    self.ensure_settle_timer(cx);
                }
                self.last_status = now_status;
                cx.emit(TerminalEvent::TitleChanged);
            }
            TermEvent::CommandFinished(_) => {
                self.running_command = None;
                self.last_output_at = None;
                self.last_status = self.terminal_status();
                cx.emit(TerminalEvent::CommandFinished);
            }
            TermEvent::Exited { .. } => {
                self.running_command = None;
                self.last_output_at = None;
                self.last_status = TerminalStatus::idle();
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
        if !text.is_empty() {
            self.input(Input::Text(text.to_owned()));
        }
        self.wake_cursor(cx);
    }

    fn wake_cursor(&mut self, cx: &mut Context<Self>) {
        self.blink_on = true;
        cx.notify();
    }

    fn on_capture_key_down(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        // Intercept Tab / Shift-Tab before gpui-base::Root's focus-cycling keybindings swallow them.
        if self.marked.is_some() || event.keystroke.key != "tab" || event.keystroke.modifiers.platform {
            return;
        }
        let option_as_meta = Ui::get(cx).settings.option_as_meta;
        if let Some(input) = keys::map_keystroke(&event.keystroke, option_as_meta) {
            self.input(Input::Key(input));
            cx.stop_propagation();
            self.wake_cursor(cx);
        }
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.context_menu.take().is_some() {
            cx.notify();
            if event.keystroke.key == "escape" {
                cx.stop_propagation();
                return;
            }
        }
        // While composing, every key belongs to the input method.
        if self.marked.is_some() {
            return;
        }
        let option_as_meta = Ui::get(cx).settings.option_as_meta;
        if let Some(input) = keys::map_keystroke(&event.keystroke, option_as_meta) {
            self.input(Input::Key(input));
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
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            self.input(Input::Paste(text));
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
        let (Some(session), Some(g)) = (self.session().cloned(), self.geometry) else {
            return;
        };
        let at = g.cell_at(event.position);
        let button = match event.button {
            MouseButton::Left => TermButton::Left,
            MouseButton::Middle => TermButton::Middle,
            MouseButton::Right => TermButton::Right,
            _ => return,
        };
        if self.reports_mouse(event.modifiers) {
            if self.context_menu.take().is_some() {
                cx.notify();
            }
            session.send_mouse(MouseInput {
                kind: MouseKind::Press(button),
                at,
                mods: mods(event.modifiers),
            });
            self.dragging = button == TermButton::Left;
            return;
        }
        if button == TermButton::Right {
            let local_x = (event.position.x - g.origin.x + px(element::PADDING)).max(px(4.0));
            let local_y = (event.position.y - g.origin.y + px(element::PADDING)).max(px(4.0));
            let max_x = (g.cell_width * g.size.cols as f32 + px(element::PADDING * 2.0) - px(164.0)).max(px(4.0));
            let max_y = (g.line_height * g.size.rows as f32 + px(element::PADDING * 2.0) - px(124.0)).max(px(4.0));
            self.context_menu = Some(point(local_x.min(max_x), local_y.min(max_y)));
            cx.notify();
            return;
        }
        if button != TermButton::Left {
            return;
        }
        if self.context_menu.take().is_some() {
            cx.notify();
            return;
        }
        if event.modifiers.platform {
            if let Some(url) = self.hyperlink_at(at) {
                cx.open_url(&url);
                return;
            }
            if let Some(token) = self.link_token_at(at) {
                cx.emit(TerminalEvent::OpenLink(token));
                return;
            }
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

    fn link_token_at(&self, at: vibevalley_terminal::Point) -> Option<String> {
        let snapshot = self.snapshot()?;
        let row = snapshot.rows.get(at.row as usize)?;
        extract_link_token(row, at.col)
    }
}

fn extract_link_token(row: &Row, col: u16) -> Option<String> {
    let mut line = String::new();
    let mut cur_col = 0u16;
    let mut target_byte = None;
    for run in &row.runs {
        if run.start_col > cur_col {
            for _ in 0..(run.start_col - cur_col) {
                line.push(' ');
            }
            cur_col = run.start_col;
        }
        for g in run.text.graphemes(true) {
            let w = element::grapheme_cols(g);
            if col >= cur_col && col < cur_col + w {
                target_byte = Some(line.len());
            }
            line.push_str(g);
            cur_col += w;
        }
    }
    let byte_idx = target_byte?;
    if line[byte_idx..].chars().next()?.is_whitespace() {
        return None;
    }
    let start = line[..byte_idx]
        .rfind(char::is_whitespace)
        .map_or(0, |i| i + line[i..].chars().next().map_or(1, char::len_utf8));
    let end = line[byte_idx..].find(char::is_whitespace).map_or(line.len(), |i| byte_idx + i);
    let trimmed = line[start..end]
        .trim_matches(|c: char| matches!(c, '(' | ')' | '[' | ']' | '<' | '>' | '\'' | '"' | ',' | ';'))
        .trim_end_matches(':');
    looks_like_link_or_path(trimmed).then(|| trimmed.to_string())
}

fn strip_line_col(s: &str) -> &str {
    let mut base = s;
    for _ in 0..2 {
        if let Some((head, tail)) = base.rsplit_once(':')
            && !head.is_empty()
            && !tail.is_empty()
            && tail.bytes().all(|b| b.is_ascii_digit())
        {
            base = head;
        } else {
            break;
        }
    }
    base
}

fn looks_like_link_or_path(token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    if token.starts_with("http://") {
        return token.len() > "http://".len();
    }
    if token.starts_with("https://") {
        return token.len() > "https://".len();
    }
    let base = strip_line_col(token);
    if base.is_empty() {
        return false;
    }
    if base.contains('/') {
        return base.chars().any(char::is_alphanumeric);
    }
    const CODE_EXTS: &[&str] = &[
        "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "toml", "yaml", "yml", "md", "markdown", "py", "go", "swift", "c", "h", "cpp", "hpp", "sh",
        "zsh", "css", "html", "sql", "txt", "lock",
    ];
    base.rsplit_once('.')
        .is_some_and(|(stem, ext)| !stem.is_empty() && CODE_EXTS.iter().any(|e| ext.eq_ignore_ascii_case(e)))
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

fn looks_like_shell_prompt(line: &str) -> bool {
    line.ends_with('%') || line.ends_with('$') || line.ends_with('#') || line.ends_with('❯') || line.ends_with('➜')
}

fn detect_agent_token(text: &str) -> Option<&'static str> {
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
            "dsh" => return Some("dsh"),
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

fn detect_inline_agent(lines: &[String]) -> Option<&'static str> {
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
        if matches_inline_cli(line, "dsh") {
            return Some("dsh");
        }
        if matches_inline_cli(line, "grok") {
            return Some("grok");
        }
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn classify_terminal_status(
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
            .capture_key_down(cx.listener(Self::on_capture_key_down))
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
            .children(self.context_menu.map(|pos| {
                let colors = colors.clone();
                let item = |id: &'static str, label: &'static str| {
                    div()
                        .id(id)
                        .h(px(26.0))
                        .px(px(10.0))
                        .flex()
                        .items_center()
                        .text_size(px(12.0))
                        .text_color(colors.text)
                        .hover(move |s| s.bg(colors.hover))
                        .child(label)
                };
                div()
                    .id("terminal-context-menu")
                    .absolute()
                    .left(pos.x)
                    .top(pos.y)
                    .w(px(160.0))
                    .py(px(4.0))
                    .rounded(px(6.0))
                    .border_1()
                    .border_color(colors.border)
                    .bg(colors.elevated)
                    .shadow_md()
                    .flex()
                    .flex_col()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
                    .child(item("ctx-copy", "Copy").on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, _, window, cx| {
                            this.context_menu = None;
                            this.copy(&Copy, window, cx);
                            cx.notify();
                            cx.stop_propagation();
                        }),
                    ))
                    .child(item("ctx-paste", "Paste").on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, _, window, cx| {
                            this.context_menu = None;
                            this.paste(&Paste, window, cx);
                            cx.notify();
                            cx.stop_propagation();
                        }),
                    ))
                    .child(item("ctx-clear", "Clear").on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, _, window, cx| {
                            this.context_menu = None;
                            this.clear(&Clear, window, cx);
                            cx.notify();
                            cx.stop_propagation();
                        }),
                    ))
                    .child(item("ctx-scroll-bottom", "Scroll to bottom").on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, _, _, cx| {
                            this.context_menu = None;
                            if let Some(session) = this.session() {
                                session.scroll_to_bottom();
                            }
                            cx.notify();
                            cx.stop_propagation();
                        }),
                    ))
            }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibevalley_terminal::{CellStyle, Rgb, Run};

    fn make_row(text: &str) -> Row {
        Row {
            runs: vec![Run {
                start_col: 0,
                cols: text.len() as u16,
                text: text.to_string(),
                style: CellStyle {
                    fg: Rgb(255, 255, 255),
                    bg: None,
                    bold: false,
                    italic: false,
                    dim: false,
                    underline: false,
                    strikethrough: false,
                },
                hyperlink: None,
            }],
            wrapped: false,
        }
    }

    #[test]
    fn extracts_urls_and_file_paths() {
        let row = make_row("see (https://example.com/a/b), apps/mac/src/shell.rs:42:5; Cargo.toml hello");
        assert_eq!(extract_link_token(&row, 10).as_deref(), Some("https://example.com/a/b"));
        assert_eq!(extract_link_token(&row, 35).as_deref(), Some("apps/mac/src/shell.rs:42:5"));
        assert_eq!(extract_link_token(&row, 62).as_deref(), Some("Cargo.toml"));
        assert_eq!(extract_link_token(&row, 70), None);
    }

    #[test]
    fn rejects_plain_words_and_bare_slashes() {
        assert!(!looks_like_link_or_path(""));
        assert!(!looks_like_link_or_path("hello"));
        assert!(!looks_like_link_or_path("/"));
        assert!(!looks_like_link_or_path("http://"));
        assert!(!looks_like_link_or_path(".rs"));
        assert!(looks_like_link_or_path("lib.rs:10"));
        assert!(looks_like_link_or_path("./README.md"));
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
        assert_eq!(detect_agent_token("dsh"), Some("dsh"));
        assert_eq!(detect_agent_token("grok"), Some("grok"));
        assert_eq!(detect_agent_token("zsh"), None);
        assert_eq!(detect_agent_token("cargo test -p vibevalley-mac"), None);
    }

    #[test]
    fn detects_inline_agents_from_screen_lines() {
        assert_eq!(detect_inline_agent(&["welcome to antigravity".into()]), Some("antigravity"));
        assert_eq!(detect_inline_agent(&["~/repo % agy".into()]), Some("antigravity"));
        assert_eq!(detect_inline_agent(&["❯ pi --model fast".into()]), Some("pi"));
        assert_eq!(detect_inline_agent(&["$ dsh".into()]), Some("dsh"));
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
}
