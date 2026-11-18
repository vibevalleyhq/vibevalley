//! Tools the model may call. Ported in spirit from VibeValley's
//! `packages/agent/src/core/tool.ts`: a JSON Schema plus `execute`; a tool
//! that changes things is not replayed after a crash.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::model::ToolSpec;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolOutput {
    pub text: String,
    pub is_error: bool,
}

impl ToolOutput {
    pub fn ok(text: impl Into<String>) -> ToolOutput {
        ToolOutput {
            text: text.into(),
            is_error: false,
        }
    }
    pub fn error(text: impl Into<String>) -> ToolOutput {
        ToolOutput {
            text: text.into(),
            is_error: true,
        }
    }
}

pub trait Tool: Send + Sync {
    fn spec(&self) -> ToolSpec;
    fn is_mcp(&self) -> bool {
        false
    }
    /// Safe to run again if the process died while it ran (reads only).
    fn replay_safe(&self) -> bool {
        false
    }
    fn execute(&self, args: &Value) -> ToolOutput;
}

/// Where coding tools work and what their shell sees.
#[derive(Debug, Clone)]
pub struct Workspace {
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub bash_timeout: Duration,
}

impl Workspace {
    pub fn new(cwd: impl Into<PathBuf>) -> Workspace {
        Workspace {
            cwd: cwd.into(),
            env: vec![],
            bash_timeout: Duration::from_secs(120),
        }
    }

    fn resolve(&self, path: &str) -> PathBuf {
        let p = Path::new(path);
        if p.is_absolute() { p.to_path_buf() } else { self.cwd.join(p) }
    }
}

fn arg<'a>(args: &'a Value, name: &str) -> Result<&'a str, ToolOutput> {
    args.get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| ToolOutput::error(format!("missing string argument `{name}`")))
}

const MAX_OUTPUT: usize = 30_000;

fn clip(text: String) -> String {
    if text.len() <= MAX_OUTPUT {
        return text;
    }
    let mut cut = MAX_OUTPUT;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}\n… ({} more bytes cut)", &text[..cut], text.len() - cut)
}

pub struct ReadFile(pub Workspace);
pub struct WriteFile(pub Workspace);
pub struct EditFile(pub Workspace);
pub struct Bash(pub Workspace);

impl Tool for ReadFile {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "read".into(),
            description: "Read a text file. Paths are relative to the working directory. Lines are numbered.".into(),
            parameters: json!({"type": "object", "properties": {
                "path": {"type": "string"},
                "offset": {"type": "integer", "description": "first line, 1-based"},
                "limit": {"type": "integer"}
            }, "required": ["path"]}),
        }
    }
    fn replay_safe(&self) -> bool {
        true
    }
    fn execute(&self, args: &Value) -> ToolOutput {
        let path = match arg(args, "path") {
            Ok(p) => self.0.resolve(p),
            Err(e) => return e,
        };
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) => return ToolOutput::error(format!("{}: {e}", path.display())),
        };
        let offset = args["offset"].as_u64().unwrap_or(1).max(1) as usize;
        let limit = args["limit"].as_u64().unwrap_or(2000) as usize;
        let lines: String = text
            .lines()
            .enumerate()
            .skip(offset - 1)
            .take(limit)
            .map(|(n, l)| format!("{:>6}\t{l}\n", n + 1))
            .collect();
        ToolOutput::ok(clip(lines))
    }
}

impl Tool for WriteFile {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "write".into(),
            description: "Create or overwrite a file with the given content.".into(),
            parameters: json!({"type": "object", "properties": {
                "path": {"type": "string"}, "content": {"type": "string"}
            }, "required": ["path", "content"]}),
        }
    }
    fn execute(&self, args: &Value) -> ToolOutput {
        let (path, content) = match (arg(args, "path"), arg(args, "content")) {
            (Ok(p), Ok(c)) => (self.0.resolve(p), c),
            (Err(e), _) | (_, Err(e)) => return e,
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match std::fs::write(&path, content) {
            Ok(()) => ToolOutput::ok(format!("wrote {} bytes to {}", content.len(), path.display())),
            Err(e) => ToolOutput::error(format!("{}: {e}", path.display())),
        }
    }
}

impl Tool for EditFile {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "edit".into(),
            description: "Replace exactly one occurrence of old_text with new_text in a file.".into(),
            parameters: json!({"type": "object", "properties": {
                "path": {"type": "string"}, "old_text": {"type": "string"}, "new_text": {"type": "string"}
            }, "required": ["path", "old_text", "new_text"]}),
        }
    }
    fn execute(&self, args: &Value) -> ToolOutput {
        let (path, old, new) = match (arg(args, "path"), arg(args, "old_text"), arg(args, "new_text")) {
            (Ok(p), Ok(o), Ok(n)) => (self.0.resolve(p), o, n),
            (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => return e,
        };
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) => return ToolOutput::error(format!("{}: {e}", path.display())),
        };
        match text.matches(old).count() {
            0 => ToolOutput::error("old_text was not found"),
            1 => match std::fs::write(&path, text.replacen(old, new, 1)) {
                Ok(()) => ToolOutput::ok(format!("edited {}", path.display())),
                Err(e) => ToolOutput::error(e.to_string()),
            },
            n => ToolOutput::error(format!("old_text occurs {n} times; include more context")),
        }
    }
}

impl Tool for Bash {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "bash".into(),
            description: "Run a shell command in the working directory. Output is stdout and stderr together.".into(),
            parameters: json!({"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}),
        }
    }
    fn execute(&self, args: &Value) -> ToolOutput {
        let command = match arg(args, "command") {
            Ok(c) => c,
            Err(e) => return e,
        };
        let mut child = match Command::new("/bin/bash")
            .arg("-c")
            // Merge for the whole script, not just its last command.
            .arg(format!("exec 2>&1\n{command}"))
            .current_dir(&self.0.cwd)
            .envs(self.0.env.iter().cloned())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => return ToolOutput::error(e.to_string()),
        };
        let mut out = child.stdout.take();
        let reader = std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(out) = out.as_mut() {
                use std::io::Read;
                let mut bytes = Vec::new();
                let _ = out.read_to_end(&mut bytes);
                text = String::from_utf8_lossy(&bytes).into_owned();
            }
            text
        });
        let deadline = Instant::now() + self.0.bash_timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
                _ => {
                    // The whole group, so pipelines and children stop too.
                    unsafe_kill_group(child.id());
                    let _ = child.wait();
                    break None;
                }
            }
        };
        let text = clip(reader.join().unwrap_or_default());
        match status {
            Some(s) if s.success() => ToolOutput::ok(text),
            Some(s) => ToolOutput::error(format!("{text}\n(exit status {})", s.code().unwrap_or(-1))),
            None => ToolOutput::error(format!("{text}\n(timed out after {:?})", self.0.bash_timeout)),
        }
    }
}

use std::os::unix::process::CommandExt;

fn unsafe_kill_group(pid: u32) {
    let _ = Command::new("/bin/kill").args(["-KILL", &format!("-{pid}")]).status();
}

/// read, write, edit and bash in one workspace.
pub fn coding_tools(ws: &Workspace) -> Vec<Box<dyn Tool>> {
    vec![
        Box::new(ReadFile(ws.clone())),
        Box::new(WriteFile(ws.clone())),
        Box::new(EditFile(ws.clone())),
        Box::new(Bash(ws.clone())),
    ]
}
