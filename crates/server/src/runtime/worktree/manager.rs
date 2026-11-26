use std::path::{Path, PathBuf};

use vibevalley_core::CheckoutChecks;
use vibevalley_git::{MergeCheck, Repo, VerifiedMerge};
use vibevalley_protocol::{Conflict, Deliverable, Landing, ProjectCheckReceipt, ProjectCheckStatus, ReviewRevision};

use super::check;
use crate::runtime::{Result, RuntimeError, io};

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
    Integrated,
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
    pub revision: ReviewRevision,
    pub since_review: Option<Vec<vibevalley_git::FileDiff>>,
    pub branch: String,
    pub worktree: PathBuf,
    pub commits: Vec<vibevalley_git::Commit>,
    pub files: Vec<vibevalley_git::FileDiff>,
    pub uncommitted: Vec<vibevalley_git::FileDiff>,
    pub conflicts: Vec<PathBuf>,
    /// Commits on the base its branch does not have.
    pub behind: usize,
}

/// An accepted issue's work, as `land_async` left it.
#[derive(Debug, Clone, PartialEq)]
pub enum Landed {
    Landed(Landing),
    Merged(String),
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

/// The issue being landed or joined, as far as its worktree cares.
pub struct OnDisk<'a> {
    pub number: i64,
    pub title: &'a str,
    /// The worktree its session works in, while one is on the board.
    pub worktree: Option<&'a str>,
}

pub struct Delivery<'a> {
    pub work: OnDisk<'a>,
    pub kind: Deliverable,
    pub has_children: bool,
    pub evidence: Option<&'a vibevalley_protocol::DeliveryEvidence>,
}

/// Manages git worktrees, branches, merges, and check scripts on disk.
pub struct Worktree {
    worktrees_dir: PathBuf,
    repos_dir: Option<PathBuf>,
    data_dir: PathBuf,
    repo: Option<std::sync::Arc<crate::repo::Repo>>,
}

impl Worktree {
    pub fn new(worktrees_dir: PathBuf, repos_dir: Option<PathBuf>, data_dir: PathBuf) -> Worktree {
        Self::with_repo(worktrees_dir, repos_dir, data_dir, None)
    }

    pub fn with_repo(worktrees_dir: PathBuf, repos_dir: Option<PathBuf>, data_dir: PathBuf, repo: Option<std::sync::Arc<crate::repo::Repo>>) -> Worktree {
        Worktree {
            worktrees_dir,
            repos_dir,
            data_dir,
            repo,
        }
    }

    /// Where an issue's `repo` is: a mounted external repo by name, a bare
    /// name under `repos_dir`, else the path as written.
    pub fn repo_dir(&self, repo: &str) -> PathBuf {
        if !repo.is_empty()
            && !repo.contains('/')
            && !repo.contains('\\')
            && let Some(mounted) = self.repo.as_ref().and_then(|r| r.mounted_path(repo))
        {
            return mounted;
        }
        match &self.repos_dir {
            Some(root) if !repo.is_empty() && !repo.contains('/') => root.join(repo),
            _ => PathBuf::from(repo),
        }
    }

    /// How an issue names a repository's top: its managed/mounted name when
    /// registered in `Repo` or right under `repos_dir`, else its path.
    pub async fn repo_ref_async(&self, top: &Path) -> String {
        if let Some(repo) = &self.repo
            && let Some(name) = repo.name_for_path_async(top).await
        {
            return name;
        }
        if let Some(root) = &self.repos_dir {
            let root = tokio::fs::canonicalize(root).await.unwrap_or_else(|_| root.clone());
            let top = tokio::fs::canonicalize(top).await.unwrap_or_else(|_| top.to_path_buf());
            if top.parent() == Some(root.as_path())
                && let Some(name) = top.file_name()
            {
                return name.to_string_lossy().into_owned();
            }
        }
        top.to_string_lossy().into_owned()
    }

    /// `<work root>/AGENTS.md`, the rules every repo on this machine shares.
    pub async fn house_rules_async(&self) -> String {
        let Some(root) = self.repos_dir.as_deref().and_then(Path::parent) else {
            return String::new();
        };
        tokio::fs::read_to_string(root.join("AGENTS.md")).await.unwrap_or_default()
    }

    /// The repo at `dir`; a folder under the work root that is not one yet
    /// (or not there) becomes one, with a first empty commit.
    pub async fn ensure_repo_async(&self, dir: PathBuf) -> Result<Repo> {
        if let Some(repo) = Repo::discover_async(&dir).await? {
            return Ok(repo);
        }
        let ours = self.repos_dir.as_ref().is_some_and(|root| dir.starts_with(root));
        if !ours {
            return Err(RuntimeError::NotARepo(dir));
        }
        let repo = vibevalley_git::init_async(&dir, Some("main")).await?;
        let out = repo
            .run_async(&[
                "-c",
                "user.name=vibevalley",
                "-c",
                "user.email=vibevalley@localhost",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "Start",
            ])
            .await?;
        if !out.ok() {
            return Err(RuntimeError::Other(out.stderr));
        }
        Ok(repo)
    }

    /// The repository an issue names, made when it is ours and missing.
    pub async fn main_repo_async(&self, repo: Option<&str>) -> Result<Option<Repo>> {
        match repo {
            Some(r) => Ok(Some(self.ensure_repo_async(self.repo_dir(r)).await?)),
            None => Ok(None),
        }
    }

    /// The repository at `repo` as it is, made of nothing.
    pub fn existing(&self, repo: &str) -> Result<Option<Repo>> {
        Ok(Repo::discover(&self.repo_dir(repo))?)
    }

    /// Reads the `origin` git remote URL for `repo` if a local checkout exists with one.
    pub fn repo_remote_url(&self, repo: &str) -> Option<String> {
        let found = self.existing(repo).ok().flatten()?;
        found.remote_url("origin").ok().flatten()
    }

    pub fn main_branch(main: &Repo) -> Result<String> {
        main.current_branch()?
            .ok_or_else(|| RuntimeError::Other("the main checkout has no branch checked out".into()))
    }

    /// The branch an issue's work forks from: its parent's (made from the
    /// main branch when the parent never had one), else the main branch.
    pub fn base(&self, main: &Repo, parent: Option<i64>) -> Result<String> {
        let Some(parent) = parent else {
            return Self::main_branch(main);
        };
        let branch = issue_branch(parent);
        if !main.branch_exists(&branch)? {
            main.create_branch(&branch, Some(&Self::main_branch(main)?))?;
        }
        Ok(branch)
    }

    fn dir_of(&self, main: &Repo, number: i64) -> PathBuf {
        let name = self
            .repo
            .as_ref()
            .and_then(|r| r.name_for_path_sync(main.root()))
            .or_else(|| main.root().file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_default();
        self.worktrees_dir.join(format!("{name}.{number}"))
    }

    /// The worktree issue `number` works in: `<worktrees>/<repo>.<number>`
    /// on its branch, cut from `base`.
    pub async fn worktree_async(&self, main: &Repo, number: i64, base: &str) -> Result<(PathBuf, String)> {
        let dir = self.dir_of(main, number);
        let branch = issue_branch(number);
        if tokio::fs::try_exists(dir.join(".git")).await.unwrap_or(false) {
            return Ok((dir, branch));
        }
        tokio::fs::create_dir_all(&self.worktrees_dir).await.map_err(io)?;
        if main.branch_exists_async(&branch).await? {
            main.worktree_add_on_async(&dir, &branch).await?;
        } else {
            main.worktree_add_async(&dir, &branch, Some(base)).await?;
        }
        Ok((dir, branch))
    }

    /// A new worktree for issue `number` from the main branch, whatever was
    /// there before gone: where a draft starts. Its dir, branch and base.
    pub async fn fresh_worktree_async(&self, main: &Repo, number: i64) -> Result<(PathBuf, String, String)> {
        let base = Self::main_branch(main)?;
        let dir_old = self.dir_of(main, number);
        remove_worktree_async(main, &dir_old).await?;
        main.delete_branch_async(&issue_branch(number)).await?;
        let (dir, branch) = self.worktree_async(main, number, &base).await?;
        Ok((dir, branch, base))
    }

    /// The folder a session works in when its issue has no repository.
    pub async fn context_async(&self, issue: &str) -> Result<PathBuf> {
        let dir = self.data_dir.join("contexts").join(issue);
        tokio::fs::create_dir_all(&dir).await.map_err(io)?;
        Ok(dir)
    }

    /// Where the issue's work is: its session's worktree, or its own
    /// checkout (made when `make` and its branch exists).
    pub async fn checkout_async(&self, main: &Repo, number: i64, worktree: Option<&str>, make: bool) -> Result<Option<Repo>> {
        if let Some(path) = worktree
            && let Some(repo) = Repo::discover_async(Path::new(path)).await?
        {
            return Ok(Some(repo));
        }
        let dir = self.dir_of(main, number);
        if tokio::fs::try_exists(dir.join(".git")).await.unwrap_or(false) {
            return Ok(Repo::discover_async(&dir).await?);
        }
        if !make || !main.branch_exists_async(&issue_branch(number)).await? {
            return Ok(None);
        }
        let (dir, _) = self.worktree_async(main, number, &Self::main_branch(main)?).await?;
        Ok(Repo::discover_async(&dir).await?)
    }

    pub fn published_changes(main: &Repo, number: i64, revision: ReviewRevision, receipt: &ProjectCheckReceipt, previous: Option<&str>) -> Result<Changes> {
        let files = tree_diff(main, &revision.base_commit, &revision.tree)?;
        let since_review = changes_since(main, &revision.tree, previous)?;
        Ok(Changes {
            base: receipt.target_branch.clone(),
            branch: issue_branch(number),
            worktree: main.root().to_path_buf(),
            commits: main.log(Some(&format!("{}..{}", receipt.target_commit, receipt.candidate_commit)), 0, 200)?,
            files,
            revision,
            since_review,
            uncommitted: vec![],
            conflicts: vec![],
            behind: 0,
        })
    }

    /// The issue's work as it stands: in its session's worktree, else (a
    /// parent whose children merged into it) its own checkout or branch.
    /// A child's conflicts are against `base`, others' against the main branch.
    pub async fn changes_async(&self, main: &Repo, issue: &OnDisk<'_>, base: String, child: bool, reviewed_tree: Option<&str>) -> Result<Changes> {
        let branch = issue_branch(issue.number);
        let (place, head) = match self.checkout_async(main, issue.number, issue.worktree, false).await? {
            Some(place) => (place, "HEAD".to_string()),
            None if main.branch_exists_async(&branch).await? => (main.clone(), branch.clone()),
            None => return Err(RuntimeError::Other("never sent".into())),
        };
        let on_worktree = head == "HEAD";
        let head = place.commit_id_async(&head).await?;
        let from = place.merge_base_async(&base, &head).await?;
        let tree = if on_worktree {
            place.worktree_tree_async().await?
        } else {
            place.tree_id_async(&head).await?
        };
        let commits = place.log_async(Some(&format!("{from}..{head}")), 0, 200).await?;
        let files = tree_diff_async(&place, &from, &tree).await?;
        let uncommitted = if on_worktree { tree_diff_async(&place, &head, &tree).await? } else { vec![] };
        let since_review = changes_since_async(&place, &tree, reviewed_tree).await?;
        let revision = ReviewRevision { base_commit: from, tree };
        let target = if child { base.clone() } else { Self::main_branch(main)? };
        let branch_exists = main.branch_exists_async(&branch).await?;
        let conflicts = if branch_exists {
            match main.merge_check_between_async(&target, &branch).await? {
                MergeCheck::Conflicts(files) => files,
                _ => vec![],
            }
        } else {
            vec![]
        };
        let behind = if branch_exists {
            main.commits_between_async(&branch, &base).await?
        } else {
            0
        };
        Ok(Changes {
            revision,
            since_review,
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
    pub fn land_async<'a>(
        &'a self,
        main: &'a Repo,
        delivery: Delivery<'a>,
        base: impl FnOnce() -> Result<String> + Send + 'a,
        mut save: impl FnMut(ProjectCheckReceipt) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> + Send + 'a,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Landed>> + Send + 'a>> {
        Box::pin(async move {
            let Delivery {
                work: issue,
                kind,
                has_children,
                evidence,
            } = delivery;
            let branch = issue_branch(issue.number);
            match kind {
                Deliverable::PullRequest => Ok(Landed::Landed(Landing::Submitted)),
                Deliverable::Answer => Ok(Landed::Landed(Landing::None)),
                Deliverable::Branch => {
                    let base = base()?;
                    let has = main.branch_exists_async(&branch).await? && main.commits_between_async(&base, &branch).await? > 0;
                    Ok(Landed::Landed(if has { Landing::Kept } else { Landing::None }))
                }
                Deliverable::Change => {
                    let target = base()?;
                    let checkout = self.checkout_async(main, issue.number, issue.worktree, has_children).await?;
                    let reviewed = evidence.and_then(|e| e.reviews.last());
                    let checked = evidence.and_then(|e| e.check.as_ref());
                    let current_tree = match checkout.as_ref() {
                        Some(r) => Some(r.worktree_tree_async().await?),
                        None => None,
                    };
                    if let Some(tree) = &current_tree
                        && reviewed.is_some_and(|r| &r.revision.tree != tree)
                    {
                        return Err(RuntimeError::Other(vibevalley_i18n::t("server.issue.reviewChanged", &[])));
                    }
                    if let Some(last) = checked
                        && self.was_published(main, &branch, current_tree.as_deref(), last)?
                    {
                        return Ok(Landed::Merged(last.candidate_commit.clone()));
                    }
                    let place = checkout.ok_or_else(|| RuntimeError::Other("never sent: there is no work to merge".into()))?;
                    if place.current_branch_async().await?.as_deref() != Some(&branch) {
                        return Err(RuntimeError::Other(format!("expected the issue checkout to be on {branch}")));
                    }
                    place.commit_all_async(&format!("Issue #{}: {}", issue.number, issue.title)).await?;
                    let message = format!("Merge issue #{}: {}", issue.number, issue.title);
                    let place_ref = &place;
                    let target_ref = &target;
                    let record = |rev: vibevalley_git::MergeRevision,
                                  result: &std::result::Result<bool, String>|
                     -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + '_>> {
                        let status = match result {
                            Ok(true) => ProjectCheckStatus::Passed,
                            Ok(false) => ProjectCheckStatus::NotConfigured,
                            Err(_) => ProjectCheckStatus::Failed,
                        };
                        let receipt = ProjectCheckReceipt {
                            target_branch: target_ref.clone(),
                            target_commit: rev.target,
                            source_tree: rev.source_tree.clone(),
                            candidate_commit: rev.candidate,
                            candidate_tree: rev.tree,
                            status,
                            command: (status != ProjectCheckStatus::NotConfigured).then(|| ".vibevalley/check".into()),
                            output: result.as_ref().err().cloned(),
                        };
                        let stale_reviewed = reviewed.is_some_and(|r| r.revision.tree != rev.source_tree);
                        let source_tree = rev.source_tree;
                        if stale_reviewed {
                            return Box::pin(async { Err(RuntimeError::Other(vibevalley_i18n::t("server.issue.reviewChanged", &[]))) });
                        }
                        let save_fut = save(receipt);
                        Box::pin(async move {
                            if place_ref.worktree_tree_async().await.ok().as_ref() != Some(&source_tree) {
                                return Err(RuntimeError::Other(vibevalley_i18n::t("server.issue.reviewChanged", &[])));
                            }
                            save_fut.await
                        })
                    };
                    Ok(
                        match main
                            .merge_verified_async(&target, &branch, &message, |root| async move { check::run_project_check(&root).await }, record)
                            .await?
                        {
                            VerifiedMerge::Conflict(paths) => Landed::Conflict(Conflict {
                                base: target,
                                files: paths.into_iter().map(|f| f.to_string_lossy().into_owned()).collect(),
                            }),
                            VerifiedMerge::CheckFailed(output) => Landed::CheckFailed(output),
                            VerifiedMerge::UpToDate => Landed::Landed(Landing::None),
                            VerifiedMerge::Merged(commit) => Landed::Merged(commit),
                        },
                    )
                }
            }
        })
    }

    pub fn was_published(&self, main: &Repo, branch: &str, worktree_tree: Option<&str>, last: &ProjectCheckReceipt) -> Result<bool> {
        Ok(last.status != ProjectCheckStatus::Failed
            && last.target_commit != last.candidate_commit
            && worktree_tree.is_none_or(|tree| tree == last.source_tree)
            && (!main.branch_exists(branch)? || main.tree_id(branch)? == last.source_tree)
            && main.contains_commit(&format!("refs/heads/{}", last.target_branch), &last.candidate_commit)?)
    }

    /// A child's work checked (`checks`) and merged into its parent's
    /// branch: into the parent's checkout when it has one, else straight
    /// into the branch. Not merged leaves it stuck with the reason; none
    /// when the child has no worktree to join.
    pub async fn join_async(&self, main: &Repo, child: &OnDisk<'_>, parent: &OnDisk<'_>, checks: &CheckoutChecks) -> Result<Option<Joined>> {
        let Some(wt_path) = child.worktree else {
            return Ok(None);
        };
        let Some(place) = Repo::discover_async(Path::new(wt_path)).await.ok().flatten() else {
            return Ok(None);
        };
        let parent_branch = issue_branch(parent.number);
        let verified = match place.commit_all_async(&format!("Issue #{}: {}", child.number, child.title)).await {
            Ok(_) => verify_checkout_async(&place, &parent_branch, checks).await,
            Err(e) => Err(e.to_string()),
        };
        let frozen = match verified {
            Ok(frozen) => frozen,
            Err(why) => return Ok(Some(Joined::Stuck { why, conflict: None })),
        };
        let checkout = self.checkout_async(main, parent.number, parent.worktree, false).await?;
        if checkout.is_none() && !main.branch_exists_async(&parent_branch).await? {
            return Err(RuntimeError::Other(format!("issue #{} has no branch", parent.number)));
        }
        let branch = issue_branch(child.number);
        let check = match &checkout {
            Some(target) => target.merge_check_async(&branch).await?,
            None => main.merge_check_between_async(&parent_branch, &branch).await?,
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
                    Some(target) => target.merge_async(&branch, Some(&message)).await?,
                    None => main.merge_into_async(&parent_branch, &branch, &message).await?,
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
        if leave == Leave::Integrated && dir.exists() {
            main.worktree_remove(&dir, false)?;
        } else {
            remove_worktree(&main, &dir)?;
        }
        let into = s.base.clone().map(Ok).unwrap_or_else(|| Self::main_branch(&main))?;
        let discard = leave == Leave::Discard && !main.has_unmerged(s.branch, &into).unwrap_or(true);
        if discard || s.drafting {
            main.delete_branch(s.branch)?;
        } else {
            main.delete_branch_if_merged(s.branch, &into)?;
        }
        Ok(())
    }

    /// A parent's own checkout, after it merged: removed, its branch too.
    pub fn clear_checkout(&self, main: &Repo, number: i64) -> Result<()> {
        let dir = self.dir_of(main, number);
        if dir.exists() {
            main.worktree_remove(&dir, false)?;
        }
        let target = Self::main_branch(main)?;
        main.delete_branch_if_merged(&issue_branch(number), &target)?;
        Ok(())
    }

    /// An issue never sent is deleted: its checkout goes, and its branch
    /// unless it has work the main branch lacks (then false, nothing else gone
    /// but the checkout).
    pub fn discard(&self, main: &Repo, number: i64) -> Result<bool> {
        remove_worktree(main, &self.dir_of(main, number))?;
        let into = Self::main_branch(main)?;
        if main.has_unmerged(&issue_branch(number), &into).unwrap_or(false) {
            return Ok(false);
        }
        main.delete_branch(&issue_branch(number))?;
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

fn remove_worktree(main: &Repo, dir: &Path) -> Result<()> {
    if dir.exists() {
        main.worktree_remove(dir, true)?;
    }
    let _ = main.worktree_prune();
    Ok(())
}

async fn remove_worktree_async(main: &Repo, dir: &Path) -> Result<()> {
    if tokio::fs::try_exists(dir).await.unwrap_or(false) {
        main.worktree_remove_async(dir, true).await?;
    }
    let _ = main.worktree_prune_async().await;
    Ok(())
}

fn tree_diff(repo: &Repo, from: &str, to: &str) -> Result<Vec<vibevalley_git::FileDiff>> {
    Ok(repo.diff(
        &vibevalley_git::DiffTarget::Range {
            from: from.into(),
            to: to.into(),
        },
        None,
    )?)
}

async fn tree_diff_async(repo: &Repo, from: &str, to: &str) -> Result<Vec<vibevalley_git::FileDiff>> {
    Ok(repo
        .diff_async(
            &vibevalley_git::DiffTarget::Range {
                from: from.into(),
                to: to.into(),
            },
            None,
        )
        .await?)
}

fn changes_since(repo: &Repo, tree: &str, previous: Option<&str>) -> Result<Option<Vec<vibevalley_git::FileDiff>>> {
    let Some(previous) = previous.filter(|previous| *previous != tree) else {
        return Ok(None);
    };
    if !matches!(previous.len(), 40 | 64) || !previous.bytes().all(|c| c.is_ascii_hexdigit()) || repo.tree_id(previous)? != previous {
        return Err(RuntimeError::Other("expected a Git tree object ID for the previous review".into()));
    }
    Ok(Some(tree_diff(repo, previous, tree)?))
}

async fn changes_since_async(repo: &Repo, tree: &str, previous: Option<&str>) -> Result<Option<Vec<vibevalley_git::FileDiff>>> {
    let Some(previous) = previous.filter(|previous| *previous != tree) else {
        return Ok(None);
    };
    if !matches!(previous.len(), 40 | 64) || !previous.bytes().all(|c| c.is_ascii_hexdigit()) || repo.tree_id_async(previous).await? != previous {
        return Err(RuntimeError::Other("expected a Git tree object ID for the previous review".into()));
    }
    Ok(Some(tree_diff_async(repo, previous, tree).await?))
}

/// A child's checks run in its worktree, against the parent's branch.
/// Returns the files to freeze for an acceptance child.
async fn verify_checkout_async(place: &Repo, parent_branch: &str, checks: &CheckoutChecks) -> std::result::Result<Option<Vec<String>>, String> {
    let root = place.root();
    match checks {
        CheckoutChecks::Acceptance { check } => {
            if check.is_empty() {
                return Err("an acceptance child needs a check command".into());
            }
            if check::run_command(root, check).await.is_ok() {
                return Err(format!("The acceptance check `{check}` passed; it must fail before the feature is built."));
            }
            place.changed_files_async(parent_branch).await.map_err(|e| e.to_string()).map(Some)
        }
        CheckoutChecks::Plain { frozen, checks } => {
            let check_frozen = || async {
                let changed = place.changed_files_async(parent_branch).await.map_err(|e| e.to_string())?;
                let touched: Vec<String> = changed.into_iter().filter(|f| frozen.contains(f)).collect();
                if touched.is_empty() {
                    Ok(())
                } else {
                    Err(format!("These frozen acceptance files were changed: {}", touched.join(", ")))
                }
            };
            if !frozen.is_empty() {
                check_frozen().await?;
            }
            for check in checks {
                if let Err(output) = check::run_command(root, check).await {
                    return Err(format!("The check `{check}` failed:\n{output}"));
                }
            }
            if !frozen.is_empty() {
                check_frozen().await?;
            }
            Ok(None)
        }
    }
}
