//! Finding agent binaries and running them as async `tokio::process` line-oriented
//! child processes with kqueue-driven waits and process-group reaping.

use std::collections::VecDeque;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use nix::errno::Errno;
use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use parking_lot::Mutex;
use serde_json::json;
use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex as AsyncMutex, Notify, oneshot, watch};

use crate::oar::{AgentError, Installation, Result};

const KILL_GRACE: Duration = Duration::from_secs(2);
const STDOUT_EOF_EXIT_GRACE: Duration = Duration::from_secs(5);
const CAPTURE_KILL_GRACE: Duration = Duration::from_millis(200);
const GRANDCHILD_SETTLE: Duration = Duration::from_millis(50);

/// Where CLIs get installed. An app started from Finder has a minimal PATH,
/// so these are searched after it and handed to the child as well (most of
/// these agents are node scripts that need `node` on PATH).
fn extra_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for sub in [
            ".local/bin",
            ".claude/local",
            ".opencode/bin",
            ".bun/bin",
            ".npm-global/bin",
            ".volta/bin",
            ".cargo/bin",
            ".local/share/mise/shims",
        ] {
            dirs.push(home.join(sub));
        }
    }
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs
}

fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    for dir in extra_dirs() {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

fn overrides() -> &'static Mutex<std::collections::HashMap<String, PathBuf>> {
    static MAP: std::sync::OnceLock<Mutex<std::collections::HashMap<String, PathBuf>>> = std::sync::OnceLock::new();
    MAP.get_or_init(Default::default)
}

pub(crate) fn set_binary(command: &str, path: Option<PathBuf>) {
    let mut map = overrides().lock();
    match path {
        Some(p) => map.insert(command.to_string(), p),
        None => map.remove(command),
    };
}

/// `OAR_<COMMAND>_BIN`, as VibeValley's oar reads it.
fn env_override(name: &str) -> Option<PathBuf> {
    let key = format!("OAR_{}_BIN", name.to_ascii_uppercase().replace(['-', ':', '.'], "_"));
    std::env::var_os(key).filter(|v| !v.is_empty()).map(PathBuf::from)
}

pub(crate) fn find_binary(name: &str) -> Option<PathBuf> {
    let chosen = overrides().lock().get(name).cloned().or_else(|| env_override(name));
    if let Some(path) = chosen {
        return is_executable(&path).then_some(path);
    }
    let direct = Path::new(name);
    if direct.components().count() > 1 {
        return is_executable(direct).then(|| direct.to_path_buf());
    }
    search_dirs().into_iter().map(|dir| dir.join(name)).find(|candidate| is_executable(candidate))
}

fn child_path() -> std::ffi::OsString {
    std::env::join_paths(search_dirs()).unwrap_or_default()
}

fn pgid_of(pid: u32) -> Option<Pid> {
    i32::try_from(pid).ok().filter(|&p| p > 0).map(Pid::from_raw)
}

async fn reap_process_group(child: &mut Child, pid: u32, grace: Duration) -> Option<ExitStatus> {
    let Some(pgid) = pgid_of(pid) else {
        let _ = child.kill().await;
        return child.wait().await.ok();
    };
    let _ = killpg(pgid, Signal::SIGTERM);
    let leader_status = match tokio::time::timeout(grace, child.wait()).await {
        Ok(res) => Some(res.ok()),
        Err(_) => None,
    };
    if let Some(status) = leader_status {
        if killpg(pgid, None) != Err(Errno::ESRCH) {
            tokio::time::sleep(GRANDCHILD_SETTLE).await;
            if killpg(pgid, None) != Err(Errno::ESRCH) {
                let _ = killpg(pgid, Signal::SIGKILL);
            }
        }
        return status;
    }
    let _ = killpg(pgid, Signal::SIGKILL);
    child.wait().await.ok()
}

/// Runs a short command and returns its stdout; `None` on failure or timeout.
pub(crate) fn run_capture(binary: &Path, args: &[&str], timeout: Duration) -> Option<String> {
    run_capture_streams(binary, args, timeout, false).and_then(|(ok, text)| ok.then_some(text))
}

/// Exit status and output; `with_stderr` appends stderr (some CLIs print
/// their status there). `None` when it could not run or timed out.
pub(crate) fn run_capture_streams(binary: &Path, args: &[&str], timeout: Duration, with_stderr: bool) -> Option<(bool, String)> {
    let binary = binary.to_path_buf();
    let owned_args: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
    crate::rt::block_on(async move {
        let mut child = Command::new(&binary)
            .args(&owned_args)
            .env("PATH", child_path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(if with_stderr { Stdio::piped() } else { Stdio::null() })
            .process_group(0)
            .spawn()
            .ok()?;
        let pid = child.id().unwrap_or(0);
        let mut stdout = child.stdout.take()?;
        let stderr = child.stderr.take();

        let stdout_task = crate::rt::spawn(async move {
            let mut bytes = Vec::new();
            let _ = stdout.read_to_end(&mut bytes).await;
            String::from_utf8_lossy(&bytes).into_owned()
        });
        let stderr_task = stderr.map(|mut err| {
            crate::rt::spawn(async move {
                let mut bytes = Vec::new();
                let _ = err.read_to_end(&mut bytes).await;
                String::from_utf8_lossy(&bytes).into_owned()
            })
        });

        let wait_result = tokio::time::timeout(timeout, child.wait()).await;
        match wait_result {
            Ok(Ok(status)) => {
                let mut text = stdout_task.await.ok()?;
                if let Some(err_task) = stderr_task {
                    text.push_str(&err_task.await.unwrap_or_default());
                }
                Some((status.success(), text))
            }
            _ => {
                let _ = reap_process_group(&mut child, pid, CAPTURE_KILL_GRACE).await;
                stdout_task.abort();
                if let Some(err_task) = stderr_task {
                    err_task.abort();
                }
                None
            }
        }
    })
}

/// `--version` probe shared by the CLI runtimes.
/// How to ask a CLI whether it is logged in: the arguments, and a reading of
/// (exit status, stdout + stderr) that says yes.
pub(crate) struct LoginCheck {
    pub args: &'static [&'static str],
    pub status: fn(bool, &str) -> LoginStatus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LoginStatus {
    SignedIn,
    SignedOut,
    Unknown,
}

pub(crate) fn probe_installation_with(name: &str, login: Option<&LoginCheck>) -> Installation {
    let Some(path) = find_binary(name) else {
        return Installation::NotInstalled;
    };
    let Some(output) = run_capture(&path, &["--version"], Duration::from_secs(15)) else {
        return Installation::Unusable {
            reason: format!("`{} --version` failed", path.display()),
        };
    };
    let version = output.lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_string);
    if let Some(check) = login {
        let status = run_capture_streams(&path, check.args, Duration::from_secs(15), true).map_or(LoginStatus::Unknown, |(ok, text)| (check.status)(ok, &text));
        match status {
            LoginStatus::SignedIn => {}
            LoginStatus::SignedOut => return Installation::LoginRequired { path },
            LoginStatus::Unknown => {
                return Installation::Unusable {
                    reason: format!("could not determine login status: run `{name} {}` to inspect the result", check.args.join(" ")),
                };
            }
        }
    }
    Installation::Available { version, path }
}

pub(crate) fn require_binary(name: &str) -> Result<PathBuf> {
    find_binary(name).ok_or_else(|| AgentError::NotAvailable(format!("`{name}` was not found on PATH")))
}

/// Raw wire capture for debugging and for refreshing test fixtures: with
/// `VIBEVALLEY_AGENTS_TRACE=<dir>` every line to and from a child is appended to
/// `<dir>/<label>-<pid>.jsonl` as `{"dir":"send"|"recv","line":...}`.
pub(crate) struct Trace {
    file: Option<Mutex<File>>,
}

impl Trace {
    fn open(label: &str, pid: u32) -> Self {
        let file = std::env::var_os("VIBEVALLEY_AGENTS_TRACE").and_then(|dir| {
            let dir = PathBuf::from(dir);
            std::fs::create_dir_all(&dir).ok()?;
            File::create(dir.join(format!("{}-{pid}.jsonl", label.replace([':', '/'], "-")))).ok()
        });
        Self { file: file.map(Mutex::new) }
    }

    pub(crate) fn log(&self, direction: &str, line: &str) {
        if let Some(file) = &self.file {
            let parsed = serde_json::from_str::<serde_json::Value>(line).unwrap_or_else(|_| json!(line));
            let mut file = file.lock();
            let _ = writeln!(file, "{}", json!({ "dir": direction, "line": parsed }));
        }
    }
}

pub(crate) struct Spawn<'a> {
    pub label: &'a str,
    pub binary: &'a Path,
    pub args: Vec<String>,
    pub cwd: &'a Path,
    pub env: &'a [(String, String)],
    pub options: Option<&'a crate::oar::SessionOptions>,
    pub env_remove: &'a [&'a str],
}

struct LineChildInner {
    stdin: AsyncMutex<Option<ChildStdin>>,
    stderr_tail: Mutex<VecDeque<String>>,
    exit_status: Mutex<Option<ExitStatus>>,
    pid: u32,
    exited: AtomicBool,
    killed: AtomicBool,
    kill_notify: Notify,
    exit_rx: watch::Receiver<Option<Option<ExitStatus>>>,
}

impl LineChildInner {
    fn stderr_text(&self) -> String {
        let tail = self.stderr_tail.lock();
        tail.iter().cloned().collect::<Vec<_>>().join("\n")
    }

    fn signal_kill(&self) {
        if let Some(pgid) = pgid_of(self.pid) {
            let _ = killpg(pgid, Signal::SIGTERM);
        }
        if let Ok(mut stdin) = self.stdin.try_lock() {
            stdin.take();
        }
        self.kill_notify.notify_one();
    }
}

/// A child process spoken to in lines, driven by `tokio::process` on the shared
/// async runtime. `on_exit` runs exactly once, after the last stdout line.
/// Dropping the last `Arc<LineChild>` triggers graceful PGID cleanup so no
/// orphan subprocesses survive crashes or aborts.
pub(crate) struct LineChild {
    inner: Arc<LineChildInner>,
    pub(crate) trace: Arc<Trace>,
}

impl Drop for LineChild {
    fn drop(&mut self) {
        if !self.inner.exited.load(Ordering::SeqCst) && !self.inner.killed.swap(true, Ordering::SeqCst) {
            self.inner.signal_kill();
        }
    }
}

impl LineChild {
    pub(crate) fn spawn(
        spec: Spawn<'_>,
        mut on_line: impl FnMut(&str) + Send + 'static,
        on_exit: impl FnOnce(Option<i32>, String) + Send + 'static,
    ) -> Result<Arc<Self>> {
        let mut command = Command::new(spec.binary);
        command
            .args(&spec.args)
            .current_dir(spec.cwd)
            .env("PATH", child_path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Its own group, so stopping it reaches the tools it started.
            .process_group(0);
        if let Some(opts) = spec.options {
            if let Some(base) = &opts.base_env {
                command.env_clear().envs(base.iter().map(|(k, v)| (k, v)));
            }
            for name in &opts.unset_env {
                command.env_remove(name);
            }
        }
        for name in spec.env_remove {
            command.env_remove(name);
        }
        for (name, value) in spec.env {
            command.env(name, value);
        }

        // Enter the shared runtime so `tokio::process::Command` registers its pipes and SIGCHLD driver.
        let mut child = {
            let _enter = crate::rt::handle().enter();
            command
                .spawn()
                .map_err(|e| AgentError::NotAvailable(format!("cannot start {}: {e}", spec.binary.display())))?
        };
        let pid = child.id().ok_or_else(|| AgentError::Io("spawned child has no pid".into()))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or_else(|| AgentError::Io("child has no stdout".into()))?;
        let stderr = child.stderr.take();
        let trace = Arc::new(Trace::open(spec.label, pid));
        let (exit_tx, exit_rx) = watch::channel(None);
        let (stdout_eof_tx, stdout_eof_rx) = oneshot::channel::<()>();

        let inner = Arc::new(LineChildInner {
            stdin: AsyncMutex::new(stdin),
            stderr_tail: Mutex::new(VecDeque::new()),
            exit_status: Mutex::new(None),
            pid,
            exited: AtomicBool::new(false),
            killed: AtomicBool::new(false),
            kill_notify: Notify::new(),
            exit_rx,
        });

        let this = Arc::new(Self {
            inner: inner.clone(),
            trace: trace.clone(),
        });

        // Task A: exclusively owns `Child` and reaps the process group on exit, kill, or stdout EOF.
        let reaper_inner = inner.clone();
        crate::rt::spawn(async move {
            let status = tokio::select! {
                res = child.wait() => {
                    let status = res.ok();
                    if reaper_inner.killed.load(Ordering::SeqCst)
                        && let Some(pgid) = pgid_of(pid)
                        && killpg(pgid, None) != Err(Errno::ESRCH)
                    {
                        tokio::time::sleep(GRANDCHILD_SETTLE).await;
                        if killpg(pgid, None) != Err(Errno::ESRCH) {
                            let _ = killpg(pgid, Signal::SIGKILL);
                        }
                    }
                    status
                }
                _ = reaper_inner.kill_notify.notified() => {
                    let status = reap_process_group(&mut child, pid, KILL_GRACE).await;
                    reaper_inner.stdin.lock().await.take();
                    status
                }
                _ = stdout_eof_rx => {
                    // stdout closed: wait for natural exit, an explicit kill, or a 5s grace cutoff.
                    tokio::select! {
                        res = child.wait() => res.ok(),
                        _ = reaper_inner.kill_notify.notified() => {
                            let status = reap_process_group(&mut child, pid, KILL_GRACE).await;
                            reaper_inner.stdin.lock().await.take();
                            status
                        }
                        _ = tokio::time::sleep(STDOUT_EOF_EXIT_GRACE) => {
                            let status = reap_process_group(&mut child, pid, Duration::from_millis(500)).await;
                            reaper_inner.stdin.lock().await.take();
                            status
                        }
                    }
                }
            };
            *reaper_inner.exit_status.lock() = status;
            reaper_inner.exited.store(true, Ordering::SeqCst);
            let _ = exit_tx.send(Some(status));
        });

        // Task B: captures the rolling 40-line stderr tail asynchronously.
        let stderr_task = stderr.map(|stderr| {
            let stderr_inner = inner.clone();
            crate::rt::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut tail = stderr_inner.stderr_tail.lock();
                    if tail.len() == 40 {
                        tail.pop_front();
                    }
                    tail.push_back(line);
                }
            })
        });

        // Task C: streams stdout lines into `on_line`, then waits for exit + stderr before `on_exit`.
        let reader_inner = inner.clone();
        crate::rt::spawn(async move {
            let mut lines = BufReader::new(stdout);
            let mut buffer = Vec::new();
            loop {
                buffer.clear();
                match lines.read_until(b'\n', &mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let line = String::from_utf8_lossy(&buffer);
                        let line = line.trim();
                        if !line.is_empty() {
                            trace.log("recv", line);
                            // `on_line` is synchronous and may re-entrantly call `LineChild::kill()`.
                            tokio::task::block_in_place(|| on_line(line));
                        }
                    }
                }
            }
            let _ = stdout_eof_tx.send(());
            let mut wait_rx = reader_inner.exit_rx.clone();
            let status = wait_rx.wait_for(Option::is_some).await.ok().and_then(|v| *v).flatten();
            if let Some(task) = stderr_task {
                let _ = task.await;
            }
            let stderr_text = reader_inner.stderr_text();
            tokio::task::block_in_place(|| on_exit(status.and_then(|s| s.code()), stderr_text));
        });

        Ok(this)
    }

    pub(crate) fn write_line(&self, line: &str) -> Result<()> {
        let inner = self.inner.clone();
        let trace = self.trace.clone();
        let owned = line.to_string();
        crate::rt::block_on(async move {
            let mut stdin = inner.stdin.lock().await;
            let Some(pipe) = stdin.as_mut() else {
                return Err(AgentError::Io("the runtime's stdin is closed".into()));
            };
            trace.log("send", &owned);
            pipe.write_all(owned.as_bytes())
                .await
                .map_err(|e| AgentError::Io(format!("write to runtime failed: {e}")))?;
            pipe.write_all(b"\n")
                .await
                .map_err(|e| AgentError::Io(format!("write to runtime failed: {e}")))?;
            pipe.flush().await.map_err(|e| AgentError::Io(format!("write to runtime failed: {e}")))
        })
    }

    pub(crate) fn write_json(&self, value: &serde_json::Value) -> Result<()> {
        self.write_line(&value.to_string())
    }

    pub(crate) fn stderr_text(&self) -> String {
        self.inner.stderr_text()
    }

    /// The group may outlive its leader while a tool still has our pipes open.
    pub(crate) fn status(&self) -> Option<(i32, String)> {
        use std::os::unix::process::ExitStatusExt;
        let status = (*self.inner.exit_status.lock())?;
        let signal = status.signal().unwrap_or(0);
        let reason = match signal {
            0 => String::new(),
            2 => "interrupt".into(),
            9 => "killed".into(),
            15 => "terminated".into(),
            n => nix::sys::signal::Signal::try_from(n).map_or_else(|_| format!("signal {n}"), |s| s.as_str().to_string()),
        };
        Some((status.code().unwrap_or(128 + signal), reason))
    }

    pub(crate) fn kill(self: &Arc<Self>) {
        if self.inner.killed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.inner.signal_kill();
        let mut rx = self.inner.exit_rx.clone();
        crate::rt::block_on(async move {
            let _ = rx.wait_for(Option::is_some).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wait_until_dead(pid: i32, timeout: Duration) {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            if nix::sys::signal::kill(Pid::from_raw(pid), None) == Err(Errno::ESRCH) {
                return;
            }
            assert!(std::time::Instant::now() < deadline, "process {pid} still alive after {timeout:?}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn line_child_streams_lines_stderr_and_exit_status() {
        let (line_tx, line_rx) = flume::unbounded();
        let (exit_tx, exit_rx) = flume::bounded(1);
        let child = LineChild::spawn(
            Spawn {
                label: "test-stream",
                binary: Path::new("/bin/sh"),
                args: vec!["-c".into(), "echo first; echo errline >&2; echo second; exit 7".into()],
                cwd: Path::new("/tmp"),
                env: &[],
                options: None,
                env_remove: &[],
            },
            move |line| {
                let _ = line_tx.send(line.to_string());
            },
            move |code, stderr| {
                let _ = exit_tx.send((code, stderr));
            },
        )
        .unwrap();

        let (code, stderr) = exit_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let lines: Vec<String> = line_rx.try_iter().collect();
        assert_eq!(lines, vec!["first", "second"]);
        assert_eq!(code, Some(7));
        assert!(stderr.contains("errline"), "{stderr}");
        assert_eq!(child.status(), Some((7, String::new())));
    }

    #[test]
    fn line_child_kill_and_drop_reap_grandchild_process_groups() {
        // Explicit kill() reaps a grandchild even when SIGTERM is ignored by the shell.
        let (pid_tx, pid_rx) = flume::bounded(1);
        let child = LineChild::spawn(
            Spawn {
                label: "test-kill-pgid",
                binary: Path::new("/bin/sh"),
                args: vec!["-c".into(), "sleep 30 & echo $!; wait".into()],
                cwd: Path::new("/tmp"),
                env: &[],
                options: None,
                env_remove: &[],
            },
            move |line| {
                if let Ok(pid) = line.parse::<i32>() {
                    let _ = pid_tx.send(pid);
                }
            },
            |_, _| {},
        )
        .unwrap();
        let grandchild_pid = pid_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        child.kill();
        wait_until_dead(grandchild_pid, Duration::from_secs(2));

        // Dropping the last Arc<LineChild> without calling kill() also reaps the process group.
        let (drop_tx, drop_rx) = flume::bounded(1);
        let orphan = LineChild::spawn(
            Spawn {
                label: "test-drop-pgid",
                binary: Path::new("/bin/sh"),
                args: vec!["-c".into(), "sleep 30 & echo $!; wait".into()],
                cwd: Path::new("/tmp"),
                env: &[],
                options: None,
                env_remove: &[],
            },
            move |line| {
                if let Ok(pid) = line.parse::<i32>() {
                    let _ = drop_tx.send(pid);
                }
            },
            |_, _| {},
        )
        .unwrap();
        let orphan_grandchild = drop_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        drop(orphan);
        wait_until_dead(orphan_grandchild, Duration::from_secs(4));
    }

    #[test]
    fn run_capture_streams_times_out_and_reaps_process_group() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("probe.pid");
        let script = format!("sleep 30 & echo $! > {}; wait", pid_file.display());
        let res = run_capture_streams(Path::new("/bin/sh"), &["-c", &script], Duration::from_millis(150), true);
        assert!(res.is_none());
        if let Ok(raw) = std::fs::read_to_string(&pid_file)
            && let Ok(pid) = raw.trim().parse::<i32>()
        {
            wait_until_dead(pid, Duration::from_secs(2));
        }
    }
}
