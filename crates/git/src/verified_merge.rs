use std::path::{Path, PathBuf};

use crate::cmd::{failure, path_from_bytes, split_nul};
use crate::{GitError, MergeCheck, Repo, Result};

#[derive(Debug, PartialEq)]
pub enum VerifiedMerge {
    UpToDate,
    Conflict(Vec<PathBuf>),
    CheckFailed(String),
    Merged(String),
}

pub struct MergeRevision {
    pub target: String,
    pub source_tree: String,
    pub candidate: String,
    pub tree: String,
}

type CheckOutcome = std::result::Result<bool, String>;

struct VerifiedRefs<'a> {
    target: &'a str,
    branch: &'a str,
    message: &'a str,
    source: &'a str,
    source_ref: &'a str,
    target_ref: &'a str,
}

struct PreparedCandidate<'a> {
    base: String,
    tip: String,
    candidate: Candidate<'a>,
}

enum Prepared<'a> {
    Candidate(PreparedCandidate<'a>),
    Conflict(Vec<PathBuf>),
}

struct EvaluatedCandidate {
    tip: String,
    result: CheckOutcome,
}

struct Candidate<'a> {
    owner: &'a Repo,
    repo: Repo,
    _dir: tempfile::TempDir,
}

impl<'a> Candidate<'a> {
    fn checkout(owner: &'a Repo, commit: &str) -> Result<Self> {
        let dir = tempfile::Builder::new()
            .prefix("vibevalley-merge-")
            .tempdir()
            .map_err(|e| GitError::Io(e.to_string()))?;
        let path = dir.path().join("checkout");
        owner
            .git("worktree")
            .args(["add", "--quiet", "--detach", "--"])
            .arg(&path)
            .arg(commit)
            .user_facing()
            .run()?;
        Ok(Self {
            owner,
            repo: Repo { root: path },
            _dir: dir,
        })
    }
}

impl Drop for Candidate<'_> {
    fn drop(&mut self) {
        let _ = self.owner.worktree_remove(self.repo.root(), true);
    }
}

impl Repo {
    fn protect_existing_files(&self, base: &str, tip: &str) -> Result<()> {
        // receive-pack protects modified tracked files, but Git may overwrite an ignored file on checkout.
        let added = self
            .git("diff")
            .args(["--name-only", "--diff-filter=A", "--no-renames", "-z", base, tip, "--"])
            .read()
            .run()?;
        for path in split_nul(&added.stdout).map(path_from_bytes) {
            let mut components = path.ancestors().filter(|p| !p.as_os_str().is_empty());
            let blocking = components.find(|p| self.root().join(p).symlink_metadata().is_ok_and(|m| *p == path || !m.is_dir()));
            if let Some(blocking) = blocking {
                let others = self.git("ls-files").args(["--others", "-z", "--"]).arg(blocking).read().run()?;
                if !others.stdout.is_empty() {
                    return Err(GitError::Command {
                        command: "merge".into(),
                        stderr: format!("local file would be overwritten: {}", blocking.display()),
                    });
                }
            }
        }
        Ok(())
    }

    /// Checks a detached integration commit. A moving target invalidates the check; a moving source needs another delivery.
    pub fn merge_verified<E: From<GitError>>(
        &self,
        target: &str,
        branch: &str,
        message: &str,
        mut check: impl FnMut(&Path) -> CheckOutcome,
        mut record: impl FnMut(MergeRevision, &CheckOutcome) -> std::result::Result<(), E>,
    ) -> std::result::Result<VerifiedMerge, E> {
        let source_ref = format!("refs/heads/{branch}");
        let source = self.require_commit("merge", &source_ref)?;
        let source_tree = self.tree_id(&source)?;
        let target_ref = format!("refs/heads/{target}");
        let refs = VerifiedRefs {
            target,
            branch,
            message,
            source: &source,
            source_ref: &source_ref,
            target_ref: &target_ref,
        };
        loop {
            let prepared = match self.prepare_verified_candidate(&refs)? {
                Prepared::Candidate(prepared) => prepared,
                Prepared::Conflict(paths) => return Ok(VerifiedMerge::Conflict(paths)),
            };
            let base = prepared.base.clone();
            let Some(evaluated) = self.evaluate_verified_candidate(&refs, prepared, |root| check(root))? else {
                continue;
            };
            record(
                MergeRevision {
                    target: base.clone(),
                    source_tree: source_tree.clone(),
                    candidate: evaluated.tip.clone(),
                    tree: self.tree_id(&evaluated.tip)?,
                },
                &evaluated.result,
            )?;
            if let Some(outcome) = self.publish_verified_candidate(&target_ref, &base, &evaluated.tip, evaluated.result)? {
                return Ok(outcome);
            }
        }
    }

    pub async fn merge_verified_async<E: From<GitError>, F: std::future::Future<Output = std::result::Result<(), E>> + Send>(
        &self,
        target: &str,
        branch: &str,
        message: &str,
        mut check: impl FnMut(&Path) -> CheckOutcome,
        mut record: impl FnMut(MergeRevision, &CheckOutcome) -> F,
    ) -> std::result::Result<VerifiedMerge, E> {
        let source_ref = format!("refs/heads/{branch}");
        let source = self.require_commit("merge", &source_ref)?;
        let source_tree = self.tree_id(&source)?;
        let target_ref = format!("refs/heads/{target}");
        let refs = VerifiedRefs {
            target,
            branch,
            message,
            source: &source,
            source_ref: &source_ref,
            target_ref: &target_ref,
        };
        loop {
            let prepared = match self.prepare_verified_candidate(&refs)? {
                Prepared::Candidate(prepared) => prepared,
                Prepared::Conflict(paths) => return Ok(VerifiedMerge::Conflict(paths)),
            };
            let base = prepared.base.clone();
            let Some(evaluated) = self.evaluate_verified_candidate(&refs, prepared, |root| check(root))? else {
                continue;
            };
            record(
                MergeRevision {
                    target: base.clone(),
                    source_tree: source_tree.clone(),
                    candidate: evaluated.tip.clone(),
                    tree: self.tree_id(&evaluated.tip)?,
                },
                &evaluated.result,
            )
            .await?;
            if let Some(outcome) = self.publish_verified_candidate(&target_ref, &base, &evaluated.tip, evaluated.result)? {
                return Ok(outcome);
            }
        }
    }

    fn prepare_verified_candidate<'a>(&'a self, refs: &VerifiedRefs<'_>) -> Result<Prepared<'a>> {
        let checkout = self.status()?;
        if checkout.branch.as_deref() != Some(refs.target) {
            return Err(GitError::Command {
                command: "merge".into(),
                stderr: format!("expected {} to be checked out", refs.target),
            });
        }
        let base = checkout.head.ok_or_else(|| GitError::Parse("cannot deliver to an unborn branch".into()))?;
        let merge = self.trial_merge(&base, refs.source)?;
        if let MergeCheck::Conflicts(paths) = merge {
            return Ok(Prepared::Conflict(paths));
        }
        let candidate = Candidate::checkout(self, &base)?;
        let tip = if merge == MergeCheck::UpToDate {
            base.clone()
        } else {
            candidate
                .repo
                .git("merge")
                .args(["--quiet", "--no-edit", "-m", refs.message, refs.source])
                .user_facing()
                .run()?;
            candidate.repo.require_commit("merge", "HEAD")?
        };
        Ok(Prepared::Candidate(PreparedCandidate { base, tip, candidate }))
    }

    fn evaluate_verified_candidate(
        &self,
        refs: &VerifiedRefs<'_>,
        prepared: PreparedCandidate<'_>,
        mut check: impl FnMut(&Path) -> CheckOutcome,
    ) -> Result<Option<EvaluatedCandidate>> {
        let PreparedCandidate { base, tip, candidate } = prepared;
        let mut result = check(candidate.repo.root());
        if self.require_commit("merge", refs.source_ref)? != refs.source {
            return Err(GitError::Command {
                command: "merge".into(),
                stderr: format!("{} changed during delivery; review the new changes", refs.branch),
            });
        }
        if self.require_commit("merge", refs.target_ref)? != base {
            return Ok(None);
        }
        let clean = candidate.repo.git("diff").args(["--quiet", &tip, "--"]).read().output()?;
        if clean.code == 1 || candidate.repo.head()?.as_ref() != Some(&tip) {
            result = Err("project check changed the candidate commit or its tracked files".into());
        } else if !clean.ok() {
            return Err(failure("diff", &clean));
        }
        // A persisted receipt names this object even when the check fails or the process stops before delivery.
        self.git("update-ref").arg(format!("refs/vibevalley/checks/{tip}")).arg(&tip).run()?;
        drop(candidate);
        Ok(Some(EvaluatedCandidate { tip, result }))
    }

    fn publish_verified_candidate(
        &self,
        target_ref: &str,
        base: &str,
        tip: &str,
        result: std::result::Result<bool, String>,
    ) -> std::result::Result<Option<VerifiedMerge>, GitError> {
        if let Err(output) = result {
            return Ok(Some(VerifiedMerge::CheckFailed(output)));
        }
        if tip == base {
            return Ok(Some(VerifiedMerge::UpToDate));
        }
        self.protect_existing_files(base, tip)?;
        // Local receive-pack moves only the named ref at its expected tip and updates its checkout.
        // send-pack uses a filesystem path, without a remote or a pre-push hook.
        let out = self
            .git("send-pack")
            .arg("--receive-pack=git -c core.hooksPath=/dev/null -c receive.denyCurrentBranch=updateInstead receive-pack")
            .arg(format!("--force-with-lease={target_ref}:{base}"))
            .arg("--")
            .arg(self.root())
            .arg(format!("{tip}:{target_ref}"))
            .user_facing()
            .output()?;
        if out.ok() {
            return Ok(Some(VerifiedMerge::Merged(tip.to_string())));
        }
        if self.require_commit("merge", target_ref)? == base {
            return Err(failure("merge", &out));
        }
        Ok(None)
    }
}
