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
        mut check: impl FnMut(&Path) -> std::result::Result<bool, String>,
        mut record: impl FnMut(MergeRevision, &std::result::Result<bool, String>) -> std::result::Result<(), E>,
    ) -> std::result::Result<VerifiedMerge, E> {
        let source_ref = format!("refs/heads/{branch}");
        let source = self.require_commit("merge", &source_ref)?;
        let source_tree = self.tree_id(&source)?;
        let target_ref = format!("refs/heads/{target}");
        loop {
            let checkout = self.status()?;
            if checkout.branch.as_deref() != Some(target) {
                return Err(GitError::Command {
                    command: "merge".into(),
                    stderr: format!("expected {target} to be checked out"),
                }
                .into());
            }
            let base = checkout.head.ok_or_else(|| GitError::Parse("cannot deliver to an unborn branch".into()))?;
            let merge = self.trial_merge(&base, &source)?;
            if let MergeCheck::Conflicts(paths) = merge {
                return Ok(VerifiedMerge::Conflict(paths));
            }
            let candidate = Candidate::checkout(self, &base)?;
            let tip = if merge == MergeCheck::UpToDate {
                base.clone()
            } else {
                candidate
                    .repo
                    .git("merge")
                    .args(["--quiet", "--no-edit", "-m", message, &source])
                    .user_facing()
                    .run()?;
                candidate.repo.require_commit("merge", "HEAD")?
            };
            let mut result = check(candidate.repo.root());
            if self.require_commit("merge", &source_ref)? != source {
                return Err(GitError::Command {
                    command: "merge".into(),
                    stderr: format!("{branch} changed during delivery; review the new changes"),
                }
                .into());
            }
            if self.require_commit("merge", &target_ref)? != base {
                continue;
            }
            let clean = candidate.repo.git("diff").args(["--quiet", &tip, "--"]).read().output()?;
            if clean.code == 1 || candidate.repo.head()?.as_ref() != Some(&tip) {
                result = Err("project check changed the candidate commit or its tracked files".into());
            } else if !clean.ok() {
                return Err(failure("diff", &clean).into());
            }
            // A persisted receipt names this object even when the check fails or the process stops before delivery.
            self.git("update-ref").arg(format!("refs/vibevalley/checks/{tip}")).arg(&tip).run()?;
            drop(candidate);
            record(
                MergeRevision {
                    target: base.clone(),
                    source_tree: source_tree.clone(),
                    candidate: tip.clone(),
                    tree: self.tree_id(&tip)?,
                },
                &result,
            )?;
            if let Err(output) = result {
                return Ok(VerifiedMerge::CheckFailed(output));
            }
            if tip == base {
                return Ok(VerifiedMerge::UpToDate);
            }
            self.protect_existing_files(&base, &tip)?;
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
                return Ok(VerifiedMerge::Merged(tip));
            }
            if self.require_commit("merge", &target_ref)? == base {
                return Err(failure("merge", &out).into());
            }
        }
    }
}
