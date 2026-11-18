//! PTY plumbing: spawning, the reader/writer/waiter threads, and the few
//! process queries the session needs.

use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};

use portable_pty::{CommandBuilder, MasterPty, PtySize, SlavePty, native_pty_system};

use crate::session::Msg;
use crate::{Result, SpawnOptions, TermError, TermSize};

const READ_CHUNK: usize = 64 * 1024;
/// Bytes the reader may have queued for the session thread before it waits.
const MAX_OUTSTANDING: usize = 512 * 1024;

pub(crate) fn pty_size(size: TermSize) -> PtySize {
    PtySize {
        rows: size.rows.max(1),
        cols: size.cols.max(1),
        pixel_width: size.cols.saturating_mul(size.cell_width_px),
        pixel_height: size.rows.saturating_mul(size.cell_height_px),
    }
}

/// Backpressure between the reader thread and the session thread, so a flood
/// of output cannot queue without bound.
pub(crate) struct Budget {
    state: Mutex<(usize, bool)>,
    cv: Condvar,
}

impl Budget {
    fn new() -> Self {
        Self {
            state: Mutex::new((0, false)),
            cv: Condvar::new(),
        }
    }

    /// Returns false once the budget is closed.
    fn acquire(&self, n: usize) -> bool {
        let mut state = self.state.lock().unwrap();
        while state.0 >= MAX_OUTSTANDING && !state.1 {
            state = self.cv.wait(state).unwrap();
        }
        state.0 += n;
        !state.1
    }

    pub(crate) fn release(&self, n: usize) {
        let mut state = self.state.lock().unwrap();
        state.0 = state.0.saturating_sub(n);
        self.cv.notify_all();
    }

    fn close(&self) {
        self.state.lock().unwrap().1 = true;
        self.cv.notify_all();
    }
}

pub(crate) struct Pty {
    pub master: Box<dyn MasterPty + Send>,
    /// Kept open until the child exits: macOS discards output still buffered
    /// in the PTY when the last slave descriptor closes.
    pub slave: Option<Box<dyn SlavePty + Send>>,
    pub pid: Option<i32>,
    pub budget: Arc<Budget>,
    pub writer: flume::Sender<Vec<u8>>,
    /// Closing this end stops the reader and writer threads.
    wake: Option<OwnedFd>,
}

impl Pty {
    pub(crate) fn write(&self, bytes: Vec<u8>) {
        if !bytes.is_empty() {
            let _ = self.writer.send(bytes);
        }
    }

    pub(crate) fn resize(&self, size: TermSize) {
        let _ = self.master.resize(pty_size(size));
    }

    pub(crate) fn foreground_pgid(&self) -> Option<i32> {
        self.master.process_group_leader()
    }

    pub(crate) fn release_slave(&mut self) {
        self.slave = None;
    }

    pub(crate) fn shutdown(&mut self) {
        self.budget.close();
        self.wake = None;
        self.slave = None;
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn dup(fd: RawFd) -> std::io::Result<OwnedFd> {
    let new = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
    if new < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(new) })
}

fn pipe() -> std::io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    for fd in fds {
        unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
    }
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

fn spawn_err(e: impl std::fmt::Display) -> TermError {
    TermError::Spawn(e.to_string())
}

fn command(opts: &SpawnOptions) -> CommandBuilder {
    let mut cmd = match &opts.program {
        Some(program) => {
            let mut cmd = CommandBuilder::new(program);
            cmd.args(&opts.args);
            cmd
        }
        None if opts.args.is_empty() => CommandBuilder::new_default_prog(),
        None => {
            let shell = CommandBuilder::new_default_prog().get_shell();
            let mut cmd = CommandBuilder::new(shell);
            cmd.args(&opts.args);
            cmd
        }
    };
    cmd.cwd(&opts.cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "VibeValley");
    for (key, value) in &opts.env {
        cmd.env(key, value);
    }
    cmd
}

/// Opens the PTY, starts the child and the three helper threads. Returns the
/// PTY plus a duplicate of the master descriptor for the session handle.
pub(crate) fn spawn(opts: &SpawnOptions, tx: flume::Sender<Msg>) -> Result<(Pty, OwnedFd)> {
    let pair = native_pty_system().openpty(pty_size(opts.size)).map_err(spawn_err)?;
    let mut child = pair.slave.spawn_command(command(opts)).map_err(spawn_err)?;
    let pid = child.process_id().map(|pid| pid as i32);

    let master_fd = pair.master.as_raw_fd().ok_or_else(|| spawn_err("pty master has no file descriptor"))?;
    // O_NONBLOCK lives on the shared open file description, so one call
    // covers the reader and writer duplicates too.
    unsafe {
        let flags = libc::fcntl(master_fd, libc::F_GETFL);
        libc::fcntl(master_fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }
    let read_fd = dup(master_fd).map_err(spawn_err)?;
    let write_fd = dup(master_fd).map_err(spawn_err)?;
    let handle_fd = dup(master_fd).map_err(spawn_err)?;
    let (wake_r, wake_w) = pipe().map_err(spawn_err)?;
    let wake_r2 = dup(wake_r.as_raw_fd()).map_err(spawn_err)?;

    let budget = Arc::new(Budget::new());
    let (writer_tx, writer_rx) = flume::unbounded::<Vec<u8>>();

    let thread = |name: &str| std::thread::Builder::new().name(name.to_string());

    {
        let tx = tx.clone();
        let budget = budget.clone();
        thread("vibevalley-terminal-read")
            .spawn(move || read_loop(read_fd, wake_r, &budget, &tx))
            .map_err(spawn_err)?;
    }
    thread("vibevalley-terminal-write")
        .spawn(move || write_loop(write_fd, wake_r2, &writer_rx))
        .map_err(spawn_err)?;
    thread("vibevalley-terminal-wait")
        .spawn(move || {
            let code = child
                .wait()
                .ok()
                .and_then(|status| status.signal().is_none().then_some(status.exit_code() as i32));
            let _ = tx.send(Msg::ChildExited(code));
        })
        .map_err(spawn_err)?;

    Ok((
        Pty {
            master: pair.master,
            slave: Some(pair.slave),
            pid,
            budget,
            writer: writer_tx,
            wake: Some(wake_w),
        },
        handle_fd,
    ))
}

/// Waits until `fd` is ready for `events`. Returns false when the wake pipe
/// fired (shutdown) or polling failed.
fn wait_ready(fd: RawFd, events: libc::c_short, wake: RawFd) -> bool {
    loop {
        let mut fds = [
            libc::pollfd { fd, events, revents: 0 },
            libc::pollfd {
                fd: wake,
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        let n = unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) };
        if n < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return false;
        }
        if fds[1].revents != 0 {
            return false;
        }
        if fds[0].revents != 0 {
            return true;
        }
    }
}

fn read_loop(fd: OwnedFd, wake: OwnedFd, budget: &Budget, tx: &flume::Sender<Msg>) {
    let mut buf = vec![0u8; READ_CHUNK];
    loop {
        if !wait_ready(fd.as_raw_fd(), libc::POLLIN, wake.as_raw_fd()) {
            return;
        }
        let n = unsafe { libc::read(fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
        if n > 0 {
            let n = n as usize;
            if !budget.acquire(n) || tx.send(Msg::Pty(buf[..n].to_vec())).is_err() {
                return;
            }
            continue;
        }
        if n < 0 {
            match std::io::Error::last_os_error().kind() {
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted => continue,
                _ => {}
            }
        }
        // 0 or EIO: every slave descriptor is closed.
        let _ = tx.send(Msg::PtyEof);
        return;
    }
}

fn write_loop(fd: OwnedFd, wake: OwnedFd, rx: &flume::Receiver<Vec<u8>>) {
    while let Ok(bytes) = rx.recv() {
        let mut rest = &bytes[..];
        while !rest.is_empty() {
            let n = unsafe { libc::write(fd.as_raw_fd(), rest.as_ptr().cast(), rest.len()) };
            if n >= 0 {
                rest = &rest[n as usize..];
                continue;
            }
            match std::io::Error::last_os_error().kind() {
                std::io::ErrorKind::Interrupted => {}
                std::io::ErrorKind::WouldBlock => {
                    if !wait_ready(fd.as_raw_fd(), libc::POLLOUT, wake.as_raw_fd()) {
                        return;
                    }
                }
                _ => return,
            }
        }
    }
}

pub(crate) fn foreground_pgid(fd: RawFd) -> Option<i32> {
    match unsafe { libc::tcgetpgrp(fd) } {
        pgid if pgid > 0 => Some(pgid),
        _ => None,
    }
}

/// A negative `pid` signals that process group. 0 and -1 are refused: they
/// would hit our own group or every process we may signal.
pub(crate) fn signal(pid: i32, signal: libc::c_int) {
    if pid != 0 && pid != -1 {
        unsafe { libc::kill(pid, signal) };
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn process_cwd(pid: i32) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;

    let mut info = std::mem::MaybeUninit::<libc::proc_vnodepathinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    let written = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDVNODEPATHINFO, 0, info.as_mut_ptr().cast(), size) };
    if written < size {
        return None;
    }
    let info = unsafe { info.assume_init() };
    let path = unsafe { std::ffi::CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr().cast()) };
    let bytes = path.to_bytes();
    (!bytes.is_empty()).then(|| PathBuf::from(std::ffi::OsStr::from_bytes(bytes)))
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn process_cwd(pid: i32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
}
