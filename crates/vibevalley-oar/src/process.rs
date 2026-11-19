//! Finding agent binaries and running them as line-oriented child processes
//! on plain threads (no async runtime).

use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;

use crate::{AgentError, Installation, Result};

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
    let mut map = overrides().lock().unwrap_or_else(|e| e.into_inner());
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
    let chosen = overrides().lock().ok().and_then(|m| m.get(name).cloned()).or_else(|| env_override(name));
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

/// Runs a short command and returns its stdout; `None` on failure or timeout.
pub(crate) fn run_capture(binary: &Path, args: &[&str], timeout: Duration) -> Option<String> {
    run_capture_streams(binary, args, timeout, false).and_then(|(ok, text)| ok.then_some(text))
}

/// Exit status and output; `with_stderr` appends stderr (some CLIs print
/// their status there). `None` when it could not run or timed out.
pub(crate) fn run_capture_streams(binary: &Path, args: &[&str], timeout: Duration, with_stderr: bool) -> Option<(bool, String)> {
    let mut child = Command::new(binary)
        .args(args)
        .env("PATH", child_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(if with_stderr { Stdio::piped() } else { Stdio::null() })
        .spawn()
        .ok()?;
    let errors = child.stderr.take().map(|mut stderr| {
        std::thread::spawn(move || {
            let mut text = String::new();
            let _ = stderr.read_to_string(&mut text);
            text
        })
    });
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        text
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut text = reader.join().ok()?;
                if let Some(errors) = errors {
                    text.push_str(&errors.join().unwrap_or_default());
                }
                return Some((status.success(), text));
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
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
            let mut file = file.lock().unwrap_or_else(|p| p.into_inner());
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
    pub options: Option<&'a crate::SessionOptions>,
    pub env_remove: &'a [&'a str],
}

/// A child process spoken to in lines. The reader runs on its own thread and
/// owns the callbacks; `on_exit` runs exactly once, after the last line.
pub(crate) struct LineChild {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    pid: u32,
    killed: AtomicBool,
    pub(crate) trace: Arc<Trace>,
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
        let mut child = command
            .spawn()
            .map_err(|e| AgentError::NotAvailable(format!("cannot start {}: {e}", spec.binary.display())))?;
        let pid = child.id();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or_else(|| AgentError::Io("child has no stdout".into()))?;
        let stderr = child.stderr.take();
        let trace = Arc::new(Trace::open(spec.label, pid));
        let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
        let this = Arc::new(Self {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            stderr_tail: stderr_tail.clone(),
            pid,
            killed: AtomicBool::new(false),
            trace: trace.clone(),
        });

        let stderr_thread = stderr.map(|stderr| {
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(|l| l.ok()) {
                    let mut tail = stderr_tail.lock().unwrap_or_else(|p| p.into_inner());
                    if tail.len() == 40 {
                        tail.pop_front();
                    }
                    tail.push_back(line);
                }
            })
        });

        let reader = this.clone();
        std::thread::Builder::new()
            .name(format!("vibevalley-agent-{}", spec.label))
            .spawn(move || {
                let mut lines = BufReader::new(stdout);
                let mut buffer = Vec::new();
                loop {
                    buffer.clear();
                    match lines.read_until(b'\n', &mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let line = String::from_utf8_lossy(&buffer);
                            let line = line.trim();
                            if !line.is_empty() {
                                trace.log("recv", line);
                                on_line(line);
                            }
                        }
                    }
                }
                let code = reader.wait_exit();
                if let Some(thread) = stderr_thread {
                    let _ = thread.join();
                }
                on_exit(code, reader.stderr_text());
            })
            .map_err(|e| AgentError::Io(format!("cannot start reader thread: {e}")))?;
        Ok(this)
    }

    fn wait_exit(&self) -> Option<i32> {
        // Polled rather than `wait()`: `kill` needs the same lock.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            {
                let mut child = self.child.lock().unwrap_or_else(|p| p.into_inner());
                match child.try_wait() {
                    Ok(Some(status)) => return status.code(),
                    Ok(None) if Instant::now() > deadline => {
                        // stdout closed but the process lingers: it is of no use any more.
                        let _ = child.kill();
                    }
                    Ok(None) => {}
                    Err(_) => return None,
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    pub(crate) fn write_line(&self, line: &str) -> Result<()> {
        let mut stdin = self.stdin.lock().unwrap_or_else(|p| p.into_inner());
        let Some(pipe) = stdin.as_mut() else {
            return Err(AgentError::Io("the runtime's stdin is closed".into()));
        };
        self.trace.log("send", line);
        pipe.write_all(line.as_bytes())
            .and_then(|_| pipe.write_all(b"\n"))
            .and_then(|_| pipe.flush())
            .map_err(|e| AgentError::Io(format!("write to runtime failed: {e}")))
    }

    pub(crate) fn write_json(&self, value: &serde_json::Value) -> Result<()> {
        self.write_line(&value.to_string())
    }

    pub(crate) fn stderr_text(&self) -> String {
        let tail = self.stderr_tail.lock().unwrap_or_else(|p| p.into_inner());
        tail.iter().cloned().collect::<Vec<_>>().join("\n")
    }

    /// The group may outlive its leader while a tool still has our pipes open.
    pub(crate) fn status(&self) -> Option<(i32, String)> {
        use std::os::unix::process::ExitStatusExt;
        let status = self.child.lock().unwrap_or_else(|p| p.into_inner()).try_wait().ok()??;
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
        use nix::sys::signal::{Signal, killpg};
        use nix::unistd::Pid;
        if self.killed.swap(true, Ordering::SeqCst) {
            return;
        }
        let group = Pid::from_raw(self.pid as i32);
        let _ = killpg(group, Signal::SIGTERM);
        self.stdin.lock().unwrap_or_else(|p| p.into_inner()).take();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let _ = self.child.lock().unwrap_or_else(|p| p.into_inner()).try_wait();
            if killpg(group, None) == Err(nix::errno::Errno::ESRCH) {
                return;
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = killpg(group, Signal::SIGKILL);
        let _ = self.child.lock().unwrap_or_else(|p| p.into_inner()).wait();
    }
}
