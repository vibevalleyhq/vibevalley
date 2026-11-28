//! Session event loop: feeds PTY bytes into the VT engine, handles UI
//! commands, publishes throttled snapshots, and drives graceful teardown.

use std::sync::atomic::Ordering;
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use alacritty_terminal::event::Event;
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::term::TermMode;
use alacritty_terminal::vte::ansi::Processor;

use crate::input::Input;
use crate::pty::Pty;
use crate::screen::Builder;
use crate::{Key, KeyInput, Mods, Snapshot, TermError, TermEvent, TermSize, Theme};

use super::engine::{NoopTimeout, TermEngine, encode_paste};
use super::osc::{OscEvent, OscScanner, PromptMark};
use super::selection::SelectionState;
use super::shutdown::{REAP_GRACE, ShutdownStage, force_kill};
use super::{Msg, Shared};

/// Minimum spacing between published snapshots while output keeps arriving.
const FRAME: Duration = Duration::from_millis(8);
/// Longest a program may hold rendering with synchronized output (Mode 2026).
const MAX_HOLD: Duration = Duration::from_secs(1);
/// Quiet time after the child exits before giving up on a PTY EOF (a
/// background job can keep the slave side open indefinitely).
const EXIT_DRAIN: Duration = Duration::from_millis(300);
const EXIT_DRAIN_MAX: Duration = Duration::from_secs(3);

struct Session {
    engine: TermEngine,
    processor: Processor<NoopTimeout>,
    osc: OscScanner,
    builder: Builder,
    input: Input,
    selection: SelectionState,
    pty: Pty,
    shared: Arc<Shared>,
    on_event: Box<dyn Fn(TermEvent)>,
    size: TermSize,
    theme: Theme,
    title: Option<String>,
    dirty: bool,
    last_publish: Instant,
    eof: bool,
    child_exit: Option<Option<i32>>,
    exited_at: Option<Instant>,
    exit_deadline: Option<Instant>,
    shutdown_stage: ShutdownStage,
    finished: bool,
}

impl Session {
    fn new(opts: &crate::SpawnOptions, pty: Pty, shared: Arc<Shared>, on_event: Box<dyn Fn(TermEvent)>) -> Self {
        let size = TermSize {
            cols: opts.size.cols.max(2),
            rows: opts.size.rows.max(1),
            ..opts.size
        };
        Self {
            engine: TermEngine::new(size, opts.scrollback_lines),
            processor: Processor::new(),
            osc: OscScanner::new(),
            builder: Builder::new(),
            input: Input::new(),
            selection: SelectionState::default(),
            pty,
            shared,
            on_event,
            size,
            theme: opts.theme.clone(),
            title: None,
            dirty: true,
            last_publish: Instant::now() - FRAME,
            eof: false,
            child_exit: None,
            exited_at: None,
            exit_deadline: None,
            shutdown_stage: ShutdownStage::None,
            finished: false,
        }
    }

    fn emit(&self, event: TermEvent) {
        (self.on_event)(event);
    }

    fn feed(&mut self, data: &[u8]) {
        let mut rest = data;
        while !rest.is_empty() {
            let (consumed, osc_event) = self.osc.next_chunk(rest);
            let chunk = &rest[..consumed];
            rest = &rest[consumed..];
            self.engine.feed_bytes(&mut self.processor, chunk);
            self.drain_term_events();
            if let Some(ev) = osc_event {
                self.on_osc_event(ev);
            }
        }
        self.dirty = true;
    }

    fn on_osc_event(&mut self, event: OscEvent) {
        match event {
            OscEvent::Pwd(pwd) => {
                *self.shared.cwd.lock().unwrap() = Some(pwd.clone());
                self.emit(TermEvent::CwdChanged(pwd));
            }
            OscEvent::Prompt(mark) => match mark {
                PromptMark::PromptStart => self.engine.on_prompt_start(),
                PromptMark::InputStart => self.engine.on_input_start(),
                PromptMark::OutputStart { command } => {
                    let info = self.engine.on_output_start(command);
                    self.emit(TermEvent::CommandStarted(info));
                }
                PromptMark::CommandEnd { exit_code } => {
                    if let Some(info) = self.engine.on_command_end(exit_code) {
                        self.emit(TermEvent::CommandFinished(info));
                    }
                }
            },
        }
    }

    fn drain_term_events(&mut self) {
        for event in self.engine.events.drain() {
            match event {
                Event::Bell => self.emit(TermEvent::Bell),
                Event::Title(title) => {
                    self.title = (!title.is_empty()).then(|| title.clone());
                    self.emit(TermEvent::TitleChanged(title));
                }
                Event::ResetTitle => {
                    self.title = None;
                    self.emit(TermEvent::TitleChanged(String::new()));
                }
                Event::PtyWrite(text) => self.pty.write(text.into_bytes()),
                Event::ColorRequest(index, formatter) => {
                    let rgb = self.engine.color_response(index, &self.theme);
                    self.pty.write(formatter(rgb).into_bytes());
                }
                Event::TextAreaSizeRequest(formatter) => {
                    self.pty.write(formatter(TermEngine::window_size(self.size)).into_bytes());
                }
                Event::Wakeup
                | Event::MouseCursorDirty
                | Event::CursorBlinkingChange
                | Event::ClipboardStore(..)
                | Event::ClipboardLoad(..)
                | Event::Exit
                | Event::ChildExit(_) => {}
            }
        }
    }

    fn held(&self, now: Instant) -> bool {
        self.engine.hold_since.is_some_and(|since| now.duration_since(since) < MAX_HOLD)
    }

    fn publish(&mut self) {
        self.dirty = false;
        self.last_publish = Instant::now();
        let frame = self.builder.build(&mut self.engine.term, &self.theme);
        let alt_screen = self.engine.is_alt_screen();
        let mouse_reporting = self.engine.is_mouse_tracking();
        let alternate_scroll = alt_screen && !mouse_reporting && self.engine.term.mode().contains(TermMode::ALTERNATE_SCROLL);
        let prev = self.shared.snapshot.lock().unwrap().clone();
        let next = Snapshot {
            seq: prev.seq + 1,
            size: self.size,
            rows: frame.rows,
            cursor: frame.cursor,
            title: self.title.clone(),
            scroll_offset: self.engine.term.grid().display_offset(),
            scrollback_len: self.engine.term.history_size(),
            selection: frame.selection,
            alt_screen,
            mouse_reporting,
            alternate_scroll,
        };
        let unchanged = prev.seq > 0
            && prev.size == next.size
            && prev.cursor == next.cursor
            && prev.title == next.title
            && prev.scroll_offset == next.scroll_offset
            && prev.scrollback_len == next.scrollback_len
            && prev.selection == next.selection
            && prev.alt_screen == next.alt_screen
            && prev.mouse_reporting == next.mouse_reporting
            && prev.alternate_scroll == next.alternate_scroll
            && prev.rows.len() == next.rows.len()
            && prev.rows.iter().zip(&next.rows).all(|(a, b)| Arc::ptr_eq(a, b));
        if unchanged {
            return;
        }
        *self.shared.snapshot.lock().unwrap() = Arc::new(next);
        if !self.shared.dirty_pending.swap(true, Ordering::AcqRel) {
            self.emit(TermEvent::Dirty);
        }
    }

    fn writable(&self) -> bool {
        self.child_exit.is_none() && !self.finished
    }

    fn follow_output(&mut self) {
        if self.engine.scroll_to_bottom() {
            self.dirty = true;
        }
    }

    fn send_key(&mut self, key: &KeyInput) {
        if !self.writable() {
            return;
        }
        let bytes = self.input.encode_key(*self.engine.term.mode(), key);
        if !bytes.is_empty() {
            self.follow_output();
            self.pty.write(bytes);
        }
    }

    fn paste(&mut self, text: String) {
        if !self.writable() || text.is_empty() {
            return;
        }
        let bracketed = self.engine.term.mode().contains(TermMode::BRACKETED_PASTE);
        self.follow_output();
        self.pty.write(encode_paste(&text, bracketed));
    }

    fn resize(&mut self, size: TermSize) {
        let size = TermSize {
            cols: size.cols.max(2),
            rows: size.rows.max(1),
            ..size
        };
        if size == self.size {
            return;
        }
        self.size = size;
        self.engine.resize(size);
        self.drain_term_events();
        if self.writable() {
            self.pty.resize(size);
        }
        self.dirty = true;
    }

    fn scroll_lines(&mut self, delta: i32) {
        if delta == 0 {
            return;
        }
        if self.engine.is_alt_screen() {
            let mode = *self.engine.term.mode();
            if !self.engine.is_mouse_tracking() && mode.contains(TermMode::ALTERNATE_SCROLL) && self.writable() {
                let key = KeyInput {
                    key: if delta > 0 { Key::Up } else { Key::Down },
                    mods: Mods::default(),
                    text: None,
                };
                let one = self.input.encode_key(mode, &key);
                let count = delta.unsigned_abs().min(256) as usize;
                self.pty.write(one.repeat(count));
            }
            return;
        }
        self.engine.term.scroll_display(Scroll::Delta(delta));
        self.dirty = true;
    }

    fn finish(&mut self) {
        if self.finished {
            return;
        }
        self.finished = true;
        self.exit_deadline = None;
        self.shutdown_stage = ShutdownStage::None;
        self.shared.alive.store(false, Ordering::Release);
        *self.shared.master_fd.lock().unwrap() = None;
        self.pty.shutdown();
        self.publish();
        self.emit(TermEvent::Exited {
            code: self.child_exit.flatten(),
        });
    }

    fn on_timers(&mut self, now: Instant) {
        self.shutdown_stage.advance(&self.pty, self.child_exit.is_some(), now);
        if self.exit_deadline.is_some_and(|at| now >= at) && self.child_exit.is_some() {
            self.finish();
        }
    }

    fn next_deadline(&self, now: Instant) -> Option<Instant> {
        let frame = self.dirty.then(|| {
            let at = self.last_publish + FRAME;
            match self.engine.hold_since {
                Some(since) if self.held(now) => at.max(since + MAX_HOLD),
                _ => at,
            }
        });
        [frame, self.exit_deadline, self.shutdown_stage.step_deadline(now)].into_iter().flatten().min()
    }

    /// Returns false when the session thread should stop.
    fn handle(&mut self, msg: Msg) -> bool {
        match msg {
            Msg::Pty(data) => {
                if !self.finished {
                    self.feed(&data);
                    if let Some(exited_at) = self.exited_at {
                        let now = Instant::now();
                        self.exit_deadline = Some((now + EXIT_DRAIN).min(exited_at + EXIT_DRAIN_MAX));
                    }
                }
                self.pty.budget.release(data.len());
            }
            Msg::PtyEof => {
                self.eof = true;
                if self.child_exit.is_some() {
                    self.finish();
                }
            }
            Msg::ChildExited(code) => {
                self.child_exit = Some(code);
                self.pty.release_slave();
                if self.eof {
                    self.finish();
                } else {
                    let now = Instant::now();
                    self.exited_at = Some(now);
                    self.exit_deadline = Some(now + EXIT_DRAIN);
                }
            }
            Msg::Key(key) => self.send_key(&key),
            Msg::Text(text) => {
                if self.writable() && !text.is_empty() {
                    self.follow_output();
                    self.pty.write(text.into_bytes());
                }
            }
            Msg::Paste(text) => self.paste(text),
            Msg::Mouse(mouse) => {
                let bytes = self.input.encode_mouse(*self.engine.term.mode(), self.size, mouse);
                if self.writable() {
                    self.pty.write(bytes);
                }
            }
            Msg::Resize(size) => self.resize(size),
            Msg::ScrollLines(delta) => self.scroll_lines(delta),
            Msg::ScrollToBottom => {
                self.engine.term.scroll_display(Scroll::Bottom);
                self.dirty = true;
            }
            Msg::SelectionStart(at, mode) => {
                self.selection.start(&mut self.engine.term, at, mode);
                self.dirty = true;
            }
            Msg::SelectionExtend(at) => {
                self.selection.extend(&mut self.engine.term, at);
                self.dirty = true;
            }
            Msg::SelectionClear => {
                self.selection.clear(&mut self.engine.term);
                self.dirty = true;
            }
            Msg::SelectionText(reply) => {
                let _ = reply.send(self.selection.text(&self.engine.term));
            }
            Msg::SetTheme(theme) => {
                self.theme = theme;
                self.builder.invalidate();
                self.dirty = true;
            }
            Msg::ScrollbackText(max_lines, reply) => {
                let _ = reply.send(self.engine.scrollback_text(max_lines));
            }
            Msg::CommandOutput(id, reply) => {
                let _ = reply.send(self.engine.command_output(id));
            }
            Msg::OptionAsAlt(value) => self.input.option_as_alt = value,
            Msg::Kill => self.shutdown_stage.start(&self.pty, self.child_exit.is_some(), Instant::now()),
            Msg::Shutdown => return false,
        }
        true
    }

    fn run(&mut self, rx: &mpsc::Receiver<Msg>) {
        loop {
            let now = Instant::now();
            self.on_timers(now);
            if self.dirty && !self.held(now) && now >= self.last_publish + FRAME {
                self.publish();
            }
            let msg = match rx.try_recv() {
                Ok(msg) => msg,
                Err(mpsc::TryRecvError::Disconnected) => return,
                Err(mpsc::TryRecvError::Empty) => {
                    let received = match self.next_deadline(now) {
                        Some(deadline) => rx.recv_timeout(deadline.saturating_duration_since(Instant::now())),
                        None => rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected),
                    };
                    match received {
                        Ok(msg) => msg,
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
            };
            if !self.handle(msg) {
                return;
            }
        }
    }

    fn shutdown(&mut self, rx: &mpsc::Receiver<Msg>) {
        if self.child_exit.is_none() {
            self.shutdown_stage.start(&self.pty, false, Instant::now());
            while self.child_exit.is_none() && self.shutdown_stage != ShutdownStage::None {
                let now = Instant::now();
                self.shutdown_stage.advance(&self.pty, false, now);
                let Some(deadline) = self.shutdown_stage.step_deadline(now) else {
                    break;
                };
                match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    Ok(Msg::ChildExited(code)) => {
                        self.child_exit = Some(code);
                        break;
                    }
                    Ok(Msg::Pty(data)) => self.pty.budget.release(data.len()),
                    Ok(_) => {}
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
            if self.child_exit.is_none() {
                force_kill(&self.pty, false);
                let reap_deadline = Instant::now() + REAP_GRACE;
                loop {
                    match rx.recv_timeout(reap_deadline.saturating_duration_since(Instant::now())) {
                        Ok(Msg::ChildExited(code)) => {
                            self.child_exit = Some(code);
                            break;
                        }
                        Ok(Msg::Pty(data)) => self.pty.budget.release(data.len()),
                        Ok(_) => {}
                        Err(_) => break,
                    }
                }
            }
        }
        self.shared.alive.store(false, Ordering::Release);
        *self.shared.master_fd.lock().unwrap() = None;
        self.pty.shutdown();
    }
}

pub(crate) fn run_with_history(
    opts: crate::SpawnOptions,
    history: &str,
    pty: Pty,
    shared: Arc<Shared>,
    rx: mpsc::Receiver<Msg>,
    on_event: Box<dyn Fn(TermEvent)>,
    ready: mpsc::SyncSender<Result<(), TermError>>,
) {
    let mut session = Session::new(&opts, pty, shared, on_event);
    if !history.is_empty() {
        let mut text = history.replace("\r\n", "\n").replace('\n', "\r\n");
        if !text.ends_with("\r\n") {
            text.push_str("\r\n");
        }
        session.feed(text.as_bytes());
    }
    let _ = ready.send(Ok(()));
    session.run(&rx);
    session.shutdown(&rx);
}
