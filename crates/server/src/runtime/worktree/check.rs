//! Running checks: the project's own check script before an issue merges
//! into the main branch, and a child's check command before it merges into
//! its parent. A failure returns the last 40 lines of output.

use std::path::Path;
use std::process::Command;

const TAIL_LINES: usize = 40;

/// Runs the project's check script when there is one.
pub fn run_project_check(root: &Path) -> Result<bool, String> {
    let script = root.join(".vibevalley/check");
    if !script.is_file() {
        return Ok(false);
    }
    let mut cmd = if is_executable(&script) {
        Command::new(&script)
    } else {
        let mut sh = Command::new("sh");
        sh.arg(&script);
        sh
    };
    run(cmd.current_dir(root), &script.to_string_lossy()).map(|()| true)
}

/// Runs a shell command in `root`.
pub fn run_command(root: &Path, command: &str) -> Result<(), String> {
    run(Command::new("sh").arg("-c").arg(command).current_dir(root), command)
}

fn run(cmd: &mut Command, what: &str) -> Result<(), String> {
    match cmd.output() {
        Err(e) => Err(format!("{what} could not be run: {e}")),
        Ok(out) if out.status.success() => Ok(()),
        Ok(out) => {
            let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
            Err(tail(&text, TAIL_LINES))
        }
    }
}

pub fn tail(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata().is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(_path: &Path) -> bool {
    true
}
