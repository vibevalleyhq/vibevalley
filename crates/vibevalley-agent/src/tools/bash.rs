use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::truncate::{DEFAULT_MAX_BYTES, truncate_bytes};
use super::workspace::Workspace;
use super::{ReplayPolicy, ToolContext, ToolUpdate, TypedTool, TypedToolOutput};

const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(20);
const MAX_CAPTURE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct BashArgs {
    /// Shell command to run via /bin/bash in the workspace directory.
    pub command: String,
    /// Optional timeout in seconds overriding the workspace default.
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BashDetails {
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub truncated: bool,
}

enum WaitOutcome {
    Exited(ExitStatus),
    TimedOut,
    Cancelled,
}

pub struct Bash(pub Workspace);

impl TypedTool for Bash {
    type Args = BashArgs;
    type Details = BashDetails;

    fn name(&self) -> &'static str {
        "bash"
    }

    fn description(&self) -> &'static str {
        "Run a shell command in the working directory. Output is stdout and stderr together."
    }

    fn replay(&self) -> ReplayPolicy {
        ReplayPolicy::Unsafe
    }

    fn execute(&self, args: Self::Args, ctx: &ToolContext) -> Result<TypedToolOutput<Self::Details>, String> {
        if ctx.cancel.is_cancelled() {
            return Err("aborted by the user".into());
        }
        let timeout = args.timeout_secs.map(Duration::from_secs).unwrap_or(self.0.bash_timeout);
        let mut child = Command::new("/bin/bash")
            .arg("-c")
            // Merge stderr into stdout for the entire script, not just the final command.
            .arg(format!("exec 2>&1\n{}", args.command))
            .current_dir(&self.0.cwd)
            .envs(self.0.env.iter().cloned())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .map_err(|e| e.to_string())?;

        let pid = child.id();
        let stdout = child.stdout.take();
        let on_update = ctx.on_update.clone();
        let reader = std::thread::spawn(move || read_stream(stdout, on_update));

        let deadline = Instant::now() + timeout;
        let outcome = loop {
            if ctx.cancel.is_cancelled() {
                kill_process_group(pid);
                let _ = child.wait();
                break WaitOutcome::Cancelled;
            }
            match child.try_wait() {
                Ok(Some(status)) => break WaitOutcome::Exited(status),
                Ok(None) => {
                    if Instant::now() >= deadline {
                        kill_process_group(pid);
                        let _ = child.wait();
                        break WaitOutcome::TimedOut;
                    }
                    std::thread::sleep(CANCEL_POLL_INTERVAL);
                }
                Err(e) => {
                    kill_process_group(pid);
                    let _ = child.wait();
                    let _ = reader.join();
                    return Err(e.to_string());
                }
            }
        };

        let captured = reader.join().unwrap_or_default();
        if matches!(outcome, WaitOutcome::Cancelled) {
            return Err("aborted by the user".into());
        }

        let truncated = truncate_bytes(&captured, DEFAULT_MAX_BYTES);
        match outcome {
            WaitOutcome::Exited(status) if status.success() => Ok(TypedToolOutput::ok_with(
                truncated.text,
                BashDetails {
                    exit_code: status.code(),
                    timed_out: false,
                    truncated: truncated.truncated,
                },
            )),
            WaitOutcome::Exited(status) => {
                let code = status.code().unwrap_or(-1);
                Ok(TypedToolOutput {
                    text: format!("{}\n(exit status {code})", truncated.text),
                    details: Some(BashDetails {
                        exit_code: Some(code),
                        timed_out: false,
                        truncated: truncated.truncated,
                    }),
                    is_error: true,
                })
            }
            WaitOutcome::TimedOut => Ok(TypedToolOutput {
                text: format!("{}\n(timed out after {timeout:?})", truncated.text),
                details: Some(BashDetails {
                    exit_code: None,
                    timed_out: true,
                    truncated: truncated.truncated,
                }),
                is_error: true,
            }),
            WaitOutcome::Cancelled => unreachable!(),
        }
    }
}

fn read_stream(mut stdout: Option<std::process::ChildStdout>, on_update: Option<std::sync::Arc<dyn Fn(ToolUpdate) + Send + Sync>>) -> String {
    let Some(out) = stdout.as_mut() else {
        return String::new();
    };
    let mut captured = Vec::new();
    let mut pending_utf8 = Vec::new();
    let mut buf = [0u8; 4096];

    loop {
        match out.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let slice = &buf[..n];
                if captured.len() < MAX_CAPTURE_BYTES {
                    let take = (MAX_CAPTURE_BYTES - captured.len()).min(slice.len());
                    captured.extend_from_slice(&slice[..take]);
                }
                if let Some(cb) = &on_update {
                    pending_utf8.extend_from_slice(slice);
                    emit_valid_utf8(&mut pending_utf8, cb.as_ref());
                }
            }
        }
    }
    if let Some(cb) = &on_update
        && !pending_utf8.is_empty()
    {
        let tail = String::from_utf8_lossy(&pending_utf8).into_owned();
        if !tail.is_empty() {
            cb(ToolUpdate { text: tail });
        }
    }
    String::from_utf8_lossy(&captured).into_owned()
}

fn emit_valid_utf8(pending: &mut Vec<u8>, cb: &(dyn Fn(ToolUpdate) + Send + Sync)) {
    loop {
        match std::str::from_utf8(pending) {
            Ok(text) => {
                if !text.is_empty() {
                    cb(ToolUpdate { text: text.to_string() });
                }
                pending.clear();
                break;
            }
            Err(err) => {
                let valid = err.valid_up_to();
                if valid > 0 {
                    let text = std::str::from_utf8(&pending[..valid]).unwrap_or_default().to_string();
                    if !text.is_empty() {
                        cb(ToolUpdate { text });
                    }
                    pending.drain(..valid);
                    continue;
                }
                let Some(bad_len) = err.error_len() else {
                    break;
                };
                let text = String::from_utf8_lossy(&pending[..bad_len]).into_owned();
                if !text.is_empty() {
                    cb(ToolUpdate { text });
                }
                pending.drain(..bad_len);
            }
        }
    }
}

fn kill_process_group(pid: u32) {
    // Kill the entire group (-pgid) so subshells and pipelines terminate immediately.
    let _ = Command::new("/bin/kill").args(["-KILL", &format!("-{pid}")]).status();
}
