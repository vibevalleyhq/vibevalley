use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use nix::errno::Errno;
use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt as _;
use tokio::process::Command;

use super::truncate::{DEFAULT_MAX_BYTES, truncate_bytes};
use super::workspace::Workspace;
use super::{ReplayPolicy, ToolContext, ToolUpdate, TypedTool, TypedToolOutput};

const MAX_CAPTURE_BYTES: usize = 4 * 1024 * 1024;
const KILL_GRACE: Duration = Duration::from_millis(150);

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

/// Ensures the spawned process group is reaped if the async future is dropped or unwinds early.
struct ProcessGroupGuard {
    pgid: Option<Pid>,
}

impl ProcessGroupGuard {
    fn new(pid: Option<u32>) -> Self {
        let pgid = pid.and_then(|p| i32::try_from(p).ok()).filter(|&p| p > 0).map(Pid::from_raw);
        Self { pgid }
    }

    fn disarm(&mut self) {
        self.pgid = None;
    }
}

impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        let Some(pgid) = self.pgid.take() else {
            return;
        };
        let _ = killpg(pgid, Signal::SIGTERM);
        crate::rt::spawn(async move {
            tokio::time::sleep(KILL_GRACE).await;
            if killpg(pgid, None) != Err(Errno::ESRCH) {
                let _ = killpg(pgid, Signal::SIGKILL);
            }
        });
    }
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
        let cwd = self.0.cwd.clone();
        let env = self.0.env.clone();
        let command = args.command;
        let cancel = ctx.cancel.clone();
        let on_update = ctx.on_update.clone();

        let (outcome, captured) = crate::rt::block_on(async move {
            let mut child = Command::new("/bin/bash")
                .arg("-c")
                // Merge stderr into stdout for the entire script, not just the final command.
                .arg(format!("exec 2>&1\n{command}"))
                .current_dir(&cwd)
                .envs(env)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .process_group(0)
                .spawn()
                .map_err(|e| e.to_string())?;

            let pid = child.id();
            let mut guard = ProcessGroupGuard::new(pid);
            let stdout = child.stdout.take();
            let reader = crate::rt::spawn(read_stream(stdout, on_update));

            let outcome = tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    crate::oar::reap_process_group(&mut child, pid.unwrap_or(0), KILL_GRACE).await;
                    guard.disarm();
                    WaitOutcome::Cancelled
                }
                status = child.wait() => {
                    guard.disarm();
                    match status {
                        Ok(status) => WaitOutcome::Exited(status),
                        Err(e) => {
                            crate::oar::reap_process_group(&mut child, pid.unwrap_or(0), KILL_GRACE).await;
                            let _ = reader.await;
                            return Err(e.to_string());
                        }
                    }
                }
                _ = tokio::time::sleep(timeout) => {
                    crate::oar::reap_process_group(&mut child, pid.unwrap_or(0), KILL_GRACE).await;
                    guard.disarm();
                    WaitOutcome::TimedOut
                }
            };

            let captured = reader.await.unwrap_or_default();
            Ok::<_, String>((outcome, captured))
        })?;

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

async fn read_stream(mut stdout: Option<tokio::process::ChildStdout>, on_update: Option<std::sync::Arc<dyn Fn(ToolUpdate) + Send + Sync>>) -> String {
    let Some(out) = stdout.as_mut() else {
        return String::new();
    };
    let mut captured = Vec::new();
    let mut pending_utf8 = Vec::new();
    let mut buf = [0u8; 4096];

    loop {
        match out.read(&mut buf).await {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_reaps_sigterm_ignoring_grandchild_in_process_group() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("grandchild.pid");
        let ws = Workspace {
            bash_timeout: Duration::from_millis(200),
            ..Workspace::new(dir.path())
        };
        let tool = Bash(ws);
        let cmd = format!("trap '' TERM; (trap '' TERM; sleep 30) & echo $! > {}; wait", pid_file.display());
        let out = tool
            .execute(
                BashArgs {
                    command: cmd,
                    timeout_secs: None,
                },
                &ToolContext::background(),
            )
            .unwrap();
        assert!(out.is_error);
        assert!(out.details.unwrap().timed_out);
        let pid: i32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
        // Wait briefly for the kernel to complete SIGKILL teardown on the grandchild.
        crate::rt::block_on(async {
            tokio::time::timeout(Duration::from_secs(1), async {
                while nix::sys::signal::kill(Pid::from_raw(pid), None) != Err(Errno::ESRCH) {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
        })
        .unwrap_or_else(|_| panic!("grandchild {pid} survived PGID reap"));
    }
}
