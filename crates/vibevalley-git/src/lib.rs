//! git through the system `git` binary only (no git library). Every call
//! spawns `git` and parses its output, so hooks, signing and user config
//! behave exactly as in the user's terminal. All functions block; callers run
//! them on background threads.
//!
//! CONTRACT: the items in this file are the public API other crates compile
//! against. The owner may add items; do not rename or remove existing ones.

use std::path::PathBuf;

mod cmd;
mod diff;
mod repo;
pub use repo::{RawOutput, clone, init};
mod status;
mod verified_merge;
pub use verified_merge::{MergeRevision, VerifiedMerge};
#[cfg(test)]
mod tests;

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("git is not installed or not on PATH")]
    GitNotFound,
    #[error("not a git repository: {0}")]
    NotARepo(PathBuf),
    #[error("git {command} failed: {stderr}")]
    Command { command: String, stderr: String },
    #[error("could not parse git output: {0}")]
    Parse(String),
    #[error("io: {0}")]
    Io(String),
}

pub type Result<T> = std::result::Result<T, GitError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    Unmodified,
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Untracked,
    Ignored,
    Conflicted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusEntry {
    /// Relative to the repository root.
    pub path: PathBuf,
    pub orig_path: Option<PathBuf>,
    /// State of the index relative to HEAD. `Unmodified` for untracked and
    /// ignored files (nothing of them is staged); `Conflicted` on both sides
    /// for unmerged paths.
    pub index: Change,
    /// State of the working tree relative to the index.
    pub worktree: Change,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Status {
    /// `None` when HEAD is detached.
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub entries: Vec<StatusEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffTarget {
    /// Working tree vs index (unstaged changes).
    Unstaged,
    /// Index vs HEAD (staged changes).
    Staged,
    /// Working tree vs HEAD (everything uncommitted, incl. untracked files).
    Uncommitted,
    /// One commit vs its first parent.
    Commit(String),
    /// `from..to`. Either side may be any revision.
    Range { from: String, to: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    Context,
    Added,
    Removed,
    /// The "\ No newline at end of file" marker.
    NoNewline,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: LineKind,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
    /// Without the leading `+`/`-`/space and without the trailing newline.
    pub text: String,
    /// Byte ranges of `text` that changed within the line (word-level diff
    /// against the paired removed/added line). Empty when not paired.
    pub emphasis: Vec<std::ops::Range<usize>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDiff {
    pub old_path: Option<PathBuf>,
    pub new_path: Option<PathBuf>,
    pub change: Change,
    pub binary: bool,
    pub added: u32,
    pub removed: u32,
    pub hunks: Vec<Hunk>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Commit {
    pub id: String,
    pub short_id: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    /// Seconds since the Unix epoch.
    pub time: i64,
    pub summary: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Branch {
    pub name: String,
    pub is_head: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
    pub tip: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Worktree {
    pub path: PathBuf,
    pub branch: Option<String>,
    pub head: String,
    pub is_main: bool,
    pub locked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeCheck {
    /// Would merge cleanly (or fast-forward).
    Clean,
    UpToDate,
    Conflicts(Vec<PathBuf>),
}

/// A repository, identified by the root of one of its working trees.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repo {
    root: PathBuf,
}

/// A working-tree snapshot made by [`Repo::snapshot`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    /// The snapshot commit.
    pub id: String,
    /// The label as given to `snapshot`.
    pub label: String,
    /// Seconds since the Unix epoch.
    pub time: i64,
    /// Full ref name under `refs/vibevalley/snapshots/`.
    pub ref_name: String,
}
