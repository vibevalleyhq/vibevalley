use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::cmd::{Cmd, failure, nul_list, path_bytes, path_from_bytes, split_nul};
use crate::diff::{self, ParsedFile};
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
fn check_rev(command: &str, rev: &str) -> Result<()> {
    if rev.is_empty() || rev.starts_with('-') || rev.contains('\0') {
        return Err(GitError::Command {
            command: command.to_string(),
            stderr: format!("invalid revision or branch name: {rev:?}"),
        });
    }
    Ok(())
}

/// What a raw [`Repo::run`] exited with.
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
pub fn init(dir: &Path, branch: Option<&str>) -> Result<Repo> {
    std::fs::create_dir_all(dir).map_err(|e| GitError::Io(format!("{}: {e}", dir.display())))?;
    let mut cmd = Cmd::new(dir, "init").arg("--quiet");
    if let Some(branch) = branch {
        check_rev("init", branch)?;
        cmd = cmd.arg(format!("--initial-branch={branch}"));
    }
    cmd.run()?;
    Repo::discover(dir)?.ok_or_else(|| GitError::Parse(format!("{} is not a repository after init", dir.display())))
}

/// `git clone <url> <dest>`; `dest` must not exist yet. Never prompts for
/// credentials (a private repo without them fails).
pub fn clone(url: &str, dest: &Path) -> Result<Repo> {
    if url.starts_with('-') {
        return Err(GitError::Parse(format!("not a repository address: {url}")));
    }
    let parent = dest.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent).map_err(|e| GitError::Io(format!("{}: {e}", parent.display())))?;
    Cmd::new(parent, "clone").args(["--quiet", "--end-of-options"]).arg(url).arg(dest).run()?;
    Repo::discover(dest)?.ok_or_else(|| GitError::Parse(format!("{} is not a repository after clone", dest.display())))
}

impl Repo {
    /// Finds the repository containing `path`. `Ok(None)` when there is none.
    pub fn discover(path: &Path) -> Result<Option<Repo>> {
        let dir = if path.is_dir() {
            path
        } else {
            match path.parent() {
                Some(parent) if parent.is_dir() => parent,
                _ => return Ok(None),
            }
        };
        let out = Cmd::new(dir, "rev-parse").arg("--show-toplevel").read().output()?;
        if out.ok() {
            let root = out.stdout.strip_suffix(b"\n").unwrap_or(&out.stdout);
            if root.is_empty() {
                return Ok(None);
            }
            return Ok(Some(Repo { root: path_from_bytes(root) }));
        }
        // Inside a bare repository or a `.git` directory there is a
        // repository but no working tree to show.
        if out.stderr.contains("not a git repository") || out.stderr.contains("work tree") {
            return Ok(None);
        }
        Err(failure("rev-parse", &out))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn git(&self, subcommand: &str) -> Cmd<'_> {
        Cmd::new(&self.root, subcommand)
    }

    fn rev_parse(&self, rev: &str) -> Result<Option<String>> {
        let out = self
            .git("rev-parse")
            .args(["--verify", "--quiet", "--end-of-options"])
            .arg(rev)
            .read()
            .output()?;
        Ok(if out.ok() { Some(out.text()) } else { None })
    }

    /// The commit HEAD points at; `None` before the first commit.
    pub fn head(&self) -> Result<Option<String>> {
        self.rev_parse("HEAD^{commit}")
    }

    pub(crate) fn require_commit(&self, command: &str, rev: &str) -> Result<String> {
        check_rev(command, rev)?;
        self.rev_parse(&format!("{rev}^{{commit}}"))?.ok_or_else(|| GitError::Command {
            command: command.to_string(),
            stderr: format!("unknown revision: {rev}"),
        })
    }

    fn empty_tree(&self) -> Result<String> {
        Ok(self.git("hash-object").args(["-t", "tree", "--stdin"]).stdin(Vec::new()).run()?.text())
    }

    fn temp_index(&self) -> Result<TempIndex> {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let git_dir = self.git("rev-parse").arg("--absolute-git-dir").read().run()?;
        let git_dir = path_from_bytes(git_dir.text().as_bytes());
        let name = format!("vibevalley-index-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed));
        let temp = TempIndex { path: git_dir.join(name) };
        // Starting from the real index keeps its stat cache, so git does not
        // have to re-hash every tracked file.
        let index = self.git("rev-parse").args(["--git-path", "index"]).read().run()?;
        let index = self.root.join(path_from_bytes(index.text().as_bytes()));
        match std::fs::copy(&index, &temp.path) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(GitError::Io(format!("{}: {e}", index.display()))),
        }
        Ok(temp)
    }

    pub fn status(&self) -> Result<Status> {
        let out = self
            .git("status")
            .args(["--porcelain=v2", "--branch", "-z", "--untracked-files=all"])
            .read()
            .run()?;
        status::parse(&out.stdout)
    }

    fn untracked(&self, path: Option<&Path>) -> Result<Vec<PathBuf>> {
        let mut cmd = self.git("ls-files").args(["--others", "--exclude-standard", "-z"]).read();
        if let Some(path) = path {
            cmd = cmd.arg("--").arg(path);
        }
        let out = cmd.run()?;
        Ok(split_nul(&out.stdout)
            // A trailing slash is an embedded repository, not a file.
            .filter(|p| !p.ends_with(b"/"))
            .map(path_from_bytes)
            .collect())
    }

    fn raw_diff(&self, target: &DiffTarget, paths: &[&Path]) -> Result<Vec<u8>> {
        const FORMAT: [&str; 6] = ["--patch", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--default-prefix"];
        let mut temp_index = None;
        let mut cmd = match target {
            DiffTarget::Unstaged => self.git("diff").args(FORMAT),
            DiffTarget::Staged => self.git("diff").args(FORMAT).arg("--cached"),
            DiffTarget::Uncommitted => {
                let base = match self.head()? {
                    Some(head) => head,
                    None => self.empty_tree()?,
                };
                let mut untracked = Vec::new();
                for path in paths {
                    untracked.extend(self.untracked(Some(path))?);
                }
                if paths.is_empty() {
                    untracked = self.untracked(None)?;
                }
                let mut cmd = self.git("diff").args(FORMAT).arg(base);
                if !untracked.is_empty() {
                    // Intent-to-add entries in a private index make git
                    // itself render untracked files as new-file diffs.
                    let temp = self.temp_index()?;
                    self.git("add")
                        .arg("--intent-to-add")
                        .args(PATHSPEC_STDIN)
                        .env("GIT_INDEX_FILE", &temp.path)
                        .stdin(nul_list(&untracked))
                        .run()?;
                    cmd = cmd.env("GIT_INDEX_FILE", &temp.path);
                    temp_index = Some(temp);
                }
                cmd
            }
            DiffTarget::Commit(rev) => {
                let commit = self.require_commit("show", rev)?;
                self.git("show").args(FORMAT).args(["--format=", "--diff-merges=first-parent"]).arg(commit)
            }
            DiffTarget::Range { from, to } => {
                check_rev("diff", from)?;
                check_rev("diff", to)?;
                self.git("diff").args(FORMAT).arg(from).arg(to)
            }
        };
        cmd = cmd.arg("--").args(paths);
        let out = cmd.read().run()?;
        drop(temp_index);
        Ok(out.stdout)
    }

    /// `path` limits the diff to one file (relative to the root). A renamed
    /// file limited to its new path shows up as added: git cannot see the
    /// old name through the path filter.
    pub fn diff(&self, target: &DiffTarget, path: Option<&Path>) -> Result<Vec<FileDiff>> {
        let paths: Vec<&Path> = path.into_iter().collect();
        let raw = self.raw_diff(target, &paths)?;
        Ok(diff::parse(&raw)?.into_iter().map(|f| f.diff).collect())
    }

    pub fn stage(&self, paths: &[PathBuf]) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        self.git("add").arg("--all").args(PATHSPEC_STDIN).stdin(nul_list(paths)).run()?;
        Ok(())
    }

    pub fn unstage(&self, paths: &[PathBuf]) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        let cmd = if self.head()?.is_some() {
            self.git("reset").arg("--quiet").args(PATHSPEC_STDIN).arg("HEAD")
        } else {
            // Nothing to reset to before the first commit.
            self.git("rm").args(["--cached", "-r", "--quiet", "--ignore-unmatch"]).args(PATHSPEC_STDIN)
        };
        cmd.stdin(nul_list(paths)).run()?;
        Ok(())
    }

    /// Throws away working-tree changes (and removes untracked files) for
    /// these paths. Destructive. Tracked files go back to their staged
    /// content; staged changes are kept.
    pub fn discard(&self, paths: &[PathBuf]) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        let tracked = self.git("ls-files").arg("-z").arg("--").args(paths).read().run()?;
        let tracked: BTreeSet<&[u8]> = split_nul(&tracked.stdout).collect();
        if !tracked.is_empty() {
            let list: Vec<PathBuf> = tracked.into_iter().map(path_from_bytes).collect();
            self.git("restore").arg("--worktree").args(PATHSPEC_STDIN).stdin(nul_list(&list)).run()?;
        }
        self.git("clean").args(["--force", "-d", "--quiet", "--"]).args(paths).run()?;
        // git removes the files it was pointed at but leaves the directories
        // that only existed to hold them.
        for path in paths {
            let mut dir = self.root.join(path);
            while dir.pop() && dir != self.root && dir.starts_with(&self.root) {
                if std::fs::remove_dir(&dir).is_err() {
                    break;
                }
            }
        }
        Ok(())
    }

    /// Re-reads the diff the hunk came from and cuts the hunk's exact bytes
    /// out of it, so content that is not valid UTF-8 survives the round trip
    /// and a stale hunk is refused instead of misapplied.
    fn hunk_patch(&self, target: DiffTarget, file: &FileDiff, hunk: &Hunk) -> Result<Vec<u8>> {
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
        let raw = self.raw_diff(&target, &paths)?;
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

    fn apply(&self, flags: &[&str], hunk: &Hunk, patch: Vec<u8>) -> Result<()> {
        let mut cmd = self.git("apply").args(flags).arg("--whitespace=nowarn");
        if !hunk.lines.iter().any(|l| l.kind == LineKind::Context) {
            cmd = cmd.arg("--unidiff-zero");
        }
        cmd.arg("-").stdin(patch).run()?;
        Ok(())
    }

    /// `file` and `hunk` must come from a `DiffTarget::Unstaged` diff.
    pub fn stage_hunk(&self, file: &FileDiff, hunk: &Hunk) -> Result<()> {
        let patch = self.hunk_patch(DiffTarget::Unstaged, file, hunk)?;
        self.apply(&["--cached"], hunk, patch)
    }

    /// `file` and `hunk` must come from a `DiffTarget::Staged` diff.
    pub fn unstage_hunk(&self, file: &FileDiff, hunk: &Hunk) -> Result<()> {
        let patch = self.hunk_patch(DiffTarget::Staged, file, hunk)?;
        self.apply(&["--cached", "--reverse"], hunk, patch)
    }

    /// Reverts one unstaged hunk in the working tree. Destructive.
    pub fn discard_hunk(&self, file: &FileDiff, hunk: &Hunk) -> Result<()> {
        let patch = self.hunk_patch(DiffTarget::Unstaged, file, hunk)?;
        self.apply(&["--reverse"], hunk, patch)
    }

    /// Commits the index. Returns the new commit id.
    pub fn commit(&self, message: &str) -> Result<String> {
        self.git("commit").args(["--quiet", "--file=-"]).stdin(message.as_bytes()).user_facing().run()?;
        self.head()?.ok_or_else(|| GitError::Parse("no HEAD after commit".into()))
    }

    /// Stages every change in the working tree (new, modified, deleted;
    /// ignored files stay out) and commits it. `None` when there was nothing
    /// to commit.
    pub fn commit_all(&self, message: &str) -> Result<Option<String>> {
        self.git("add").args(["--all", "--", "."]).run()?;
        let staged = self.git("diff").args(["--cached", "--quiet"]).output()?;
        if staged.ok() {
            return Ok(None);
        }
        self.commit(message).map(Some)
    }

    pub fn log(&self, rev: Option<&str>, skip: usize, limit: usize) -> Result<Vec<Commit>> {
        let rev = match rev {
            Some(rev) => {
                check_rev("log", rev)?;
                rev.to_string()
            }
            None => match self.head()? {
                Some(head) => head,
                None => return Ok(Vec::new()),
            },
        };
        self.log_of(&["--end-of-options", &rev], skip, limit)
    }

    /// Commits reachable from any ref (`git log --all`), newest first.
    pub fn log_all(&self, skip: usize, limit: usize) -> Result<Vec<Commit>> {
        if self.head()?.is_none() && self.branches()?.is_empty() {
            return Ok(Vec::new());
        }
        self.log_of(&["--all"], skip, limit)
    }

    /// Any git command in this repository, for what the typed calls do not
    /// cover. Runs with the same isolated environment; never fails on a
    /// non-zero exit, which is in the result.
    pub fn run(&self, args: &[&str]) -> Result<RawOutput> {
        let (first, rest) = args.split_first().ok_or_else(|| GitError::Parse("no git subcommand".into()))?;
        let out = self.git(first).args(rest).output()?;
        Ok(RawOutput {
            code: out.code,
            stdout: out.stdout,
            stderr: out.stderr,
        })
    }

    fn log_of(&self, revs: &[&str], skip: usize, limit: usize) -> Result<Vec<Commit>> {
        let out = self
            .git("log")
            .args(["-z", "--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b"])
            .arg(format!("--skip={skip}"))
            .arg(format!("--max-count={limit}"))
            .args(revs)
            .arg("--")
            .read()
            .run()?;
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

    /// Local branches first, then remote-tracking ones, each sorted by name.
    pub fn branches(&self) -> Result<Vec<Branch>> {
        let out = self
            .git("for-each-ref")
            .arg("--format=%(refname)%00%(HEAD)%00%(upstream:short)%00%(objectname)%00%(symref)")
            .args(["refs/heads", "refs/remotes"])
            .read()
            .run()?;
        let mut branches = Vec::new();
        for line in out.stdout.split(|b| *b == b'\n').filter(|l| !l.is_empty()) {
            let text = String::from_utf8_lossy(line);
            let fields: Vec<&str> = text.split('\0').collect();
            let [refname, head, upstream, tip, symref] = fields[..] else {
                return Err(GitError::Parse(format!("branch record: {text}")));
            };
            // `refs/remotes/origin/HEAD` is an alias, not a branch.
            if !symref.is_empty() {
                continue;
            }
            let (name, is_remote) = match refname.strip_prefix("refs/heads/") {
                Some(name) => (name, false),
                None => (refname.strip_prefix("refs/remotes/").unwrap_or(refname), true),
            };
            branches.push(Branch {
                name: name.to_string(),
                is_head: head == "*",
                is_remote,
                upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
                tip: tip.to_string(),
            });
        }
        Ok(branches)
    }

    pub fn checkout(&self, branch: &str) -> Result<()> {
        check_rev("switch", branch)?;
        self.git("switch").arg("--quiet").arg(branch).user_facing().run()?;
        Ok(())
    }

    pub fn create_branch(&self, name: &str, base: Option<&str>) -> Result<()> {
        check_rev("branch", name)?;
        let mut cmd = self.git("branch").arg(name);
        if let Some(base) = base {
            check_rev("branch", base)?;
            cmd = cmd.arg(base);
        }
        cmd.run()?;
        Ok(())
    }

    /// Content of a file at a revision (`None` rev = index).
    pub fn show_file(&self, rev: Option<&str>, path: &Path) -> Result<Vec<u8>> {
        let mut object = Vec::new();
        if let Some(rev) = rev {
            check_rev("cat-file", rev)?;
            object.extend_from_slice(rev.as_bytes());
        }
        object.push(b':');
        object.extend_from_slice(path_bytes(path));
        let out = self.git("cat-file").arg("blob").arg(path_from_bytes(&object)).read().run()?;
        Ok(out.stdout)
    }

    pub fn worktrees(&self) -> Result<Vec<Worktree>> {
        let out = self.git("worktree").args(["list", "--porcelain", "-z"]).read().run()?;
        let mut worktrees: Vec<Worktree> = Vec::new();
        for field in out.stdout.split(|b| *b == 0) {
            let (key, value) = match field.iter().position(|b| *b == b' ') {
                Some(at) => (&field[..at], &field[at + 1..]),
                None => (field, &b""[..]),
            };
            if key == b"worktree" {
                worktrees.push(Worktree {
                    path: path_from_bytes(value),
                    branch: None,
                    head: String::new(),
                    is_main: worktrees.is_empty(),
                    locked: false,
                });
                continue;
            }
            let Some(current) = worktrees.last_mut() else { continue };
            match key {
                b"HEAD" => current.head = String::from_utf8_lossy(value).into_owned(),
                b"branch" => {
                    let name = String::from_utf8_lossy(value);
                    current.branch = Some(name.strip_prefix("refs/heads/").unwrap_or(&name).to_string());
                }
                b"locked" => current.locked = true,
                _ => {}
            }
        }
        Ok(worktrees)
    }

    /// Creates a worktree at `path` on a new branch `branch` cut from `base`
    /// (default HEAD). Returns a `Repo` rooted at the new worktree.
    pub fn worktree_add(&self, path: &Path, branch: &str, base: Option<&str>) -> Result<Repo> {
        check_rev("worktree", branch)?;
        let mut cmd = self.git("worktree").args(["add", "--quiet", "-b", branch, "--"]).arg(path);
        if let Some(base) = base {
            check_rev("worktree", base)?;
            cmd = cmd.arg(base);
        }
        cmd.user_facing().run()?;
        let root = self.root.join(path);
        let root = root.canonicalize().map_err(|e| GitError::Io(format!("{}: {e}", root.display())))?;
        Ok(Repo { root })
    }

    pub fn worktree_remove(&self, path: &Path, force: bool) -> Result<()> {
        let mut cmd = self.git("worktree").arg("remove");
        if force {
            cmd = cmd.arg("--force");
        }
        cmd.arg("--").arg(path).run()?;
        Ok(())
    }

    /// Trial merge of `branch` into HEAD without touching the working tree.
    pub fn merge_check(&self, branch: &str) -> Result<MergeCheck> {
        let theirs = self.require_commit("merge", branch)?;
        let Some(ours) = self.head()? else {
            // An unborn branch simply takes the other history.
            return Ok(MergeCheck::Clean);
        };
        self.trial_merge(&ours, &theirs)
    }

    /// Trial merge of `branch` into `base` (any two revisions), touching
    /// neither the working tree nor any ref.
    pub fn merge_check_between(&self, base: &str, branch: &str) -> Result<MergeCheck> {
        let ours = self.require_commit("merge", base)?;
        let theirs = self.require_commit("merge", branch)?;
        self.trial_merge(&ours, &theirs)
    }

    /// Merges `branch` into the local branch `target` without checking it
    /// out: fast-forwards when it can, else writes a merge commit from
    /// `git merge-tree`. Refuses when `target` is checked out in any
    /// worktree (moving its ref would leave that worktree behind; merge
    /// there instead) or when the merge would conflict. Returns the new tip.
    pub fn merge_into(&self, target: &str, branch: &str, message: &str) -> Result<String> {
        let target_ref = format!("refs/heads/{target}");
        let ours = self.require_commit("merge", &target_ref)?;
        let theirs = self.require_commit("merge", branch)?;
        if let Some(wt) = self.worktrees()?.into_iter().find(|w| w.branch.as_deref() == Some(target)) {
            return Err(GitError::Command {
                command: "merge".into(),
                stderr: format!("{target} is checked out in {}; merge there", wt.path.display()),
            });
        }
        let tip = match self.trial_merge(&ours, &theirs)? {
            MergeCheck::UpToDate => return Ok(ours),
            MergeCheck::Conflicts(paths) => {
                let list: Vec<String> = paths.iter().map(|p| p.display().to_string()).collect();
                return Err(GitError::Command {
                    command: "merge".into(),
                    stderr: format!("merge would conflict in: {}", list.join(", ")),
                });
            }
            MergeCheck::Clean => {
                let ff = self.git("merge-base").args(["--is-ancestor", &ours, &theirs]).read().output()?;
                if ff.code == 0 {
                    theirs.clone()
                } else {
                    let tree = self
                        .git("merge-tree")
                        .args(["--write-tree", "--no-messages", &ours, &theirs])
                        .read()
                        .run()?
                        .text();
                    let tree = tree.lines().next().unwrap_or_default().to_string();
                    self.git("commit-tree")
                        .arg(&tree)
                        .args(["-p", &ours, "-p", &theirs])
                        .stdin(format!("{message}\n"))
                        .user_facing()
                        .run()?
                        .text()
                }
            }
        };
        // Compare-and-swap: fails if the branch moved since `ours` was read.
        self.git("update-ref").args(["-m", message, &target_ref, &tip, &ours]).run()?;
        Ok(tip)
    }

    pub(crate) fn trial_merge(&self, ours: &str, theirs: &str) -> Result<MergeCheck> {
        let ancestor = self.git("merge-base").args(["--is-ancestor", theirs, ours]).read().output()?;
        match ancestor.code {
            0 => return Ok(MergeCheck::UpToDate),
            1 => {}
            _ => return Err(failure("merge-base", &ancestor)),
        }
        let out = self
            .git("merge-tree")
            .args(["--write-tree", "-z", "--name-only", "--no-messages", ours, theirs])
            .read()
            .output()?;
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

    /// Merges `branch` into HEAD. Fails (and leaves the tree untouched) when
    /// `merge_check` would report conflicts. Returns the resulting HEAD.
    pub fn merge(&self, branch: &str, message: Option<&str>) -> Result<String> {
        match self.merge_check(branch)? {
            MergeCheck::Conflicts(paths) => {
                let list: Vec<String> = paths.iter().map(|p| p.display().to_string()).collect();
                return Err(GitError::Command {
                    command: "merge".into(),
                    stderr: format!("merge would conflict in: {}", list.join(", ")),
                });
            }
            MergeCheck::UpToDate => {
                return self.head()?.ok_or_else(|| GitError::Parse("no HEAD".into()));
            }
            MergeCheck::Clean => {}
        }
        let mut cmd = self.git("merge").args(["--quiet", "--no-edit"]);
        if let Some(message) = message {
            cmd = cmd.arg("-m").arg(message);
        }
        let out = cmd.arg(branch).user_facing().output()?;
        if !out.ok() {
            // E.g. a hook rejected it, or the tree changed since the check.
            if self.rev_parse("MERGE_HEAD")?.is_some() {
                let _ = self.git("merge").arg("--abort").output();
            }
            return Err(failure("merge", &out));
        }
        self.head()?.ok_or_else(|| GitError::Parse("no HEAD after merge".into()))
    }

    pub fn worktree_tree(&self) -> Result<String> {
        let temp = self.temp_index()?;
        self.git("add").arg("--all").env("GIT_INDEX_FILE", &temp.path).run()?;
        Ok(self.git("write-tree").env("GIT_INDEX_FILE", &temp.path).run()?.text())
    }

    pub fn tree_id(&self, rev: &str) -> Result<String> {
        check_rev("rev-parse", rev)?;
        self.rev_parse(&format!("{rev}^{{tree}}"))?
            .ok_or_else(|| GitError::Parse(format!("no tree for {rev}")))
    }

    pub fn contains_commit(&self, branch: &str, commit: &str) -> Result<bool> {
        check_rev("merge-base", branch)?;
        check_rev("merge-base", commit)?;
        if self.rev_parse(&format!("{commit}^{{commit}}"))?.is_none() || self.rev_parse(&format!("{branch}^{{commit}}"))?.is_none() {
            return Ok(false);
        }
        let out = self.git("merge-base").args(["--is-ancestor", commit, branch]).read().output()?;
        match out.code {
            0 => Ok(true),
            1 => Ok(false),
            _ => Err(failure("merge-base", &out)),
        }
    }

    pub fn retain_review(&self, base: &str, tree: &str) -> Result<()> {
        let base = self.require_commit("review", base)?;
        let tree = self.tree_id(tree)?;
        self.git("update-ref")
            .arg("--stdin")
            .stdin(format!(
                "update refs/vibevalley/reviews/bases/{base} {base}\nupdate refs/vibevalley/reviews/trees/{tree} {tree}\n"
            ))
            .run()?;
        Ok(())
    }

    /// Records the full working-tree state (tracked + untracked) as a commit
    /// under `refs/vibevalley/snapshots/` without touching HEAD, the index or the
    /// working tree. Returns the snapshot commit id.
    pub fn snapshot(&self, label: &str) -> Result<String> {
        let tree = self.worktree_tree()?;

        let subject: String = label.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
        let mut cmd = self.git("commit-tree").arg("--no-gpg-sign").arg(&tree);
        if let Some(head) = self.head()? {
            cmd = cmd.arg("-p").arg(head);
        }
        // Snapshots are VibeValley's bookkeeping, not the user's commits: they
        // must work without a configured identity.
        for who in ["AUTHOR", "COMMITTER"] {
            cmd = cmd
                .env(format!("GIT_{who}_NAME"), "VibeValley")
                .env(format!("GIT_{who}_EMAIL"), "vibevalley@localhost");
        }
        let id = cmd.stdin(format!("{subject}\n")).run()?.text();

        let slug: String = label
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
            .take(60)
            .collect();
        let slug = if slug.is_empty() { "snapshot".to_string() } else { slug };
        // The commit id keeps refs for the same label apart.
        self.git("update-ref").arg(format!("{SNAPSHOT_REFS}/{slug}/{id}")).arg(&id).run()?;
        Ok(id)
    }

    /// Snapshots made by `snapshot`, newest first.
    pub fn snapshots(&self) -> Result<Vec<Snapshot>> {
        let out = self
            .git("for-each-ref")
            .arg("--sort=-committerdate")
            .arg("--format=%(objectname)%00%(refname)%00%(committerdate:unix)%00%(contents:subject)")
            .arg(SNAPSHOT_REFS)
            .read()
            .run()?;
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

    /// Drops the ref(s) keeping a snapshot alive. The commit itself goes
    /// away with git's next garbage collection.
    pub fn delete_snapshot(&self, id: &str) -> Result<()> {
        for snapshot in self.snapshots()?.into_iter().filter(|s| s.id == id) {
            self.git("update-ref").arg("-d").arg(&snapshot.ref_name).run()?;
        }
        Ok(())
    }

    /// Restores the working tree to a snapshot made by `snapshot`: files are
    /// rewritten to their snapshot content and non-ignored files that the
    /// snapshot does not have are removed. HEAD and the index stay as they
    /// are. Destructive.
    pub fn restore_snapshot(&self, id: &str) -> Result<()> {
        let commit = self.require_commit("read-tree", id)?;
        let temp = self.temp_index()?;
        // First make the private index describe what is on disk now, so
        // read-tree knows which files to remove and which are unchanged.
        self.git("add").arg("--all").env("GIT_INDEX_FILE", &temp.path).run()?;
        self.git("read-tree")
            .args(["--reset", "-u"])
            .arg(commit)
            .env("GIT_INDEX_FILE", &temp.path)
            .run()?;
        Ok(())
    }
}
