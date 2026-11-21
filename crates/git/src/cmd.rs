//! Spawning `git` with a predictable environment.

use std::ffi::{OsStr, OsString};
use std::io::Write;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::{GitError, Result};

/// Variables that would redirect git away from the repository at `cwd`.
const REPO_OVERRIDES: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
];

pub(crate) struct Output {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.code == 0
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).trim_end_matches(['\n', '\r']).to_string()
    }
}

pub(crate) struct Cmd<'a> {
    cwd: &'a Path,
    args: Vec<OsString>,
    envs: Vec<(OsString, OsString)>,
    stdin: Option<Vec<u8>>,
    read_only: bool,
    user_facing: bool,
}

impl<'a> Cmd<'a> {
    pub fn new(cwd: &'a Path, subcommand: &str) -> Self {
        Cmd {
            cwd,
            args: vec![subcommand.into()],
            envs: Vec::new(),
            stdin: None,
            read_only: false,
            user_facing: false,
        }
    }

    pub fn arg(mut self, arg: impl AsRef<OsStr>) -> Self {
        self.args.push(arg.as_ref().to_os_string());
        self
    }

    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.args.extend(args.into_iter().map(|a| a.as_ref().to_os_string()));
        self
    }

    pub fn env(mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> Self {
        self.envs.push((key.as_ref().to_os_string(), value.as_ref().to_os_string()));
        self
    }

    pub fn stdin(mut self, data: impl Into<Vec<u8>>) -> Self {
        self.stdin = Some(data.into());
        self
    }

    /// A command that only reads: git must not take locks to refresh the
    /// index in the background while the user's own git commands run.
    pub fn read(mut self) -> Self {
        self.read_only = true;
        self
    }

    /// A command that runs the user's hooks (commit, merge, switch, worktree
    /// add). Its output is not parsed, so nothing of ours (locale, config
    /// overrides) is put into the environment the hooks inherit.
    pub fn user_facing(mut self) -> Self {
        self.user_facing = true;
        self
    }

    fn label(&self) -> String {
        self.args[0].to_string_lossy().into_owned()
    }

    /// Runs git and returns whatever it exited with.
    pub fn output(self) -> Result<Output> {
        let mut command = Command::new("git");
        command.current_dir(self.cwd);
        for var in REPO_OVERRIDES {
            command.env_remove(var);
        }
        if !self.user_facing {
            command.args(["--no-pager", "-c", "core.quotepath=off", "-c", "color.ui=never"]);
            command.env("LC_ALL", "C");
            command.env("GIT_PAGER", "cat");
            command.env("GIT_EDITOR", "true");
            command.env("GIT_TERMINAL_PROMPT", "0");
            // Paths come from file listings, never from a user typing globs.
            command.env("GIT_LITERAL_PATHSPECS", "1");
        }
        if self.read_only {
            command.env("GIT_OPTIONAL_LOCKS", "0");
        }
        #[cfg(test)]
        for (key, value) in crate::tests::ISOLATED_ENV {
            command.env(key, value);
        }
        command.envs(self.envs.iter().map(|(k, v)| (k, v)));
        command.args(&self.args);
        command.stdin(if self.stdin.is_some() { Stdio::piped() } else { Stdio::null() });
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());

        let mut child = command.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound && self.cwd.is_dir() {
                GitError::GitNotFound
            } else {
                GitError::Io(format!("{}: {e}", self.cwd.display()))
            }
        })?;

        // Fed from another thread: git may fill its stdout pipe before it
        // has read all of a large patch.
        let writer = self.stdin.map(|data| {
            let mut pipe = child.stdin.take().expect("stdin was piped");
            std::thread::spawn(move || {
                let _ = pipe.write_all(&data);
            })
        });
        let out = child.wait_with_output().map_err(|e| GitError::Io(e.to_string()))?;
        if let Some(writer) = writer {
            let _ = writer.join();
        }

        Ok(Output {
            // Killed by a signal: report as a generic failure.
            code: out.status.code().unwrap_or(-1),
            stdout: out.stdout,
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        })
    }

    /// Runs git and fails unless it exits with 0.
    pub fn run(self) -> Result<Output> {
        let label = self.label();
        let out = self.output()?;
        if out.ok() { Ok(out) } else { Err(failure(&label, &out)) }
    }
}

pub(crate) fn failure(command: &str, out: &Output) -> GitError {
    let stderr = if out.stderr.is_empty() {
        let stdout = out.text();
        if stdout.is_empty() { format!("exit status {}", out.code) } else { stdout }
    } else {
        out.stderr.clone()
    };
    GitError::Command {
        command: command.to_string(),
        stderr,
    }
}

pub(crate) fn path_from_bytes(bytes: &[u8]) -> PathBuf {
    PathBuf::from(OsString::from_vec(bytes.to_vec()))
}

pub(crate) fn path_bytes(path: &Path) -> &[u8] {
    path.as_os_str().as_bytes()
}

/// NUL-separated list for `--pathspec-from-file=- --pathspec-file-nul`.
pub(crate) fn nul_list<P: AsRef<Path>>(paths: &[P]) -> Vec<u8> {
    let mut out = Vec::new();
    for path in paths {
        out.extend_from_slice(path_bytes(path.as_ref()));
        out.push(0);
    }
    out
}

pub(crate) fn split_nul(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    bytes.split(|b| *b == 0).filter(|part| !part.is_empty())
}
