//! Running checks: the project's own `.vibevalley/check` script before an issue
//! merges or pushes, and a child's check command before it merges into its parent.
//! Failures return the last 40 lines of output.

use std::path::Path;
use std::time::Duration;

const TAIL_LINES: usize = 40;
const DEFAULT_CHECK_TIMEOUT: Duration = Duration::from_secs(600);

/// Result of running `.vibevalley/check` asynchronously with timeout and `node_modules/.bin` on `PATH`.
pub enum ScriptOutcome {
    NotConfigured,
    Passed,
    TimedOut(Duration),
    Exited { code: i32, output: String },
    Failed(String),
}

fn path_with_local_bins(cwd: &Path) -> String {
    let inherited = std::env::var("PATH").unwrap_or_default();
    let mut path: Vec<String> = vec![cwd.join("node_modules").join(".bin").display().to_string()];
    path.extend(inherited.split(':').filter(|p| !p.contains("node_modules/.bin")).map(str::to_string));
    path.join(":")
}

async fn run_with_timeout(mut cmd: tokio::process::Command, cwd: &Path, limit: Duration) -> ScriptOutcome {
    cmd.current_dir(cwd).env("PATH", path_with_local_bins(cwd)).kill_on_drop(true);
    match vibevalley_runtime::oar::run_output_with_timeout(cmd, limit, None).await {
        Ok(o) if o.timed_out => ScriptOutcome::TimedOut(limit),
        Ok(o) if o.success() => ScriptOutcome::Passed,
        Ok(o) => ScriptOutcome::Exited {
            code: o.code().unwrap_or(-1),
            output: format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)),
        },
        Err(e) => ScriptOutcome::Failed(e.to_string()),
    }
}

/// Runs `<cwd>/.vibevalley/check` asynchronously if present, respecting executable bit
/// (falling back to `sh <script>` when not marked executable) and `limit`.
pub async fn run_project_check_script(cwd: &Path, limit: Duration) -> ScriptOutcome {
    let script = cwd.join(".vibevalley").join("check");
    let Ok(meta) = tokio::fs::metadata(&script).await else {
        return ScriptOutcome::NotConfigured;
    };
    if !meta.is_file() {
        return ScriptOutcome::NotConfigured;
    }
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    };
    #[cfg(not(unix))]
    let executable = true;
    let cmd = if executable {
        tokio::process::Command::new(&script)
    } else {
        let mut sh = tokio::process::Command::new("sh");
        sh.arg(&script);
        sh
    };
    run_with_timeout(cmd, cwd, limit).await
}

/// Runs the project's check script when there is one.
pub async fn run_project_check(root: &Path) -> Result<bool, String> {
    match run_project_check_script(root, DEFAULT_CHECK_TIMEOUT).await {
        ScriptOutcome::NotConfigured => Ok(false),
        ScriptOutcome::Passed => Ok(true),
        ScriptOutcome::TimedOut(limit) => Err(format!(".vibevalley/check timed out ({}s)", limit.as_secs())),
        ScriptOutcome::Exited { output, .. } => Err(tail(&output, TAIL_LINES)),
        ScriptOutcome::Failed(why) => Err(format!("{} could not be run: {why}", root.join(".vibevalley/check").display())),
    }
}

/// Runs a shell command in `root` asynchronously.
pub async fn run_command(root: &Path, command: &str) -> Result<(), String> {
    let mut cmd = tokio::process::Command::new("sh");
    cmd.arg("-c").arg(command);
    match run_with_timeout(cmd, root, DEFAULT_CHECK_TIMEOUT).await {
        ScriptOutcome::Passed | ScriptOutcome::NotConfigured => Ok(()),
        ScriptOutcome::TimedOut(limit) => Err(format!("{command} timed out ({}s)", limit.as_secs())),
        ScriptOutcome::Exited { output, .. } => Err(tail(&output, TAIL_LINES)),
        ScriptOutcome::Failed(why) => Err(format!("{command} could not be run: {why}")),
    }
}

pub fn tail(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}
