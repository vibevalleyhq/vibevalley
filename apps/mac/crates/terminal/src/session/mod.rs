//! The session thread: owns the `alacritty_terminal::Term` and PTY,
//! applies messages from handles, and publishes immutable snapshots.

mod engine;
mod osc;
mod runner;
mod selection;
mod shutdown;

#[cfg(test)]
mod tests;

use std::os::fd::OwnedFd;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, mpsc};

use crate::{Cursor, CursorShape, KeyInput, MouseInput, Point, SelectionMode, Snapshot, TermSize, Theme};

pub(crate) use runner::run_with_history;

pub(crate) enum Msg {
    Pty(Vec<u8>),
    PtyEof,
    ChildExited(Option<i32>),
    Key(KeyInput),
    Text(String),
    Paste(String),
    Mouse(MouseInput),
    Resize(TermSize),
    ScrollLines(i32),
    ScrollToBottom,
    SelectionStart(Point, SelectionMode),
    SelectionExtend(Point),
    SelectionClear,
    SelectionText(mpsc::SyncSender<Option<String>>),
    SetTheme(Theme),
    ScrollbackText(usize, mpsc::SyncSender<String>),
    CommandOutput(u64, mpsc::SyncSender<Option<String>>),
    OptionAsAlt(bool),
    Kill,
    Shutdown,
}

/// State shared between the session thread and its handles.
pub(crate) struct Shared {
    pub snapshot: Mutex<Arc<Snapshot>>,
    /// A `Dirty` event was delivered and `snapshot()` has not been called since.
    pub dirty_pending: AtomicBool,
    pub alive: AtomicBool,
    /// Working directory reported by the shell (OSC 7).
    pub cwd: Mutex<Option<PathBuf>>,
    /// Duplicate of the PTY master, for foreground-process queries.
    pub master_fd: Mutex<Option<OwnedFd>>,
    pub shell_pid: Option<i32>,
}

impl Shared {
    pub(crate) fn new(size: TermSize, master_fd: OwnedFd, shell_pid: Option<i32>) -> Self {
        Self {
            snapshot: Mutex::new(Arc::new(Snapshot {
                seq: 0,
                size,
                rows: Vec::new(),
                cursor: Cursor {
                    col: 0,
                    row: 0,
                    visible: false,
                    shape: CursorShape::Block,
                    blinking: false,
                },
                title: None,
                scroll_offset: 0,
                scrollback_len: 0,
                selection: None,
                alt_screen: false,
                mouse_reporting: false,
                alternate_scroll: false,
            })),
            dirty_pending: AtomicBool::new(false),
            alive: AtomicBool::new(true),
            cwd: Mutex::new(None),
            master_fd: Mutex::new(Some(master_fd)),
            shell_pid,
        }
    }
}
