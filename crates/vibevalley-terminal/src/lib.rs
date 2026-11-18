//! Terminal core: one OS thread per session owning a libghostty-vt `Terminal`
//! and its PTY. The UI only ever sees [`TermSession`] (a cheap, cloneable,
//! `Send + Sync` handle) and immutable [`Snapshot`]s.
//!
//! CONTRACT: the items in this file are the public API other crates compile
//! against. The owner may add items; do not rename or remove existing ones.

use std::os::fd::AsRawFd;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;

mod input;
mod pty;
mod screen;
mod session;

use session::{Msg, Shared};

#[derive(Debug, thiserror::Error)]
pub enum TermError {
    #[error("failed to spawn pty: {0}")]
    Spawn(String),
    #[error("terminal backend error: {0}")]
    Backend(String),
    #[error("session has exited")]
    Exited,
}

pub type Result<T> = std::result::Result<T, TermError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TermSize {
    pub cols: u16,
    pub rows: u16,
    pub cell_width_px: u16,
    pub cell_height_px: u16,
}

#[derive(Debug, Clone)]
pub struct SpawnOptions {
    pub cwd: PathBuf,
    /// `None` = the user's login shell.
    pub program: Option<String>,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub size: TermSize,
    pub scrollback_lines: usize,
    pub theme: Theme,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct Rgb(pub u8, pub u8, pub u8);

/// Colors the backend resolves palette indices and defaults against.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Theme {
    pub foreground: Rgb,
    pub background: Rgb,
    pub cursor: Rgb,
    pub selection: Rgb,
    /// The 16 ANSI colors.
    pub ansi: [Rgb; 16],
}

/// All colors are already resolved to RGB; `inverse` is already applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CellStyle {
    pub fg: Rgb,
    /// `None` = theme background (lets the view skip painting it).
    pub bg: Option<Rgb>,
    pub bold: bool,
    pub italic: bool,
    pub dim: bool,
    pub underline: bool,
    pub strikethrough: bool,
}

/// A run of consecutive cells sharing one style. `text` holds the graphemes;
/// `cols` is the number of grid columns the run covers (wide chars count 2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    pub start_col: u16,
    pub cols: u16,
    pub text: String,
    pub style: CellStyle,
    pub hyperlink: Option<Arc<str>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub runs: Vec<Run>,
    /// True when this row soft-wraps into the next one.
    pub wrapped: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CursorShape {
    Block,
    Bar,
    Underline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cursor {
    pub col: u16,
    pub row: u16,
    pub visible: bool,
    pub shape: CursorShape,
    pub blinking: bool,
}

/// A point in the visible viewport.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Point {
    pub row: u16,
    pub col: u16,
}

/// Immutable picture of the visible viewport. Rows are `Arc`ed so unchanged
/// rows are shared between consecutive snapshots.
#[derive(Debug, Clone)]
pub struct Snapshot {
    /// Increases every time the visible content changes.
    pub seq: u64,
    pub size: TermSize,
    pub rows: Vec<Arc<Row>>,
    pub cursor: Cursor,
    pub title: Option<String>,
    /// Lines scrolled up from the bottom (0 = following output).
    pub scroll_offset: usize,
    pub scrollback_len: usize,
    /// Normalized so `start <= end`, in viewport coordinates.
    pub selection: Option<(Point, Point)>,
    pub alt_screen: bool,
    /// The running program asked for mouse events.
    pub mouse_reporting: bool,
    /// On the alternate screen with alternate scroll on (DEC 1007) and no
    /// mouse reporting: the wheel should send cursor Up/Down keys.
    pub alternate_scroll: bool,
}

/// One shell command delimited by OSC 133 shell-integration marks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandBlock {
    pub id: u64,
    pub command: String,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone)]
pub enum TermEvent {
    /// A newer snapshot is available. Coalesced: at most one pending.
    Dirty,
    TitleChanged(String),
    CwdChanged(PathBuf),
    Bell,
    CommandStarted(CommandBlock),
    CommandFinished(CommandBlock),
    Exited {
        code: Option<i32>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Mods {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub cmd: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Key {
    /// A printable key; the string is the unmodified character.
    Char(String),
    Enter,
    Tab,
    Backspace,
    Escape,
    Delete,
    Insert,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    F(u8),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyInput {
    pub key: Key,
    pub mods: Mods,
    /// Text the platform produced for this key press, if any.
    pub text: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Middle,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseKind {
    Press(MouseButton),
    Release(MouseButton),
    Move,
    /// Positive = up.
    Wheel {
        lines: i32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MouseInput {
    pub kind: MouseKind,
    pub at: Point,
    pub mods: Mods,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectionMode {
    Cell,
    Word,
    Line,
}

/// Handle to a running terminal session. All methods are non-blocking: they
/// post a message to the session thread.
#[derive(Clone)]
pub struct TermSession {
    inner: Arc<Inner>,
}

struct Inner {
    tx: flume::Sender<Msg>,
    done: flume::Receiver<()>,
    shared: Arc<Shared>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        let _ = self.tx.send(Msg::Shutdown);
    }
}

impl TermSession {
    /// Starts the PTY and the session thread. `on_event` is called on the
    /// session thread; it must be cheap and must not block.
    pub fn spawn(opts: SpawnOptions, on_event: impl Fn(TermEvent) + Send + 'static) -> Result<TermSession> {
        let (tx, rx) = flume::unbounded();
        let (done_tx, done) = flume::bounded(1);
        let (pty, master_fd) = pty::spawn(&opts, tx.clone())?;
        let shared = Arc::new(Shared::new(opts.size, master_fd, pty.pid));
        let (ready_tx, ready_rx) = flume::bounded(1);
        let thread_shared = shared.clone();
        std::thread::Builder::new()
            .name("vibevalley-terminal".to_string())
            .spawn(move || {
                let _done = done_tx;
                session::run(opts, pty, thread_shared, rx, Box::new(on_event), ready_tx);
            })
            .map_err(|e| TermError::Spawn(e.to_string()))?;
        ready_rx
            .recv()
            .map_err(|_| TermError::Backend("session thread stopped during startup".into()))??;
        Ok(TermSession {
            inner: Arc::new(Inner { tx, done, shared }),
        })
    }

    /// Like `spawn`, but first writes `history` (plain text, `\n` line
    /// ends) into the terminal, so a restored session shows its earlier
    /// output above the new shell's prompt.
    pub fn spawn_with_history(opts: SpawnOptions, history: &str, on_event: impl Fn(TermEvent) + Send + 'static) -> Result<TermSession> {
        let (tx, rx) = flume::unbounded();
        let (done_tx, done) = flume::bounded(1);
        let (pty, master_fd) = pty::spawn(&opts, tx.clone())?;
        let shared = Arc::new(Shared::new(opts.size, master_fd, pty.pid));
        let (ready_tx, ready_rx) = flume::bounded(1);
        let thread_shared = shared.clone();
        let history = history.to_string();
        std::thread::Builder::new()
            .name("vibevalley-terminal".to_string())
            .spawn(move || {
                let _done = done_tx;
                session::run_with_history(opts, &history, pty, thread_shared, rx, Box::new(on_event), ready_tx);
            })
            .map_err(|e| TermError::Spawn(e.to_string()))?;
        ready_rx
            .recv()
            .map_err(|_| TermError::Backend("session thread stopped during startup".into()))??;
        Ok(TermSession {
            inner: Arc::new(Inner { tx, done, shared }),
        })
    }

    fn post(&self, msg: Msg) {
        let _ = self.inner.tx.send(msg);
    }

    fn ask<T>(&self, msg: impl FnOnce(flume::Sender<T>) -> Msg) -> Option<T> {
        let (tx, rx) = flume::bounded(1);
        self.post(msg(tx));
        rx.recv().ok()
    }

    /// Latest snapshot. Cheap; safe to call every frame.
    pub fn snapshot(&self) -> Arc<Snapshot> {
        // Cleared before reading so a snapshot published in between raises a
        // fresh `Dirty` instead of being missed.
        self.inner.shared.dirty_pending.store(false, Ordering::Release);
        self.inner.shared.snapshot.lock().unwrap().clone()
    }

    pub fn send_key(&self, key: KeyInput) {
        self.post(Msg::Key(key));
    }

    /// Committed IME text or other plain typed text.
    pub fn send_text(&self, text: &str) {
        self.post(Msg::Text(text.to_string()));
    }

    /// Paste; uses bracketed paste when the program enabled it.
    pub fn paste(&self, text: &str) {
        self.post(Msg::Paste(text.to_string()));
    }

    /// Forwards to the program when it enabled mouse reporting.
    pub fn send_mouse(&self, mouse: MouseInput) {
        self.post(Msg::Mouse(mouse));
    }

    pub fn resize(&self, size: TermSize) {
        self.post(Msg::Resize(size));
    }

    /// Positive = towards older output. On the alternate screen (no
    /// scrollback) this sends cursor-key presses to the program instead,
    /// unless the program reads the mouse itself.
    pub fn scroll_lines(&self, delta: i32) {
        self.post(Msg::ScrollLines(delta));
    }

    pub fn scroll_to_bottom(&self) {
        self.post(Msg::ScrollToBottom);
    }

    pub fn selection_start(&self, at: Point, mode: SelectionMode) {
        self.post(Msg::SelectionStart(at, mode));
    }

    pub fn selection_extend(&self, at: Point) {
        self.post(Msg::SelectionExtend(at));
    }

    pub fn selection_clear(&self) {
        self.post(Msg::SelectionClear);
    }

    /// Blocking round-trip to the session thread.
    pub fn selection_text(&self) -> Option<String> {
        self.ask(Msg::SelectionText).flatten()
    }

    pub fn set_theme(&self, theme: Theme) {
        self.post(Msg::SetTheme(theme));
    }

    /// Whether Alt (macOS Option) acts as Meta, i.e. Alt+key sends ESC-prefixed
    /// input instead of the character the platform composed. Default: true.
    pub fn set_option_as_alt(&self, enabled: bool) {
        self.post(Msg::OptionAsAlt(enabled));
    }

    /// The directory the shell reported (OSC 7), else the working directory
    /// of the PTY's foreground process.
    pub fn cwd(&self) -> Option<PathBuf> {
        let shared = &self.inner.shared;
        if let Some(cwd) = shared.cwd.lock().unwrap().clone() {
            return Some(cwd);
        }
        let foreground = shared.master_fd.lock().unwrap().as_ref().and_then(|fd| pty::foreground_pgid(fd.as_raw_fd()));
        foreground
            .and_then(pty::process_cwd)
            .or_else(|| self.is_alive().then_some(shared.shell_pid?).and_then(pty::process_cwd))
    }

    /// Plain text of the last `max_lines` lines of scrollback plus screen,
    /// used to persist and restore a session. Blocking round-trip.
    pub fn scrollback_text(&self, max_lines: usize) -> String {
        self.ask(|reply| Msg::ScrollbackText(max_lines, reply)).unwrap_or_default()
    }

    /// Plain-text output of a finished command block. Blocking round-trip.
    pub fn command_output(&self, block_id: u64) -> Option<String> {
        self.ask(|reply| Msg::CommandOutput(block_id, reply)).flatten()
    }

    /// True when something other than the shell is in the foreground.
    pub fn has_foreground_process(&self) -> bool {
        let shared = &self.inner.shared;
        if !self.is_alive() {
            return false;
        }
        let foreground = shared.master_fd.lock().unwrap().as_ref().and_then(|fd| pty::foreground_pgid(fd.as_raw_fd()));
        matches!((foreground, shared.shell_pid), (Some(fg), Some(shell)) if fg != shell)
    }

    pub fn is_alive(&self) -> bool {
        self.inner.shared.alive.load(Ordering::Acquire)
    }

    pub fn kill(&self) {
        self.post(Msg::Kill);
    }

    /// Stops the session thread, reaps its PTY child, and waits up to `timeout`
    /// for teardown to finish.
    pub fn shutdown_and_wait(&self, timeout: std::time::Duration) {
        self.post(Msg::Shutdown);
        let _ = self.inner.done.recv_timeout(timeout);
    }
}

#[cfg(test)]
mod shutdown_tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn shutdown_and_wait_reaps_child_and_marks_session_stopped() {
        let session = TermSession::spawn(
            SpawnOptions {
                cwd: std::env::temp_dir(),
                program: Some("/bin/sh".into()),
                args: vec!["-c".into(), "sleep 30".into()],
                env: Vec::new(),
                size: TermSize {
                    cols: 80,
                    rows: 24,
                    cell_width_px: 8,
                    cell_height_px: 16,
                },
                scrollback_lines: 100,
                theme: Theme {
                    foreground: Rgb(220, 220, 220),
                    background: Rgb(20, 20, 20),
                    cursor: Rgb(255, 255, 255),
                    selection: Rgb(60, 80, 120),
                    ansi: [Rgb(0, 0, 0); 16],
                },
            },
            |_| {},
        )
        .expect("spawn sleep session");
        assert!(session.is_alive());
        session.shutdown_and_wait(Duration::from_secs(3));
        assert!(!session.is_alive());
    }
}
