use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::cmd::{Cmd, block_on, failure, nul_list, path_bytes, path_from_bytes, split_nul};
use crate::diff::{self, ParsedFile};
use crate::read;
use crate::{Branch, Change, Commit, DiffTarget, FileDiff, GitError, Hunk, LineKind, MergeCheck, Repo, Result, Snapshot, Status, Worktree, status};

const SNAPSHOT_REFS: &str = "refs/vibevalley/snapshots";
const PATHSPEC_STDIN: [&str; 2] = ["--pathspec-from-file=-", "--pathspec-file-nul"];

/// A private index file inside the git dir, so plumbing can stage things
/// without the user's index noticing. Removed on drop.
struct TempIndex {
    path: PathBuf,
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let mut lock = self.path.clone().into_os_string();
        lock.push(".lock");
        let _ = std::fs::remove_file(lock);
    }
}

/// Revisions and branch names are passed as plain arguments; one that starts
/// with `-` would be read as an option.
pub(crate) fn check_rev(command: &str, rev: &str) -> Result<()> {
    if rev.is_empty() || rev.starts_with('-') || rev.contains('\0') {
        return Err(GitError::Command {
            command: command.to_string(),
            stderr: format!("invalid revision or branch name: {rev:?}"),
        });
    }
    Ok(())
}

/// What a raw [`Repo::run`] / [`Repo::run_async`] exited with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawOutput {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl RawOutput {
    pub fn ok(&self) -> bool {
        self.code == 0
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).trim_end_matches(['\n', '\r']).to_string()
    }
}

/// `git init` at `dir` (created if missing), on `branch` when given.
pub async fn init_async(dir: &Path, branch: Option<&str>) -> Result<Repo> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| GitError::Io(format!("{}: {e}", dir.display())))?;
    let mut cmd = Cmd::new(dir, "init").arg("--quiet");
    if let Some(branch) = branch {
        check_rev("init", branch)?;
        cmd = cmd.arg(format!("--initial-branch={branch}"));
    }
    cmd.run_async().await?;
    Repo::discover_async(dir)
        .await?
        .ok_or_else(|| GitError::Parse(format!("{} is not a repository after init", dir.display())))
}

/// Synchronous wrapper around [`init_async`].
pub fn init(dir: &Path, branch: Option<&str>) -> Result<Repo> {
    block_on(init_async(dir, branch))
}

/// `git clone <url> <dest>`; `dest` must not exist yet. Never prompts for
/// credentials (a private repo without them fails).
pub async fn clone_async(url: &str, dest: &Path) -> Result<Repo> {
    if url.starts_with('-') {
        return Err(GitError::Parse(format!("not a repository address: {url}")));
    }
    let parent = dest.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| GitError::Io(format!("{}: {e}", parent.display())))?;
    Cmd::new(parent, "clone")
        .args(["--quiet", "--end-of-options"])
        .arg(url)
        .arg(dest)
        .run_async()
        .await?;
    Repo::discover_async(dest)
        .await?
        .ok_or_else(|| GitError::Parse(format!("{} is not a repository after clone", dest.display())))
}

/// Synchronous wrapper around [`clone_async`].
pub fn clone(url: &str, dest: &Path) -> Result<Repo> {
    block_on(clone_async(url, dest))
}

async fn read_blocking<T, F>(f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| GitError::Io(format!("spawn_blocking failed: {e}")))?
}

impl Repo {
    /// Finds the repository containing `path` using pure-Rust `.git` discovery. `Ok(None)` when there is none.
    pub fn discover(path: &Path) -> Result<Option<Repo>> {
        Ok(read::discover_root(path)?.map(|root| Repo { root }))
    }

    /// Async wrapper around [`Repo::discover`].
    pub async fn discover_async(path: &Path) -> Result<Option<Repo>> {
        let path = path.to_path_buf();
        read_blocking(move || Self::discover(&path)).await
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn from_root(root: PathBuf) -> Self {
        Repo { root }
    }

    pub(crate) fn git(&self, subcommand: &str) -> Cmd<'_> {
        Cmd::new(&self.root, subcommand)
    }

    async fn rev_parse_async(&self, rev: &str) -> Result<Option<String>> {
        let out = self
            .git("rev-parse")
            .args(["--verify", "--quiet", "--end-of-options"])
            .arg(rev)
            .read()
            .output_async()
            .await?;
        Ok(if out.ok() { Some(out.text()) } else { None })
    }

    /// The commit HEAD points at; `None` before the first commit (pure Rust).
    pub fn head(&self) -> Result<Option<String>> {
        read::head(&self.root)
    }

    /// Async wrapper around [`Repo::head`].
    pub async fn head_async(&self) -> Result<Option<String>> {
        let root = self.root.clone();
        read_blocking(move || read::head(&root)).await
    }

    /// Current checked-out branch name, or `None` when detached (pure Rust).
    pub fn current_branch(&self) -> Result<Option<String>> {
        read::head_branch(&self.root)
    }

    /// Async wrapper around [`Repo::current_branch`].
    pub async fn current_branch_async(&self) -> Result<Option<String>> {
        let root = self.root.clone();
        read_blocking(move || read::head_branch(&root)).await
    }

    /// Whether local branch `branch` exists (pure Rust).
    pub fn branch_exists(&self, branch: &str) -> Result<bool> {
        read::branch_exists(&self.root, branch)
    }

    /// Async wrapper around [`Repo::branch_exists`].
    pub async fn branch_exists_async(&self, branch: &str) -> Result<bool> {
        let root = self.root.clone();
        let branch = branch.to_string();
        read_blocking(move || read::branch_exists(&root, &branch)).await
    }

    /// URL of remote `name` from `.git/config` (pure Rust).
    pub fn remote_url(&self, name: &str) -> Result<Option<String>> {
        read::remote_url(&self.root, name)
    }

    /// Async wrapper around [`Repo::remote_url`].
    pub async fn remote_url_async(&self, name: &str) -> Result<Option<String>> {
        let root = self.root.clone();
        let name = name.to_string();
        read_blocking(move || read::remote_url(&root, &name)).await
    }

    /// Reads a global git config value without spawning `git`.
    pub fn global_config_value(section: &str, key: &str) -> Result<Option<String>> {
        read::global_config_value(section, key)
    }

    pub(crate) async fn require_commit_async(&self, command: &str, rev: &str) -> Result<String> {
        check_rev(command, rev)?;
        self.rev_parse_async(&format!("{rev}^{{commit}}")).await?.ok_or_else(|| GitError::Command {
            command: command.to_string(),
            stderr: format!("unknown revision: {rev}"),
        })
    }

    /// Resolves `rev` to a commit SHA, using pure-Rust fast path first and falling back
    /// to `git rev-parse` for complex revspecs (`~`, `^`, `:`, `@{}`).
    pub async fn commit_id_async(&self, rev: &str) -> Result<String> {
        check_rev("rev-parse", rev)?;
        let root = self.root.clone();
        let rev_owned = rev.to_string();
        if let Some(fast) = read_blocking(move || read::commit_id_fast(&root, &rev_owned)).await? {
            return Ok(fast);
        }
        self.require_commit_async("rev-parse", rev).await
    }

    pub fn commit_id(&self, rev: &str) -> Result<String> {
        check_rev("rev-parse", rev)?;
        if let Some(fast) = read::commit_id_fast(&self.root, rev)? {
            return Ok(fast);
        }
        block_on(self.require_commit_async("rev-parse", rev))
    }

    async fn empty_tree_async(&self) -> Result<String> {
        Ok(self
            .git("hash-object")
            .args(["-t", "tree", "--stdin"])
            .stdin(Vec::new())
            .run_async()
            .await?
            .text())
    }

    async fn temp_index_async(&self) -> Result<TempIndex> {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let root = self.root.clone();
        read_blocking(move || {
            let git_dir = read::git_dir(&root)?;
            let name = format!("vibevalley-index-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed));
            let temp = TempIndex { path: git_dir.join(name) };
            // Starting from the real index keeps its stat cache, so git does not
            // have to re-hash every tracked file.
            let index = read::git_path(&root, Path::new("index"))?;
            match std::fs::copy(&index, &temp.path) {
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(GitError::Io(format!("{}: {e}", index.display()))),
            }
            Ok(temp)
        })
        .await
    }

    pub async fn status_async(&self) -> Result<Status> {
        let out = self
            .git("status")
            .args(["--porcelain=v2", "--branch", "-z", "--untracked-files=all"])
            .read()
            .run_async()
            .await?;
        status::parse(&out.stdout)
    }

    pub fn status(&self) -> Result<Status> {
        block_on(self.status_async())
    }

    async fn untracked_async(&self, path: Option<&Path>) -> Result<Vec<PathBuf>> {
        let mut cmd = self.git("ls-files").args(["--others", "--exclude-standard", "-z"]).read();
        if let Some(path) = path {
            cmd = cmd.arg("--").arg(path);
        }
        let out = cmd.run_async().await?;
        Ok(split_nul(&out.stdout)
            // A trailing slash is an embedded repository, not a file.
            .filter(|p| !p.ends_with(b"/"))
            .map(path_from_bytes)
            .collect())
    }

    async fn raw_diff_async(&self, target: &DiffTarget, paths: &[&Path]) -> Result<Vec<u8>> {
        const FORMAT: [&str; 6] = ["--patch", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--default-prefix"];
        let mut temp_index = None;
        let mut cmd = match target {
            DiffTarget::Unstaged => self.git("diff").args(FORMAT),
            DiffTarget::Staged => self.git("diff").args(FORMAT).arg("--cached"),
            DiffTarget::Uncommitted => {
                let base = match self.head_async().await? {
                    Some(head) => head,
                    None => self.empty_tree_async().await?,
                };
                let mut untracked = Vec::new();
                for path in paths {
                    untracked.extend(self.untracked_async(Some(path)).await?);
                }
                if paths.is_empty() {
                    untracked = self.untracked_async(None).await?;
                }
                let mut cmd = self.git("diff").args(FORMAT).arg(base);
                if !untracked.is_empty() {
                    // Intent-to-add entries in a private index make git
                    // itself render untracked files as new-file diffs.
                    let temp = self.temp_index_async().await?;
                    self.git("add")
                        .arg("--intent-to-add")
                        .args(PATHSPEC_STDIN)
                        .env("GIT_INDEX_FILE", &temp.path)
                        .stdin(nul_list(&untracked))
                        .run_async()
                        .await?;
                    cmd = cmd.env("GIT_INDEX_FILE", &temp.path);
                    temp_index = Some(temp);
                }
                cmd
            }
            DiffTarget::Commit(rev) => {
                let commit = self.require_commit_async("show", rev).await?;
                self.git("show").args(FORMAT).args(["--format=", "--diff-merges=first-parent"]).arg(commit)
            }
            DiffTarget::Range { from, to } => {
                check_rev("diff", from)?;
                check_rev("diff", to)?;
                self.git("diff").args(FORMAT).arg(from).arg(to)
            }
        };
        cmd = cmd.arg("--").args(paths);
        let out = cmd.read().run_async().await?;
        drop(temp_index);
        Ok(out.stdout)
    }

    pub async fn diff_async(&self, target: &DiffTarget, path: Option<&Path>) -> Result<Vec<FileDiff>> {
        let paths: Vec<&Path> = path.into_iter().collect();
        let raw = self.raw_diff_async(target, &paths).await?;
        Ok(diff::parse(&raw)?.into_iter().map(|f| f.diff).collect())
    }

    /// `path` limits the diff to one file (relative to the root). A renamed
    /// file limited to its new path shows up as added: git cannot see the
    /// old name through the path filter.
    pub fn diff(&self, target: &DiffTarget, path: Option<&Path>) -> Result<Vec<FileDiff>> {
        block_on(self.diff_async(target, path))
    }

    pub async fn stage_async(&self, paths: &[PathBuf]) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        self.git("add").arg("--all").args(PATHSPEC_STDIN).stdin(nul_list(paths)).run_async().await?;
        Ok(())
    }

    pub fn stage(&self, paths: &[PathBuf]) -> Result<()> {
        block_on(self.stage_async(paths))
    }

    pub async fn unstage_async(&self, paths: &[PathBuf]) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        let cmd = if self.head_async().await?.is_some() {
            self.git("reset").arg("--quiet").args(PATHSPEC_STDIN).arg("HEAD")
        } else {
            // Nothing to reset to before the first commit.
            self.git("rm").args(["--cached", "-r", "--quiet", "--ignore-unmatch"]).args(PATHSPEC_STDIN)
        };
        cmd.stdin(nul_list(paths)).run_async().await?;
        Ok(())
    }

    pub fn unstage(&self, paths: &[PathBuf]) -> Result<()> {
        block_on(self.unstage_async(paths))
    }

    pub async fn discard_async(&self, paths: &[PathBuf]) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        let tracked = self.git("ls-files").arg("-z").arg("--").args(paths).read().run_async().await?;
        let tracked: BTreeSet<&[u8]> = split_nul(&tracked.stdout).collect();
        if !tracked.is_empty() {
            let list: Vec<PathBuf> = tracked.into_iter().map(path_from_bytes).collect();
            self.git("restore")
                .arg("--worktree")
                .args(PATHSPEC_STDIN)
                .stdin(nul_list(&list))
                .run_async()
                .await?;
        }
        self.git("clean").args(["--force", "-d", "--quiet", "--"]).args(paths).run_async().await?;
        // git removes the files it was pointed at but leaves the directories
        // that only existed to hold them.
        for path in paths {
            let mut dir = self.root.join(path);
            while dir.pop() && dir != self.root && dir.starts_with(&self.root) {
                if tokio::fs::remove_dir(&dir).await.is_err() {
                    break;
                }
            }
        }
        Ok(())
    }

    /// Throws away working-tree changes (and removes untracked files) for
    /// these paths. Destructive. Tracked files go back to their staged
    /// content; staged changes are kept.
    pub fn discard(&self, paths: &[PathBuf]) -> Result<()> {
        block_on(self.discard_async(paths))
    }

    /// Re-reads the diff the hunk came from and cuts the hunk's exact bytes
    /// out of it, so content that is not valid UTF-8 survives the round trip
    /// and a stale hunk is refused instead of misapplied.
    async fn hunk_patch_async(&self, target: DiffTarget, file: &FileDiff, hunk: &Hunk) -> Result<Vec<u8>> {
        let stale = |why: &str| GitError::Command {
            command: "apply".into(),
            stderr: format!("{why}; refresh the diff and try again"),
        };
        let mut paths: Vec<&Path> = Vec::new();
        for path in [&file.old_path, &file.new_path].into_iter().flatten() {
            if !paths.contains(&path.as_path()) {
                paths.push(path);
            }
        }
        if paths.is_empty() {
            return Err(stale("the diff names no file"));
        }
        let raw = self.raw_diff_async(&target, &paths).await?;
        let parsed = diff::parse(&raw)?;
        let current: &ParsedFile = parsed
            .iter()
            .find(|f| f.diff.old_path == file.old_path && f.diff.new_path == file.new_path)
            .ok_or_else(|| stale("the file no longer has this change"))?;
        let at = current
            .diff
            .hunks
            .iter()
            .position(|h| h == hunk)
            .ok_or_else(|| stale("the hunk no longer matches the file"))?;

        let mut patch = Vec::new();
        if matches!(current.diff.change, Change::Added | Change::Deleted) {
            // Creation and deletion need git's extended header to apply.
            patch.extend_from_slice(&raw[current.header.clone()]);
        } else {
            // A plain two-line header: of a staged rename or mode change,
            // only the content hunk is to be applied, at the current name.
            let line = current.new_name_line.clone().ok_or_else(|| stale("the file has no text diff"))?;
            let new_name = &raw[line][4..];
            let old_name: Vec<u8> = if let Some(rest) = new_name.strip_prefix(b"\"b/") {
                [b"\"a/", rest].concat()
            } else if let Some(rest) = new_name.strip_prefix(b"b/") {
                [b"a/", rest].concat()
            } else {
                new_name.to_vec()
            };
            patch.extend_from_slice(b"--- ");
            patch.extend_from_slice(&old_name);
            patch.extend_from_slice(b"\n+++ ");
            patch.extend_from_slice(new_name);
            patch.push(b'\n');
        }
        patch.extend_from_slice(&raw[current.hunks[at].clone()]);
        if !patch.ends_with(b"\n") {
            patch.push(b'\n');
        }
        Ok(patch)
    }

    async fn apply_async(&self, flags: &[&str], hunk: &Hunk, patch: Vec<u8>) -> Result<()> {
        let mut cmd = self.git("apply").args(flags).arg("--whitespace=nowarn");
        if !hunk.lines.iter().any(|l| l.kind == LineKind::Context) {
            cmd = cmd.arg("--unidiff-zero");
        }
        cmd.arg("-").stdin(patch).run_async().await?;
        Ok(())
    }

    pub async fn stage_hunk_async(&self, file: &FileDiff, hunk: &Hunk) -> Result<()> {
        let patch = self.hunk_patch_async(DiffTarget::Unstaged, file, hunk).await?;
        self.apply_async(&["--cached"], hunk, patch).await
    }

    /// `file` and `hunk` must come from a `DiffTarget::Unstaged` diff.
    pub fn stage_hunk(&self, file: &FileDiff, hunk: &Hunk) -> Result<()> {
        block_on(self.stage_hunk_async(file, hunk))
    }

    pub async fn unstage_hunk_async(&self, file: &FileDiff, hunk: &Hunk) -> Result<()> {
        let patch = self.hunk_patch_async(DiffTarget::Staged, file, hunk).await?;
        self.apply_async(&["--cached", "--reverse"], hunk, patch).await
    }

    /// `file` and `hunk` must come from a `DiffTarget::Staged` diff.
    pub fn unstage_hunk(&self, file: &FileDiff, hunk: &Hunk) -> Result<()> {
        block_on(self.unstage_hunk_async(file, hunk))
    }

    pub async fn discard_hunk_async(&self, file: &FileDiff, hunk: &Hunk) -> Result<()> {
        let patch = self.hunk_patch_async(DiffTarget::Unstaged, file, hunk).await?;
        self.apply_async(&["--reverse"], hunk, patch).await
    }

    /// Reverts one unstaged hunk in the working tree. Destructive.
    pub fn discard_hunk(&self, file: &FileDiff, hunk: &Hunk) -> Result<()> {
        block_on(self.discard_hunk_async(file, hunk))
    }

    pub async fn commit_async(&self, message: &str) -> Result<String> {
        self.git("commit")
            .args(["--quiet", "--file=-"])
            .stdin(message.as_bytes())
            .user_facing()
            .run_async()
            .await?;
        self.head_async().await?.ok_or_else(|| GitError::Parse("no HEAD after commit".into()))
    }

    /// Commits the index. Returns the new commit id.
    pub fn commit(&self, message: &str) -> Result<String> {
        block_on(self.commit_async(message))
    }

    pub async fn commit_all_async(&self, message: &str) -> Result<Option<String>> {
        self.git("add").args(["--all", "--", "."]).run_async().await?;
        let staged = self.git("diff").args(["--cached", "--quiet"]).output_async().await?;
        if staged.ok() {
            return Ok(None);
        }
        self.commit_async(message).await.map(Some)
    }

    /// Stages every change in the working tree (new, modified, deleted;
    /// ignored files stay out) and commits it. `None` when there was nothing
    /// to commit.
    pub fn commit_all(&self, message: &str) -> Result<Option<String>> {
        block_on(self.commit_all_async(message))
    }

    pub async fn log_async(&self, rev: Option<&str>, skip: usize, limit: usize) -> Result<Vec<Commit>> {
        let rev = match rev {
            Some(rev) => {
                check_rev("log", rev)?;
                rev.to_string()
            }
            None => match self.head_async().await? {
                Some(head) => head,
                None => return Ok(Vec::new()),
            },
        };
        self.log_of_async(&["--end-of-options", &rev], skip, limit).await
    }

    pub fn log(&self, rev: Option<&str>, skip: usize, limit: usize) -> Result<Vec<Commit>> {
        block_on(self.log_async(rev, skip, limit))
    }

    pub async fn log_all_async(&self, skip: usize, limit: usize) -> Result<Vec<Commit>> {
        if self.head_async().await?.is_none() && self.branches_async().await?.is_empty() {
            return Ok(Vec::new());
        }
        self.log_of_async(&["--all"], skip, limit).await
    }

    /// Commits reachable from any ref (`git log --all`), newest first.
    pub fn log_all(&self, skip: usize, limit: usize) -> Result<Vec<Commit>> {
        block_on(self.log_all_async(skip, limit))
    }

    pub async fn run_async(&self, args: &[&str]) -> Result<RawOutput> {
        let (first, rest) = args.split_first().ok_or_else(|| GitError::Parse("no git subcommand".into()))?;
        let out = self.git(first).args(rest).output_async().await?;
        Ok(RawOutput {
            code: out.code,
            stdout: out.stdout,
            stderr: out.stderr,
        })
    }

    /// Any git command in this repository, for what the typed calls do not
    /// cover. Runs with the same isolated environment; never fails on a
    /// non-zero exit, which is in the result.
    pub fn run(&self, args: &[&str]) -> Result<RawOutput> {
        block_on(self.run_async(args))
    }

    async fn log_of_async(&self, revs: &[&str], skip: usize, limit: usize) -> Result<Vec<Commit>> {
        let out = self
            .git("log")
            .args(["-z", "--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b"])
            .arg(format!("--skip={skip}"))
            .arg(format!("--max-count={limit}"))
            .args(revs)
            .arg("--")
            .read()
            .run_async()
            .await?;
        let mut commits = Vec::new();
        for record in split_nul(&out.stdout) {
            let text = String::from_utf8_lossy(record);
            let fields: Vec<&str> = text.splitn(8, '\x1f').collect();
            let [id, short_id, parents, name, email, time, summary, body] = fields[..] else {
                return Err(GitError::Parse(format!("log record: {text}")));
            };
            commits.push(Commit {
                id: id.trim().to_string(),
                short_id: short_id.to_string(),
                parents: parents.split_whitespace().map(str::to_string).collect(),
                author_name: name.to_string(),
                author_email: email.to_string(),
                time: time.parse().map_err(|_| GitError::Parse(format!("commit time: {time}")))?,
                summary: summary.to_string(),
                body: body.trim_end().to_string(),
            });
        }
        Ok(commits)
    }

    /// Local branches first, then remote-tracking ones, each sorted by name (pure Rust).
    pub fn branches(&self) -> Result<Vec<Branch>> {
        read::branches(&self.root)
    }

    pub async fn branches_async(&self) -> Result<Vec<Branch>> {
        let root = self.root.clone();
        read_blocking(move || read::branches(&root)).await
    }

    pub async fn checkout_async(&self, branch: &str) -> Result<()> {
        check_rev("switch", branch)?;
        self.git("switch").arg("--quiet").arg(branch).user_facing().run_async().await?;
        Ok(())
    }

    pub fn checkout(&self, branch: &str) -> Result<()> {
        block_on(self.checkout_async(branch))
    }

    pub async fn create_branch_async(&self, name: &str, base: Option<&str>) -> Result<()> {
        check_rev("branch", name)?;
        let mut cmd = self.git("branch").arg(name);
        if let Some(base) = base {
            check_rev("branch", base)?;
            cmd = cmd.arg(base);
        }
        cmd.run_async().await?;
        Ok(())
    }

    pub fn create_branch(&self, name: &str, base: Option<&str>) -> Result<()> {
        block_on(self.create_branch_async(name, base))
    }

    pub async fn delete_branch_async(&self, branch: &str) -> Result<()> {
        check_rev("branch", branch)?;
        if self.branch_exists_async(branch).await? {
            self.git("branch").args(["-D", "--"]).arg(branch).run_async().await?;
        }
        Ok(())
    }

    pub fn delete_branch(&self, branch: &str) -> Result<()> {
        block_on(self.delete_branch_async(branch))
    }

    /// Deletes `branch` when every commit on it is already reachable from `into`.
    pub async fn delete_branch_if_merged_async(&self, branch: &str, into: &str) -> Result<bool> {
        if !self.branch_exists_async(branch).await? || self.has_unmerged_async(branch, into).await? {
            return Ok(false);
        }
        check_rev("branch", branch)?;
        self.git("branch").args(["-D", "--"]).arg(branch).run_async().await?;
        Ok(true)
    }

    pub fn delete_branch_if_merged(&self, branch: &str, into: &str) -> Result<bool> {
        block_on(self.delete_branch_if_merged_async(branch, into))
    }

    pub async fn show_file_async(&self, rev: Option<&str>, path: &Path) -> Result<Vec<u8>> {
        let mut object = Vec::new();
        if let Some(rev) = rev {
            check_rev("cat-file", rev)?;
            object.extend_from_slice(rev.as_bytes());
        }
        object.push(b':');
        object.extend_from_slice(path_bytes(path));
        let out = self.git("cat-file").arg("blob").arg(path_from_bytes(&object)).read().run_async().await?;
        Ok(out.stdout)
    }

    /// Content of a file at a revision (`None` rev = index).
    pub fn show_file(&self, rev: Option<&str>, path: &Path) -> Result<Vec<u8>> {
        block_on(self.show_file_async(rev, path))
    }

    /// Lists the main checkout and all linked worktrees (pure Rust).
    pub fn worktrees(&self) -> Result<Vec<Worktree>> {
        read::worktrees(&self.root)
    }

    pub async fn worktrees_async(&self) -> Result<Vec<Worktree>> {
        let root = self.root.clone();
        read_blocking(move || read::worktrees(&root)).await
    }

    pub async fn worktree_add_async(&self, path: &Path, branch: &str, base: Option<&str>) -> Result<Repo> {
        check_rev("worktree", branch)?;
        let mut cmd = self.git("worktree").args(["add", "--quiet", "-b", branch, "--"]).arg(path);
        if let Some(base) = base {
            check_rev("worktree", base)?;
            cmd = cmd.arg(base);
        }
        cmd.user_facing().run_async().await?;
        let root = self.root.join(path);
        let root = tokio::fs::canonicalize(&root)
            .await
            .map_err(|e| GitError::Io(format!("{}: {e}", root.display())))?;
        Ok(Repo { root })
    }

    /// Creates a worktree at `path` on a new branch `branch` cut from `base`
    /// (default HEAD). Returns a `Repo` rooted at the new worktree.
    pub fn worktree_add(&self, path: &Path, branch: &str, base: Option<&str>) -> Result<Repo> {
        block_on(self.worktree_add_async(path, branch, base))
    }

    /// Creates a worktree at `path` on the existing `branch`.
    pub async fn worktree_add_on_async(&self, path: &Path, branch: &str) -> Result<Repo> {
        check_rev("worktree", branch)?;
        self.git("worktree")
            .args(["add", "--quiet", "--"])
            .arg(path)
            .arg(branch)
            .user_facing()
            .run_async()
            .await?;
        let root = self.root.join(path);
        let root = tokio::fs::canonicalize(&root)
            .await
            .map_err(|e| GitError::Io(format!("{}: {e}", root.display())))?;
        Ok(Repo { root })
    }

    pub fn worktree_add_on(&self, path: &Path, branch: &str) -> Result<Repo> {
        block_on(self.worktree_add_on_async(path, branch))
    }

    pub async fn worktree_remove_async(&self, path: &Path, force: bool) -> Result<()> {
        let mut cmd = self.git("worktree").arg("remove");
        if force {
            cmd = cmd.arg("--force");
        }
        cmd.arg("--").arg(path).run_async().await?;
        Ok(())
    }

    pub fn worktree_remove(&self, path: &Path, force: bool) -> Result<()> {
        block_on(self.worktree_remove_async(path, force))
    }

    pub async fn worktree_prune_async(&self) -> Result<()> {
        self.git("worktree").arg("prune").run_async().await?;
        Ok(())
    }

    pub fn worktree_prune(&self) -> Result<()> {
        block_on(self.worktree_prune_async())
    }

    pub async fn merge_check_async(&self, branch: &str) -> Result<MergeCheck> {
        let theirs = self.require_commit_async("merge", branch).await?;
        let Some(ours) = self.head_async().await? else {
            // An unborn branch simply takes the other history.
            return Ok(MergeCheck::Clean);
        };
        self.trial_merge_async(&ours, &theirs).await
    }

    /// Trial merge of `branch` into HEAD without touching the working tree.
    pub fn merge_check(&self, branch: &str) -> Result<MergeCheck> {
        block_on(self.merge_check_async(branch))
    }

    pub async fn merge_check_between_async(&self, base: &str, branch: &str) -> Result<MergeCheck> {
        let ours = self.require_commit_async("merge", base).await?;
        let theirs = self.require_commit_async("merge", branch).await?;
        self.trial_merge_async(&ours, &theirs).await
    }

    /// Trial merge of `branch` into `base` (any two revisions), touching
    /// neither the working tree nor any ref.
    pub fn merge_check_between(&self, base: &str, branch: &str) -> Result<MergeCheck> {
        block_on(self.merge_check_between_async(base, branch))
    }

    pub async fn merge_into_async(&self, target: &str, branch: &str, message: &str) -> Result<String> {
        let target_ref = format!("refs/heads/{target}");
        let ours = self.require_commit_async("merge", &target_ref).await?;
        let theirs = self.require_commit_async("merge", branch).await?;
        if let Some(wt) = self.worktrees_async().await?.into_iter().find(|w| w.branch.as_deref() == Some(target)) {
            return Err(GitError::Command {
                command: "merge".into(),
                stderr: format!("{target} is checked out in {}; merge there", wt.path.display()),
            });
        }
        let tip = match self.trial_merge_async(&ours, &theirs).await? {
            MergeCheck::UpToDate => return Ok(ours),
            MergeCheck::Conflicts(paths) => {
                let list: Vec<String> = paths.iter().map(|p| p.display().to_string()).collect();
                return Err(GitError::Command {
                    command: "merge".into(),
                    stderr: format!("merge would conflict in: {}", list.join(", ")),
                });
            }
            MergeCheck::Clean => {
                let ff = self.git("merge-base").args(["--is-ancestor", &ours, &theirs]).read().output_async().await?;
                if ff.code == 0 {
                    theirs.clone()
                } else {
                    let tree = self
                        .git("merge-tree")
                        .args(["--write-tree", "--no-messages", &ours, &theirs])
                        .read()
                        .run_async()
                        .await?
                        .text();
                    let tree = tree.lines().next().unwrap_or_default().to_string();
                    self.git("commit-tree")
                        .arg(&tree)
                        .args(["-p", &ours, "-p", &theirs])
                        .stdin(format!("{message}\n"))
                        .user_facing()
                        .run_async()
                        .await?
                        .text()
                }
            }
        };
        // Compare-and-swap: fails if the branch moved since `ours` was read.
        self.git("update-ref").args(["-m", message, &target_ref, &tip, &ours]).run_async().await?;
        Ok(tip)
    }

    /// Merges `branch` into the local branch `target` without checking it
    /// out: fast-forwards when it can, else writes a merge commit from
    /// `git merge-tree`. Refuses when `target` is checked out in any
    /// worktree (moving its ref would leave that worktree behind; merge
    /// there instead) or when the merge would conflict. Returns the new tip.
    pub fn merge_into(&self, target: &str, branch: &str, message: &str) -> Result<String> {
        block_on(self.merge_into_async(target, branch, message))
    }

    pub(crate) async fn trial_merge_async(&self, ours: &str, theirs: &str) -> Result<MergeCheck> {
        let ancestor = self.git("merge-base").args(["--is-ancestor", theirs, ours]).read().output_async().await?;
        match ancestor.code {
            0 => return Ok(MergeCheck::UpToDate),
            1 => {}
            _ => return Err(failure("merge-base", &ancestor)),
        }
        let out = self
            .git("merge-tree")
            .args(["--write-tree", "-z", "--name-only", "--no-messages", ours, theirs])
            .read()
            .output_async()
            .await?;
        match out.code {
            0 => Ok(MergeCheck::Clean),
            1 => {
                // `<tree>\0<conflicted path>\0...`
                let paths: BTreeSet<PathBuf> = split_nul(&out.stdout).skip(1).map(path_from_bytes).collect();
                Ok(MergeCheck::Conflicts(paths.into_iter().collect()))
            }
            _ => Err(failure("merge-tree", &out)),
        }
    }

    pub async fn merge_async(&self, branch: &str, message: Option<&str>) -> Result<String> {
        match self.merge_check_async(branch).await? {
            MergeCheck::Conflicts(paths) => {
                let list: Vec<String> = paths.iter().map(|p| p.display().to_string()).collect();
                return Err(GitError::Command {
                    command: "merge".into(),
                    stderr: format!("merge would conflict in: {}", list.join(", ")),
                });
            }
            MergeCheck::UpToDate => {
                return self.head_async().await?.ok_or_else(|| GitError::Parse("no HEAD".into()));
            }
            MergeCheck::Clean => {}
        }
        let mut cmd = self.git("merge").args(["--quiet", "--no-edit"]);
        if let Some(message) = message {
            cmd = cmd.arg("-m").arg(message);
        }
        let out = cmd.arg(branch).user_facing().output_async().await?;
        if !out.ok() {
            // E.g. a hook rejected it, or the tree changed since the check.
            if self.rev_parse_async("MERGE_HEAD").await?.is_some() {
                let _ = self.git("merge").arg("--abort").output_async().await;
            }
            return Err(failure("merge", &out));
        }
        self.head_async().await?.ok_or_else(|| GitError::Parse("no HEAD after merge".into()))
    }

    /// Merges `branch` into HEAD. Fails (and leaves the tree untouched) when
    /// `merge_check` would report conflicts. Returns the resulting HEAD.
    pub fn merge(&self, branch: &str, message: Option<&str>) -> Result<String> {
        block_on(self.merge_async(branch, message))
    }

    pub async fn worktree_tree_async(&self) -> Result<String> {
        let temp = self.temp_index_async().await?;
        self.git("add").arg("--all").env("GIT_INDEX_FILE", &temp.path).run_async().await?;
        Ok(self.git("write-tree").env("GIT_INDEX_FILE", &temp.path).run_async().await?.text())
    }

    pub fn worktree_tree(&self) -> Result<String> {
        block_on(self.worktree_tree_async())
    }

    pub async fn tree_id_async(&self, rev: &str) -> Result<String> {
        check_rev("rev-parse", rev)?;
        self.rev_parse_async(&format!("{rev}^{{tree}}"))
            .await?
            .ok_or_else(|| GitError::Parse(format!("no tree for {rev}")))
    }

    pub fn tree_id(&self, rev: &str) -> Result<String> {
        block_on(self.tree_id_async(rev))
    }

    pub async fn merge_base_async(&self, a: &str, b: &str) -> Result<String> {
        check_rev("merge-base", a)?;
        check_rev("merge-base", b)?;
        Ok(self.git("merge-base").args([a, b]).read().run_async().await?.text())
    }

    pub fn merge_base(&self, a: &str, b: &str) -> Result<String> {
        block_on(self.merge_base_async(a, b))
    }

    /// Files changed on `HEAD` since it forked from `base`.
    pub async fn changed_files_async(&self, base: &str) -> Result<Vec<String>> {
        let from = self.merge_base_async(base, "HEAD").await?;
        let out = self.git("diff").args(["--name-only", "-z", &from, "HEAD", "--"]).read().run_async().await?;
        Ok(split_nul(&out.stdout).map(|b| path_from_bytes(b).to_string_lossy().into_owned()).collect())
    }

    pub fn changed_files(&self, base: &str) -> Result<Vec<String>> {
        block_on(self.changed_files_async(base))
    }

    /// Whether `branch` has commits that `into` does not.
    pub async fn has_unmerged_async(&self, branch: &str, into: &str) -> Result<bool> {
        check_rev("merge-base", branch)?;
        check_rev("merge-base", into)?;
        let out = self.git("merge-base").args(["--is-ancestor", branch, into]).read().output_async().await?;
        match out.code {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(failure("merge-base", &out)),
        }
    }

    pub fn has_unmerged(&self, branch: &str, into: &str) -> Result<bool> {
        block_on(self.has_unmerged_async(branch, into))
    }

    pub async fn commits_between_async(&self, from: &str, to: &str) -> Result<usize> {
        check_rev("rev-list", from)?;
        check_rev("rev-list", to)?;
        let out = self.git("rev-list").arg("--count").arg(format!("{from}..{to}")).read().run_async().await?;
        Ok(out.text().parse().unwrap_or(0))
    }

    pub fn commits_between(&self, from: &str, to: &str) -> Result<usize> {
        block_on(self.commits_between_async(from, to))
    }

    pub async fn check_ref_format_async(&self, refname: &str) -> Result<bool> {
        let out = self.git("check-ref-format").arg(refname).read().output_async().await?;
        Ok(out.ok())
    }

    pub async fn contains_commit_async(&self, branch: &str, commit: &str) -> Result<bool> {
        check_rev("merge-base", branch)?;
        check_rev("merge-base", commit)?;
        if self.rev_parse_async(&format!("{commit}^{{commit}}")).await?.is_none() || self.rev_parse_async(&format!("{branch}^{{commit}}")).await?.is_none() {
            return Ok(false);
        }
        let out = self.git("merge-base").args(["--is-ancestor", commit, branch]).read().output_async().await?;
        match out.code {
            0 => Ok(true),
            1 => Ok(false),
            _ => Err(failure("merge-base", &out)),
        }
    }

    pub fn contains_commit(&self, branch: &str, commit: &str) -> Result<bool> {
        block_on(self.contains_commit_async(branch, commit))
    }

    pub async fn retain_review_async(&self, base: &str, tree: &str) -> Result<()> {
        let base = self.require_commit_async("review", base).await?;
        let tree = self.tree_id_async(tree).await?;
        self.git("update-ref")
            .arg("--stdin")
            .stdin(format!(
                "update refs/vibevalley/reviews/bases/{base} {base}\nupdate refs/vibevalley/reviews/trees/{tree} {tree}\n"
            ))
            .run_async()
            .await?;
        Ok(())
    }

    pub fn retain_review(&self, base: &str, tree: &str) -> Result<()> {
        block_on(self.retain_review_async(base, tree))
    }

    pub async fn snapshot_async(&self, label: &str) -> Result<String> {
        let tree = self.worktree_tree_async().await?;

        let subject: String = label.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
        let mut cmd = self.git("commit-tree").arg("--no-gpg-sign").arg(&tree);
        if let Some(head) = self.head_async().await? {
            cmd = cmd.arg("-p").arg(head);
        }
        // Snapshots are VibeValley's bookkeeping, not the user's commits: they
        // must work without a configured identity.
        for who in ["AUTHOR", "COMMITTER"] {
            cmd = cmd
                .env(format!("GIT_{who}_NAME"), "VibeValley")
                .env(format!("GIT_{who}_EMAIL"), "vibevalley@localhost");
        }
        let id = cmd.stdin(format!("{subject}\n")).run_async().await?.text();

        let slug: String = label
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
            .take(60)
            .collect();
        let slug = if slug.is_empty() { "snapshot".to_string() } else { slug };
        // The commit id keeps refs for the same label apart.
        self.git("update-ref").arg(format!("{SNAPSHOT_REFS}/{slug}/{id}")).arg(&id).run_async().await?;
        Ok(id)
    }

    /// Records the full working-tree state (tracked + untracked) as a commit
    /// under `refs/vibevalley/snapshots/` without touching HEAD, the index or the
    /// working tree. Returns the snapshot commit id.
    pub fn snapshot(&self, label: &str) -> Result<String> {
        block_on(self.snapshot_async(label))
    }

    pub async fn snapshots_async(&self) -> Result<Vec<Snapshot>> {
        let out = self
            .git("for-each-ref")
            .arg("--sort=-committerdate")
            .arg("--format=%(objectname)%00%(refname)%00%(committerdate:unix)%00%(contents:subject)")
            .arg(SNAPSHOT_REFS)
            .read()
            .run_async()
            .await?;
        let mut snapshots = Vec::new();
        for line in out.stdout.split(|b| *b == b'\n').filter(|l| !l.is_empty()) {
            let text = String::from_utf8_lossy(line);
            let fields: Vec<&str> = text.splitn(4, '\0').collect();
            let [id, ref_name, time, label] = fields[..] else {
                return Err(GitError::Parse(format!("snapshot record: {text}")));
            };
            snapshots.push(Snapshot {
                id: id.to_string(),
                label: label.to_string(),
                time: time.parse().unwrap_or(0),
                ref_name: ref_name.to_string(),
            });
        }
        Ok(snapshots)
    }

    /// Snapshots made by `snapshot`, newest first.
    pub fn snapshots(&self) -> Result<Vec<Snapshot>> {
        block_on(self.snapshots_async())
    }

    pub async fn delete_snapshot_async(&self, id: &str) -> Result<()> {
        for snapshot in self.snapshots_async().await?.into_iter().filter(|s| s.id == id) {
            self.git("update-ref").arg("-d").arg(&snapshot.ref_name).run_async().await?;
        }
        Ok(())
    }

    /// Drops the ref(s) keeping a snapshot alive. The commit itself goes
    /// away with git's next garbage collection.
    pub fn delete_snapshot(&self, id: &str) -> Result<()> {
        block_on(self.delete_snapshot_async(id))
    }

    pub async fn restore_snapshot_async(&self, id: &str) -> Result<()> {
        let commit = self.require_commit_async("read-tree", id).await?;
        let temp = self.temp_index_async().await?;
        // First make the private index describe what is on disk now, so
        // read-tree knows which files to remove and which are unchanged.
        self.git("add").arg("--all").env("GIT_INDEX_FILE", &temp.path).run_async().await?;
        self.git("read-tree")
            .args(["--reset", "-u"])
            .arg(commit)
            .env("GIT_INDEX_FILE", &temp.path)
            .run_async()
            .await?;
        Ok(())
    }

    /// Restores the working tree to a snapshot made by `snapshot`: files are
    /// rewritten to their snapshot content and non-ignored files that the
    /// snapshot does not have are removed. HEAD and the index stay as they
    /// are. Destructive.
    pub fn restore_snapshot(&self, id: &str) -> Result<()> {
        block_on(self.restore_snapshot_async(id))
    }
}
