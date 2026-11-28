use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{
    App, AppContext as _, ClipboardItem, Context, EventEmitter, FocusHandle, Focusable, InteractiveElement as _, IntoElement, KeyDownEvent, MouseButton,
    ParentElement as _, Pixels, Point, Render, StatefulInteractiveElement as _, Styled as _, Window, div, px,
};
use vibevalley_terminal::{Mods, ResolvedTerminalHooks, Snapshot, SpawnOptions, TermEvent, TermSession, TermSize};

use super::element::{Geometry, RowCache, TerminalElement};
use super::keys;
use super::preview;
use super::status::{
    ACTIVE_OUTPUT_WINDOW, AgentTurnTracker, HoveredLink, Input, RunningState, SpawnSpec, State, TerminalEvent, TerminalHookStatus, TerminalStatus,
    classify_busy_label, classify_terminal_status, coalesce_term_events, looks_like_shell_prompt,
};
use super::{Clear, Copy, Paste, ScrollPageDown, ScrollPageUp, ScrollToBottom};
use crate::theme::Ui;

pub struct TerminalView {
    state: State,
    pending_input: Vec<Input>,
    pub(super) spec: SpawnSpec,
    active_hooks: ResolvedTerminalHooks,
    desired_hooks: ResolvedTerminalHooks,
    pub(super) focus: FocusHandle,
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
    turn_tracker: AgentTurnTracker,
    exited: bool,
    pub(super) scroll_remainder: Pixels,
    /// Left button went down inside the grid (selection or reported drag).
    pub(super) dragging: bool,
    /// Cell where a click started, and whether its selection is still unstarted.
    pub(super) drag_anchor: Option<(vibevalley_terminal::Point, bool)>,
    /// Cell where a plain (non-Cmd, non-Shift) single click started when no
    /// selection was active; cleared as soon as the pointer drags to another cell.
    pub(super) plain_click_cell: Option<vibevalley_terminal::Point>,
    pub(super) hovered_cell: Option<vibevalley_terminal::Point>,
    pub(super) hover_eval_key: Option<(u64, vibevalley_terminal::Point, bool)>,
    pub(super) hovered_link: Option<HoveredLink>,
    pub(super) preview_gen: u64,
    pub(super) image_preview: Option<preview::ImagePreview>,
    pub(super) cmd_held: bool,
    pub(super) context_menu: Option<Point<Pixels>>,
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
                    let blinking = view.focused
                        && Ui::get(cx).settings.cursor_blink
                        && Ui::get(cx).settings.effective_motion() != crate::theme::MotionChoice::Off
                        && view.snapshot().is_some_and(|s| s.cursor.visible && s.cursor.blinking);
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
        let initial_status = classify_terminal_status(false, None, spec.program.as_deref(), initial_title.as_deref(), false, &[], &[], false, false);
        let initial_hooks = spec.hooks.clone();
        TerminalView {
            state: State::Unsized,
            pending_input: Vec::new(),
            spec,
            active_hooks: initial_hooks.clone(),
            desired_hooks: initial_hooks,
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
            last_status: initial_status,
            turn_tracker: AgentTurnTracker::default(),
            exited: false,
            scroll_remainder: px(0.0),
            dragging: false,
            drag_anchor: None,
            plain_click_cell: None,
            hovered_cell: None,
            hover_eval_key: None,
            hovered_link: None,
            preview_gen: 0,
            image_preview: None,
            cmd_held: false,
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

    pub fn osc_title(&self) -> Option<&str> {
        self.title.as_deref()
    }

    pub fn running_command(&self) -> Option<&str> {
        self.running_command.as_deref()
    }

    pub fn title(&self) -> Option<&str> {
        self.link_title().or(self.title.as_deref())
    }

    /// Structured status distinguishing actively running commands/output (`Working`)
    /// from an interactive agent CLI sitting open at its prompt (`Ready`) and a plain
    /// idle shell (`Idle`).
    pub fn terminal_status(&self) -> TerminalStatus {
        let now = Instant::now();
        if self.last_output_at.is_none_or(|t| now.saturating_duration_since(t) < ACTIVE_OUTPUT_WINDOW) {
            return self.last_status.clone();
        }
        self.terminal_status_at(now)
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
                        let previous = view.last_status.clone();
                        let now = view.terminal_status();
                        if let Some((agent, label)) = view.turn_tracker.on_settled(&previous, &now) {
                            cx.emit(TerminalEvent::AgentTurnFinished { agent, label });
                        }
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

    pub fn is_alive(&self) -> bool {
        !self.exited && !matches!(self.state, State::Failed(_)) && self.session().is_none_or(TermSession::is_alive)
    }

    pub fn has_foreground_process(&self) -> bool {
        self.is_alive() && self.session().is_some_and(TermSession::has_foreground_process)
    }

    /// Returns a descriptive process or agent label when closing this terminal
    /// would interrupt an active foreground command or agent, else `None`.
    pub fn busy_label(&self) -> Option<String> {
        let alive = self.is_alive();
        let has_fg = self.has_foreground_process();
        let status = self.terminal_status();
        let fallback = crate::host_types::shell_name();
        classify_busy_label(alive, has_fg, self.running_command.as_deref(), &status, self.title.as_deref(), &fallback)
    }

    pub fn can_reopen_in(&self, target: &std::path::Path) -> bool {
        self.is_alive() && self.directory().canonicalize().is_ok_and(|cwd| cwd.starts_with(target))
    }

    pub fn has_exited(&self) -> bool {
        self.exited
    }

    pub fn hook_status(&self) -> TerminalHookStatus {
        TerminalHookStatus::from_resolved(&self.active_hooks, &self.desired_hooks)
    }

    pub fn desired_hooks(&self) -> &ResolvedTerminalHooks {
        &self.desired_hooks
    }

    pub fn set_desired_hooks(&mut self, hooks: ResolvedTerminalHooks, cx: &mut Context<Self>) {
        self.desired_hooks = hooks.clone();
        self.spec.hooks = hooks;
        cx.notify();
    }

    pub fn respawn_with_hooks(&mut self, hooks: ResolvedTerminalHooks, cx: &mut Context<Self>) {
        let cwd = self.directory();
        self.spec.cwd = cwd;
        self.spec.hooks = hooks.clone();
        self.desired_hooks = hooks;
        self.active_hooks = self.desired_hooks.clone();
        self.running_command = None;
        self.last_output_at = None;
        self.settle_pending = false;
        self.exited = false;
        self.turn_tracker.reset();
        self.pending_input.clear();
        self.state = State::Unsized;
        if let Some(geometry) = self.geometry {
            self.spawn(geometry.size, cx);
        }
        cx.notify();
    }

    fn input(&mut self, input: Input) {
        self.turn_tracker.on_input(input.is_submit(), Instant::now());
        match &self.state {
            State::Running(session) if !self.exited => input.deliver(session),
            State::Unsized | State::Spawning => self.pending_input.push(input),
            _ => {}
        }
    }

    pub fn send_text(&mut self, text: &str) {
        self.input(Input::Text(text.to_owned()));
    }

    pub fn send_line(&mut self, line: &str) {
        self.send_text(line);
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
        let hooks = self.desired_hooks.clone();
        self.active_hooks = hooks.clone();
        let mut env = self.spec.env.clone();
        if !hooks.is_empty() {
            hooks.apply_to_spawn_env(&mut env);
        }
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
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<TermEvent>();
        let history = self.spec.history.take();
        let spawned = cx.background_spawn(async move {
            let on_event = move |event| {
                let _ = tx.send(event);
            };
            match history {
                Some(history) => TermSession::spawn_with_history_and_hooks(opts, &history, hooks, on_event),
                None => TermSession::spawn_with_hooks(opts, hooks, on_event),
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
                        view.last_status = view.terminal_status_at(Instant::now());
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
            // Session thread -> UI thread. Drain any queued burst and coalesce
            // redundant `Dirty` frames so rapid PTY output triggers one status scan
            // and one repaint per UI wake-up.
            while let Some(first) = rx.recv().await {
                let mut raw = vec![first];
                while let Ok(next) = rx.try_recv() {
                    raw.push(next);
                }
                let batch = coalesce_term_events(raw);
                if this.update(cx, |view, cx| view.on_term_events(batch, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();
    }

    fn on_term_events(&mut self, events: Vec<TermEvent>, cx: &mut Context<Self>) {
        let mut needs_notify = false;
        for event in events {
            if self.apply_term_event(event, cx) {
                needs_notify = true;
            }
        }
        if needs_notify {
            cx.notify();
        }
    }

    fn apply_term_event(&mut self, event: TermEvent, cx: &mut Context<Self>) -> bool {
        match event {
            TermEvent::Dirty => {
                self.invalidate_stale_hover();
                let now = Instant::now();
                self.last_output_at = Some(now);
                let now_status = self.terminal_status_at(now);
                self.turn_tracker.on_output(&now_status, now);
                if now_status.state == RunningState::Working {
                    self.ensure_settle_timer(cx);
                }
                if now_status != self.last_status {
                    self.last_status = now_status;
                    cx.emit(TerminalEvent::TitleChanged);
                }
                true
            }
            TermEvent::TitleChanged(title) => {
                let next = Some(title).filter(|t| !t.trim().is_empty());
                if next.as_deref().is_some_and(crate::host_types::is_default_title) && self.spec.title.as_deref().is_some_and(|t| !t.trim().is_empty()) {
                    return false;
                }
                self.title = next.or_else(|| self.spec.title.clone().filter(|t| !t.trim().is_empty()));
                let now_status = self.terminal_status_at(Instant::now());
                if now_status.state == RunningState::Working {
                    self.ensure_settle_timer(cx);
                }
                self.last_status = now_status;
                cx.emit(TerminalEvent::TitleChanged);
                false
            }
            TermEvent::CwdChanged(_) => {
                cx.emit(TerminalEvent::TitleChanged);
                false
            }
            TermEvent::Bell => {
                let status = self.terminal_status_at(Instant::now());
                if let Some((agent, label)) = self.turn_tracker.on_bell(&status) {
                    cx.emit(TerminalEvent::AgentTurnFinished { agent, label });
                }
                cx.emit(TerminalEvent::Bell);
                false
            }
            TermEvent::CommandStarted(block) => {
                self.running_command = Some(block.command).filter(|c| !c.trim().is_empty());
                let now = Instant::now();
                self.last_output_at = Some(now);
                let now_status = self.terminal_status_at(now);
                self.turn_tracker.on_output(&now_status, now);
                if now_status.state == RunningState::Working {
                    self.ensure_settle_timer(cx);
                }
                self.last_status = now_status;
                cx.emit(TerminalEvent::TitleChanged);
                false
            }
            TermEvent::CommandFinished(_) => {
                let previous = self.last_status.clone();
                self.running_command = None;
                self.last_output_at = None;
                self.last_status = self.terminal_status_at(Instant::now());
                if let Some((agent, label)) = self.turn_tracker.on_command_finished(&previous) {
                    cx.emit(TerminalEvent::AgentTurnFinished { agent, label });
                }
                cx.emit(TerminalEvent::CommandFinished);
                false
            }
            TermEvent::Exited { .. } => {
                self.running_command = None;
                self.last_output_at = None;
                self.last_status = TerminalStatus::idle();
                self.turn_tracker.reset();
                self.exited = true;
                cx.emit(TerminalEvent::Exited);
                true
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
            self.dismiss_image_preview();
            self.input(Input::Key(input));
            cx.stop_propagation();
            self.wake_cursor(cx);
        }
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.dismiss_image_preview() {
            cx.notify();
        }
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

    fn clear(&mut self, _: &Clear, _: &mut Window, _cx: &mut Context<Self>) {
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
}

impl EventEmitter<TerminalEvent> for TerminalView {}

impl Focusable for TerminalView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
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
        let mut root = div()
            .id("terminal")
            .size_full()
            .relative()
            .bg(colors.bg)
            .track_focus(&self.focus)
            .key_context("Terminal")
            .capture_key_down(cx.listener(Self::on_capture_key_down))
            .on_key_down(cx.listener(Self::on_key_down))
            .on_modifiers_changed(cx.listener(Self::on_modifiers_changed))
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                if !*hovered {
                    this.clear_hover(cx);
                }
            }))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::clear))
            .on_action(cx.listener(|this, _: &ScrollPageUp, _, cx| {
                if this.dismiss_image_preview() {
                    cx.notify();
                }
                this.scroll_page(1);
            }))
            .on_action(cx.listener(|this, _: &ScrollPageDown, _, cx| {
                if this.dismiss_image_preview() {
                    cx.notify();
                }
                this.scroll_page(-1);
            }))
            .on_action(cx.listener(|this, _: &ScrollToBottom, _, cx| {
                if this.dismiss_image_preview() {
                    cx.notify();
                }
                if let Some(session) = this.session() {
                    session.scroll_to_bottom();
                }
            }))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_down(MouseButton::Middle, cx.listener(Self::on_mouse_down))
            .on_mouse_down(MouseButton::Right, cx.listener(Self::on_mouse_down))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up_out))
            .on_mouse_up(MouseButton::Middle, cx.listener(Self::on_mouse_up))
            .on_mouse_up(MouseButton::Right, cx.listener(Self::on_mouse_up))
            .on_scroll(cx.listener(Self::on_scroll));
        if self.hovered_link.is_some() {
            root = root.cursor_pointer();
        }
        let image_preview = self
            .image_preview
            .as_ref()
            .filter(|_| self.context_menu.is_none() && !self.dragging)
            .and_then(|meta| {
                let geometry = self.geometry?;
                let span = self.hovered_link.as_ref()?.link.spans.first().copied()?;
                Some(preview::render_popover(meta, &geometry, span, colors))
            });
        root.child(TerminalElement::new(cx.entity(), self.focus.clone()))
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
            .children(image_preview)
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
