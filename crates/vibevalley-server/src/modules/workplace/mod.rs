//! Where an issue's work happens on disk: its repository (made when it is a
//! folder under the work root), the issue's worktree on its own branch, the
//! base it forks from, merging it, its conflicts, and the branches left
//! afterwards. It knows nothing of the board's state: callers name the
//! issue's number, repository and the worktree its session works in.

mod check;
mod git;

use std::path::{Path, PathBuf};

use vibevalley_core::CheckoutChecks;
use vibevalley_git::{MergeCheck, Repo};
use vibevalley_protocol::{Conflict, Deliverable, Landing};

use crate::modules::ledger::{BoardError, Result, io};

pub fn issue_branch(number: i64) -> String {
    format!("vibevalley/issue-{number}")
}

/// What happens to a session's worktree when it leaves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Leave {
    /// Left as it is.
    Keep,
    /// Leftovers committed on the branch; worktree removed; branch kept
    /// when it has unmerged commits.
    KeepBranch,
    /// Worktree removed; branch deleted when nothing on it is unmerged
    /// (always, for a draft).
    Discard,
}

/// Where a leaving session worked.
pub struct Leaving<'a> {
    pub repo: &'a str,
    pub worktree: &'a str,
    pub branch: &'a str,
    /// The branch its work forked from; none is the main branch.
    pub base: Option<String>,
    /// For the commit of its leftovers.
    pub name: &'a str,
    pub drafting: bool,
}

/// An issue's work: the commits on its branch, the diff, what is not
/// committed yet, and whether merging it would conflict.
#[derive(Debug, Clone)]
pub struct Changes {
    pub base: String,
    pub branch: String,
    pub worktree: PathBuf,
    pub commits: Vec<vibevalley_git::Commit>,
    pub files: Vec<vibevalley_git::FileDiff>,
    pub uncommitted: Vec<vibevalley_git::FileDiff>,
    pub conflicts: Vec<PathBuf>,
    /// Commits on the base its branch does not have.
    pub behind: usize,
}

/// An accepted issue's work, as `land` left it.
#[derive(Debug, Clone, PartialEq)]
pub enum Landed {
    Landed(Landing),
    /// Merging into the main branch would conflict; nothing was merged.
    Conflict(Conflict),
    /// The project check failed with this output; nothing was merged.
    CheckFailed(String),
}

/// A child's work, as `join` left it.
#[derive(Debug, Clone, PartialEq)]
pub enum Joined {
    /// In its parent's branch; an acceptance child's files to freeze.
    Merged { frozen: Option<Vec<String>> },
    /// Not merged: why, and the conflict when that was it.
    Stuck { why: String, conflict: Option<Conflict> },
}

/// The issue being landed or joined, as far as its workplace cares.
pub struct OnDisk<'a> {
    pub number: i64,
    pub title: &'a str,
    /// The worktree its session works in, while one is on the board.
    pub worktree: Option<&'a str>,
}

pub struct Workplace {
    worktrees_dir: PathBuf,
    repos_dir: Option<PathBuf>,
    data_dir: PathBuf,
}

impl Workplace {
    pub fn new(worktrees_dir: PathBuf, repos_dir: Option<PathBuf>, data_dir: PathBuf) -> Workplace {
        Workplace {
            worktrees_dir,
            repos_dir,
            data_dir,
        }
    }

    /// Where an issue's `repo` is: a bare name under `repos_dir`, else the
    /// path as written.
    pub fn repo_dir(&self, repo: &str) -> PathBuf {
        match &self.repos_dir {
            Some(root) if !repo.is_empty() && !repo.contains('/') => root.join(repo),
            _ => PathBuf::from(repo),
        }
    }

    /// How an issue names a repository's top: its name when it is right
    /// under `repos_dir`, else its path.
    pub fn repo_ref(&self, top: &Path) -> String {
        if let Some(root) = &self.repos_dir {
            let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.clone());
            let top = std::fs::canonicalize(top).unwrap_or_else(|_| top.to_path_buf());
            if top.parent() == Some(root.as_path())
                && let Some(name) = top.file_name()
            {
                return name.to_string_lossy().into_owned();
            }
        }
        top.to_string_lossy().into_owned()
    }

    /// `<work root>/AGENTS.md`, the rules every repo on this machine shares.
    pub fn house_rules(&self) -> String {
        let Some(root) = self.repos_dir.as_deref().and_then(Path::parent) else {
            return String::new();
        };
        std::fs::read_to_string(root.join("AGENTS.md")).unwrap_or_default()
    }

    /// The repo at `dir`; a folder under the work root that is not one yet
    /// (or not there) becomes one, with a first empty commit.
    pub fn ensure_repo(&self, dir: PathBuf) -> Result<Repo> {
        if let Some(repo) = Repo::discover(&dir)? {
            return Ok(repo);
        }
        let ours = self.repos_dir.as_ref().is_some_and(|root| dir.starts_with(root));
        if !ours {
            return Err(BoardError::NotARepo(dir));
        }
        std::fs::create_dir_all(&dir).map_err(|e| BoardError::Other(format!("{}: {e}", dir.display())))?;
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(["-c", "user.name=vibevalley", "-c", "user.email=vibevalley@localhost"])
                .args(args)
                .output()
                .map_err(|e| BoardError::Other(e.to_string()))
        };
        git(&["init", "-q", "-b", "main"])?;
        git(&["commit", "-q", "--allow-empty", "-m", "Start"])?;
        Repo::discover(&dir)?.ok_or(BoardError::NotARepo(dir))
    }

    /// The repository an issue names, made when it is ours and missing.
    pub fn main_repo(&self, repo: Option<&str>) -> Result<Option<Repo>> {
        repo.map(|r| self.ensure_repo(self.repo_dir(r))).transpose()
    }

    /// The repository at `repo` as it is, made of nothing.
    pub fn existing(&self, repo: &str) -> Result<Option<Repo>> {
        Ok(Repo::discover(&self.repo_dir(repo))?)
    }

    pub fn main_branch(main: &Repo) -> Result<String> {
        main.status()?
            .branch
            .ok_or_else(|| BoardError::Other("the main checkout has no branch checked out".into()))
    }

    /// The branch an issue's work forks from: its parent's (made from the
    /// main branch when the parent never had one), else the main branch.
    pub fn base(&self, main: &Repo, parent: Option<i64>) -> Result<String> {
        let Some(parent) = parent else {
            return Self::main_branch(main);
        };
        let branch = issue_branch(parent);
        if !git::branch_exists(main.root(), &branch)? {
            main.create_branch(&branch, Some(&Self::main_branch(main)?))?;
        }
        Ok(branch)
    }

    fn dir_of(&self, main: &Repo, number: i64) -> PathBuf {
        let name = main.root().file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        self.worktrees_dir.join(format!("{name}.{number}"))
    }

    /// The worktree issue `number` works in: `<worktrees>/<repo>.<number>`
    /// on its branch, cut from `base`.
    pub fn worktree(&self, main: &Repo, number: i64, base: &str) -> Result<(PathBuf, String)> {
        let dir = self.dir_of(main, number);
        let branch = issue_branch(number);
        if dir.join(".git").exists() {
            return Ok((dir, branch));
        }
        std::fs::create_dir_all(&self.worktrees_dir).map_err(io)?;
        if git::branch_exists(main.root(), &branch)? {
            git::add_worktree_on(main, &dir, &branch)?;
        } else {
            main.worktree_add(&dir, &branch, Some(base))?;
        }
        Ok((dir, branch))
    }

    /// A new worktree for issue `number` from the main branch, whatever was
    /// there before gone: where a draft starts. Its dir, branch and base.
    pub fn fresh_worktree(&self, main: &Repo, number: i64) -> Result<(PathBuf, String, String)> {
        let base = Self::main_branch(main)?;
        git::remove_worktree(main, &self.dir_of(main, number))?;
        git::delete_branch(main.root(), &issue_branch(number))?;
        let (dir, branch) = self.worktree(main, number, &base)?;
        Ok((dir, branch, base))
    }

    /// The folder a session works in when its issue has no repository.
    pub fn context(&self, issue: &str) -> Result<PathBuf> {
        let dir = self.data_dir.join("contexts").join(issue);
        std::fs::create_dir_all(&dir).map_err(io)?;
        Ok(dir)
    }

    /// Where the issue's work is: its session's worktree, or its own
    /// checkout (made when `make` and its branch exists).
    pub fn checkout(&self, main: &Repo, number: i64, worktree: Option<&str>, make: bool) -> Result<Option<Repo>> {
        if let Some(path) = worktree
            && let Some(repo) = Repo::discover(Path::new(path))?
        {
            return Ok(Some(repo));
        }
        let dir = self.dir_of(main, number);
        if dir.join(".git").exists() {
            return Ok(Repo::discover(&dir)?);
        }
        if !make || !git::branch_exists(main.root(), &issue_branch(number))? {
            return Ok(None);
        }
        let (dir, _) = self.worktree(main, number, &Self::main_branch(main)?)?;
        Ok(Repo::discover(&dir)?)
    }

    /// The issue's work as it stands: in its session's worktree, else (a
    /// parent whose children merged into it) its own checkout or branch.
    /// A child's conflicts are against `base`, others' against the main branch.
    pub fn changes(&self, main: &Repo, issue: &OnDisk, base: String, child: bool) -> Result<Changes> {
        let branch = issue_branch(issue.number);
        let (place, head) = match self.checkout(main, issue.number, issue.worktree, false)? {
            Some(place) => (place, "HEAD".to_string()),
            None if git::branch_exists(main.root(), &branch)? => (main.clone(), branch.clone()),
            None => return Err(BoardError::Other("never sent".into())),
        };
        let from = git::merge_base(place.root(), &base, &head)?;
        let commits = place.log(Some(&format!("{from}..{head}")), 0, 200)?;
        let files = place.diff(&vibevalley_git::DiffTarget::Range { from, to: head.clone() }, None)?;
        let uncommitted = if head == "HEAD" {
            place.diff(&vibevalley_git::DiffTarget::Uncommitted, None)?
        } else {
            vec![]
        };
        let target = if child { base.clone() } else { Self::main_branch(main)? };
        let conflicts = if git::branch_exists(main.root(), &branch)? {
            match main.merge_check_between(&target, &branch)? {
                MergeCheck::Conflicts(files) => files,
                _ => vec![],
            }
        } else {
            vec![]
        };
        let behind = if git::branch_exists(main.root(), &branch)? {
            git::commits_between(main.root(), &branch, &base)?
        } else {
            0
        };
        Ok(Changes {
            base,
            branch,
            worktree: place.root().to_path_buf(),
            commits,
            files,
            uncommitted,
            conflicts,
            behind,
        })
    }

    /// An accepted issue's work delivered as `deliver` says: a change is
    /// committed, checked and merged into the main branch; a branch is
    /// kept when it has commits over `base`.
    pub fn land(&self, main: &Repo, issue: &OnDisk, deliver: Deliverable, base: impl FnOnce() -> Result<String>, has_children: bool) -> Result<Landed> {
        let branch = issue_branch(issue.number);
        match deliver {
            Deliverable::PullRequest => Err(BoardError::Other("pull requests are not delivered by VibeValley yet".into())),
            Deliverable::Answer => Ok(Landed::Landed(Landing::None)),
            Deliverable::Branch => {
                let base = base()?;
                let has = git::branch_exists(main.root(), &branch)? && git::commits_between(main.root(), &base, &branch)? > 0;
                Ok(Landed::Landed(if has { Landing::Kept } else { Landing::None }))
            }
            Deliverable::Change => {
                let place = self
                    .checkout(main, issue.number, issue.worktree, has_children)?
                    .ok_or_else(|| BoardError::Other("never sent: there is no work to merge".into()))?;
                // Whatever the agent left uncommitted goes in with the rest.
                place.commit_all(&format!("Issue #{}: {}", issue.number, issue.title))?;
                let target = Self::main_branch(main)?;
                if let MergeCheck::Conflicts(files) = main.merge_check(&branch)? {
                    let files = files.iter().map(|f| f.to_string_lossy().into_owned()).collect();
                    return Ok(Landed::Conflict(Conflict { base: target, files }));
                }
                if let Err(output) = check::run_project_check(place.root()) {
                    return Ok(Landed::CheckFailed(output));
                }
                Ok(Landed::Landed(match main.merge_check(&branch)? {
                    MergeCheck::UpToDate => Landing::None,
                    _ => {
                        main.merge(&branch, Some(&format!("Merge issue #{}: {}", issue.number, issue.title)))?;
                        Landing::Merged
                    }
                }))
            }
        }
    }

    /// A child's work checked (`checks`) and merged into its parent's
    /// branch: into the parent's checkout when it has one, else straight
    /// into the branch. Not merged leaves it stuck with the reason; none
    /// when the child has no worktree to join.
    pub fn join(&self, main: &Repo, child: &OnDisk, parent: &OnDisk, checks: &CheckoutChecks) -> Result<Option<Joined>> {
        let Some(place) = child.worktree.and_then(|w| Repo::discover(Path::new(w)).ok().flatten()) else {
            return Ok(None);
        };
        let parent_branch = issue_branch(parent.number);
        let verified = place
            .commit_all(&format!("Issue #{}: {}", child.number, child.title))
            .map_err(|e| e.to_string())
            .and_then(|_| verify_checkout(place.root(), &parent_branch, checks));
        let frozen = match verified {
            Ok(frozen) => frozen,
            Err(why) => return Ok(Some(Joined::Stuck { why, conflict: None })),
        };
        let checkout = self.checkout(main, parent.number, parent.worktree, false)?;
        if checkout.is_none() && !git::branch_exists(main.root(), &parent_branch)? {
            return Err(BoardError::Other(format!("issue #{} has no branch", parent.number)));
        }
        let branch = issue_branch(child.number);
        let check = match &checkout {
            Some(target) => target.merge_check(&branch)?,
            None => main.merge_check_between(&parent_branch, &branch)?,
        };
        match check {
            MergeCheck::Conflicts(files) => {
                let files: Vec<String> = files.iter().map(|f| f.to_string_lossy().into_owned()).collect();
                let why = format!("Merging into {parent_branch} would conflict in {}", files.join(", "));
                return Ok(Some(Joined::Stuck {
                    why,
                    conflict: Some(Conflict { base: parent_branch, files }),
                }));
            }
            MergeCheck::UpToDate => {}
            MergeCheck::Clean => {
                let message = format!("Merge issue #{} into #{}", child.number, parent.number);
                match &checkout {
                    Some(target) => target.merge(&branch, Some(&message))?,
                    None => main.merge_into(&parent_branch, &branch, &message)?,
                };
            }
        }
        Ok(Some(Joined::Merged { frozen }))
    }

    /// What a leaving session leaves behind: its worktree is removed (after
    /// committing leftovers when the branch is kept), and its branch is
    /// deleted when nothing on it is unmerged (or always, for `Discard` and
    /// drafts).
    pub fn release(&self, s: &Leaving, leave: Leave) -> Result<()> {
        if leave == Leave::Keep {
            return Ok(());
        }
        let Some(main) = Repo::discover(&self.repo_dir(s.repo))? else { return Ok(()) };
        let dir = PathBuf::from(s.worktree);
        if leave == Leave::KeepBranch
            && let Some(wt) = Repo::discover(&dir)?
        {
            wt.commit_all(&format!("{}: uncommitted work when it was let go", s.name))?;
        }
        git::remove_worktree(&main, &dir)?;
        let into = s.base.clone().map(Ok).unwrap_or_else(|| Self::main_branch(&main))?;
        let discard = leave == Leave::Discard && !git::has_unmerged(main.root(), s.branch, &into).unwrap_or(true);
        if discard || s.drafting {
            git::delete_branch(main.root(), s.branch)?;
        } else {
            git::delete_branch_if_merged(main.root(), s.branch, &into)?;
        }
        Ok(())
    }

    /// A parent's own checkout, after it merged: removed, its branch too.
    pub fn clear_checkout(&self, main: &Repo, number: i64) -> Result<()> {
        git::remove_worktree(main, &self.dir_of(main, number))?;
        let target = Self::main_branch(main)?;
        git::delete_branch_if_merged(main.root(), &issue_branch(number), &target)?;
        Ok(())
    }

    /// An issue never sent is deleted: its checkout goes, and its branch
    /// unless it has work the main branch lacks (then false, nothing else gone
    /// but the checkout).
    pub fn discard(&self, main: &Repo, number: i64) -> Result<bool> {
        git::remove_worktree(main, &self.dir_of(main, number))?;
        let into = Self::main_branch(main)?;
        if git::has_unmerged(main.root(), &issue_branch(number), &into).unwrap_or(false) {
            return Ok(false);
        }
        git::delete_branch(main.root(), &issue_branch(number))?;
        Ok(true)
    }

    /// Whatever is uncommitted in `worktree` committed with `message`.
    pub fn commit_leftovers(worktree: &str, message: &str) -> Result<()> {
        if let Some(wt) = Repo::discover(Path::new(worktree)).ok().flatten() {
            wt.commit_all(message)?;
        }
        Ok(())
    }
}

/// A child's checks run in its worktree, against the parent's branch.
/// Returns the files to freeze for an acceptance child.
fn verify_checkout(root: &Path, parent_branch: &str, checks: &CheckoutChecks) -> std::result::Result<Option<Vec<String>>, String> {
    let changed = || git::changed_files(root, parent_branch).map_err(|e| e.to_string());
    match checks {
        CheckoutChecks::Acceptance { check } => {
            if check.is_empty() {
                return Err("an acceptance child needs a check command".into());
            }
            if check::run_command(root, check).is_ok() {
                return Err(format!("The acceptance check `{check}` passed; it must fail before the feature is built."));
            }
            changed().map(Some)
        }
        CheckoutChecks::Plain { frozen, checks } => {
            let check_frozen = || -> std::result::Result<(), String> {
                let touched: Vec<String> = changed()?.into_iter().filter(|f| frozen.contains(f)).collect();
                if touched.is_empty() {
                    Ok(())
                } else {
                    Err(format!("These frozen acceptance files were changed: {}", touched.join(", ")))
                }
            };
            if !frozen.is_empty() {
                check_frozen()?;
            }
            for check in checks {
                if let Err(output) = check::run_command(root, check) {
                    return Err(format!("The check `{check}` failed:\n{output}"));
                }
            }
            if !frozen.is_empty() {
                check_frozen()?;
            }
            Ok(None)
        }
    }
}
