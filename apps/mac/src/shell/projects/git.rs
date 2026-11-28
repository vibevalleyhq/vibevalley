use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::time::Duration;

use gpui::{AppContext as _, Context, Window};
use vibevalley_files::{FsChange, Watcher};
use vibevalley_git::{Branch, Commit, Repo, Status, Worktree};
use vibevalley_workspace::ProjectId;

use crate::hosted::frames;
use crate::panes::PaneEntity;

use super::super::{GitSummary, Shell};
use super::SidebarTopics;

type GitSnapshot = (
    Repo,
    Status,
    Vec<Branch>,
    Vec<Worktree>,
    HashMap<PathBuf, frames::WorktreeActivity>,
    Vec<Commit>,
);

impl Shell {
    /// Reads the branch and worktrees of every project the sidebar lists.
    pub fn refresh_summaries(&mut self, cx: &mut Context<Self>) {
        self.workspace.summaries_gen = self.workspace.summaries_gen.wrapping_add(1);
        let generation = self.workspace.summaries_gen;
        let roots: Vec<(ProjectId, PathBuf)> = self.workspace.ws.projects().iter().map(|p| (p.id(), p.root().to_path_buf())).collect();
        Self::bg(
            cx,
            move || {
                roots
                    .into_iter()
                    .filter_map(|(id, root)| {
                        let repo = Repo::discover(&root).ok()??;
                        let branch = repo.status().ok().and_then(|s| s.branch);
                        let worktrees = repo.worktrees().unwrap_or_default();
                        Some((id, GitSummary { branch, worktrees }))
                    })
                    .collect::<Vec<_>>()
            },
            move |s, read, cx| {
                if s.workspace.summaries_gen != generation {
                    return;
                }
                let next: HashMap<ProjectId, GitSummary> = read.into_iter().collect();
                if s.workspace.git_summaries != next {
                    s.workspace.git_summaries = next;
                    s.push_sidebar_topics(SidebarTopics::RAIL, cx);
                }
            },
        );
    }

    pub fn refresh_git(&mut self, id: ProjectId, cx: &mut Context<Self>) {
        let Some(pv) = self.workspace.projects.get_mut(&id) else { return };
        pv.git_gen = pv.git_gen.wrapping_add(1);
        let generation = pv.git_gen;
        pv.git_busy = true;
        let root = pv.tree.root.clone();
        Self::bg(
            cx,
            move || -> Result<Option<GitSnapshot>, String> {
                let Some(repo) = Repo::discover(&root).map_err(|e| e.to_string())? else {
                    return Ok(None);
                };
                let status = repo.status().map_err(|e| e.to_string())?;
                let branches = repo.branches().unwrap_or_default();
                let worktrees = repo.worktrees().unwrap_or_default();
                let log = repo.log(None, 0, 50).unwrap_or_default();
                let mut worktree_activity = HashMap::new();
                if worktrees.len() > 1 {
                    let cur_root = repo.root().to_path_buf();
                    for w in &worktrees {
                        let act = if w.path == cur_root {
                            let conflicts = status
                                .entries
                                .iter()
                                .filter(|e| e.index == vibevalley_git::Change::Conflicted || e.worktree == vibevalley_git::Change::Conflicted)
                                .count();
                            frames::WorktreeActivity {
                                changed: status.entries.len(),
                                conflicts,
                                ahead: status.ahead,
                                behind: status.behind,
                                summary: log.first().map(|c| c.summary.clone()),
                            }
                        } else if let Ok(Some(wrepo)) = Repo::discover(&w.path) {
                            let wstatus = wrepo.status().ok();
                            let wlog = wrepo.log(None, 0, 1).unwrap_or_default();
                            let (changed, conflicts, ahead, behind) = match wstatus {
                                Some(st) => {
                                    let conflicts = st
                                        .entries
                                        .iter()
                                        .filter(|e| e.index == vibevalley_git::Change::Conflicted || e.worktree == vibevalley_git::Change::Conflicted)
                                        .count();
                                    (st.entries.len(), conflicts, st.ahead, st.behind)
                                }
                                None => (0, 0, 0, 0),
                            };
                            frames::WorktreeActivity {
                                changed,
                                conflicts,
                                ahead,
                                behind,
                                summary: wlog.first().map(|c| c.summary.clone()),
                            }
                        } else {
                            frames::WorktreeActivity::default()
                        };
                        worktree_activity.insert(w.path.clone(), act);
                    }
                }
                Ok(Some((repo, status, branches, worktrees, worktree_activity, log)))
            },
            move |s, result, cx| {
                let Some(pv) = s.workspace.projects.get_mut(&id) else { return };
                if pv.git_gen != generation {
                    return;
                }
                pv.git_busy = false;
                match result {
                    Ok(Some((repo, status, branches, worktrees, worktree_activity, log))) => {
                        pv.tones = frames::path_tones(repo.root(), &status);
                        pv.repo_root = Some(repo.root().to_path_buf());
                        pv.status = Some(status);
                        pv.branches = branches;
                        pv.worktrees = worktrees;
                        pv.worktree_activity = worktree_activity;
                        pv.log = log;
                        pv.git_error = None;
                    }
                    Ok(None) => {
                        pv.status = None;
                        pv.git_error = Some("This project is not a git repository.".into());
                    }
                    Err(e) => pv.git_error = Some(e),
                }
                s.push_sidebar(cx);
                s.reload_diffs(id, cx);
            },
        );
    }

    pub(in crate::shell) fn on_fs_changes_batch(&mut self, batches: Vec<(ProjectId, Vec<FsChange>)>, cx: &mut Context<Self>) {
        for (id, changes) in coalesce_fs_batches(batches) {
            self.on_fs_changes(id, changes, cx);
        }
    }

    pub(in crate::shell) fn on_fs_changes(&mut self, id: ProjectId, changes: Vec<FsChange>, cx: &mut Context<Self>) {
        let mut git = false;
        let mut need_dir_refresh = false;
        let mut files = BTreeSet::new();
        if let Some(pv) = self.workspace.projects.get_mut(&id) {
            for change in &changes {
                if Watcher::is_git_state_path(&change.path) {
                    git = true;
                    continue;
                }
                git = true;
                pv.tree.invalidate(&change.path);
                files.insert(change.path.clone());
            }
            need_dir_refresh = pv.tree.children.is_empty() || !files.is_empty();
        }
        if !files.is_empty() {
            for ((p, _), pane) in &self.workspace.panes {
                if *p == id {
                    match &pane.entity {
                        PaneEntity::File(viewer) => {
                            let path = viewer.read(cx).path();
                            if files.contains(path) {
                                viewer.update(cx, |v, cx| v.reload(cx));
                            }
                        }
                        PaneEntity::Markdown(md) => {
                            let path = md.read(cx).path();
                            if files.contains(path) {
                                md.update(cx, |v, cx| v.reload(cx));
                            }
                        }
                        PaneEntity::Diff(_) | PaneEntity::Hosted(_) | PaneEntity::Diorama(_) => {}
                    }
                }
            }
        }
        if need_dir_refresh && self.workspace.dir_refresh_pending.insert(id) {
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(Duration::from_millis(100)).await;
                let _ = this.update(cx, |s, cx| {
                    s.workspace.dir_refresh_pending.remove(&id);
                    s.load_dirs(id, cx);
                });
            })
            .detach();
        }
        if git && self.workspace.git_refresh_pending.insert(id) {
            // Debounced: a checkout or build touches many files at once.
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(Duration::from_millis(300)).await;
                let _ = this.update(cx, |s, cx| {
                    s.workspace.git_refresh_pending.remove(&id);
                    s.refresh_git(id, cx);
                });
            })
            .detach();
        }
    }

    pub(in crate::shell) fn reload_diffs(&mut self, id: ProjectId, cx: &mut Context<Self>) {
        for ((p, _), pane) in &self.workspace.panes {
            if *p == id
                && let PaneEntity::Diff(view) = &pane.entity
            {
                view.update(cx, |v, cx| v.reload(cx));
            }
        }
    }

    pub(in crate::shell) fn add_worktree(&mut self, branch: String, window: &mut Window, cx: &mut Context<Self>) {
        let branch = branch.trim().to_string();
        if branch.is_empty() {
            return;
        }
        let Some(active_id) = self.workspace.ws.active_id() else { return };
        let Some(pv) = self.workspace.projects.get(&active_id) else { return };
        let main_root = pv
            .worktrees
            .iter()
            .find(|w| w.is_main)
            .map(|w| w.path.clone())
            .or_else(|| pv.repo_root.clone())
            .unwrap_or_else(|| pv.tree.root.clone());
        let repo_name = main_root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "repo".into());
        let slug: String = branch
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
            .collect();
        let target_dir = main_root
            .parent()
            .unwrap_or_else(|| Path::new("/tmp"))
            .join(".worktrees")
            .join(format!("{repo_name}-{slug}"));
        if let Some(pv) = self.workspace.projects.get_mut(&active_id) {
            pv.git_busy = true;
            pv.git_error = None;
        }
        self.push_sidebar(cx);
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move {
                    if let Some(parent) = target_dir.parent() {
                        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    }
                    let Some(repo) = Repo::discover(&main_root).map_err(|e| e.to_string())? else {
                        return Err("not a git repository".into());
                    };
                    let created = repo.worktree_add(&target_dir, &branch, None).map_err(|e| e.to_string())?;
                    Ok::<PathBuf, String>(created.root().to_path_buf())
                })
                .await;
            let _ = cx.update_window(window_handle, |_, window, cx| {
                let _ = this.update(cx, |s, cx| match result {
                    Ok(new_path) => {
                        s.refresh_summaries(cx);
                        if let Some(id) = s.workspace.ws.active_id() {
                            s.refresh_git(id, cx);
                        }
                        s.activate_path(new_path, window, cx, |_, _, _| {});
                    }
                    Err(e) => {
                        if let Some(pv) = s.workspace.projects.get_mut(&active_id) {
                            pv.git_busy = false;
                            pv.git_error = Some(e);
                        }
                        s.push_sidebar(cx);
                    }
                });
            });
        })
        .detach();
    }

    pub(in crate::shell) fn remove_worktree(&mut self, path: PathBuf, force: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(active_id) = self.workspace.ws.active_id() else { return };
        let Some(pv) = self.workspace.projects.get(&active_id) else { return };
        let main_root = pv
            .worktrees
            .iter()
            .find(|w| w.is_main)
            .map(|w| w.path.clone())
            .or_else(|| pv.repo_root.clone())
            .unwrap_or_else(|| pv.tree.root.clone());
        // Never remove the main worktree.
        if path == main_root {
            return;
        }
        // If the removed worktree is open as a workspace project, close it first and switch to the main repo.
        let closing_id = self.workspace.ws.projects().iter().find(|p| p.info.path == path).map(|p| p.info.id);
        if let Some(cid) = closing_id {
            if self.workspace.ws.active_id() == Some(cid) {
                self.activate_path(main_root.clone(), window, cx, |_, _, _| {});
            }
            self.close_project(cid, cx);
        }
        let target_id = self.workspace.ws.active_id().unwrap_or(active_id);
        if let Some(pv) = self.workspace.projects.get_mut(&target_id) {
            pv.git_busy = true;
            pv.git_error = None;
        }
        self.push_sidebar(cx);
        Self::bg(
            cx,
            move || -> Result<(), String> {
                let Some(repo) = Repo::discover(&main_root).map_err(|e| e.to_string())? else {
                    return Err("not a git repository".into());
                };
                repo.worktree_remove(&path, force).map_err(|e| e.to_string())
            },
            move |s, result, cx| {
                if let Err(e) = result {
                    if let Some(pv) = s.workspace.projects.get_mut(&target_id) {
                        pv.git_busy = false;
                        pv.git_error = Some(e);
                    }
                    s.push_sidebar(cx);
                    return;
                }
                s.refresh_summaries(cx);
                if let Some(id) = s.workspace.ws.active_id() {
                    s.refresh_git(id, cx);
                }
            },
        );
    }

    pub(in crate::shell) fn git_op(&mut self, op: impl FnOnce(&Repo) -> vibevalley_git::Result<()> + Send + 'static, cx: &mut Context<Self>) {
        let Some(id) = self.workspace.ws.active_id() else { return };
        let Some(root) = self.workspace.projects.get(&id).map(|p| p.repo_root.clone().unwrap_or(p.tree.root.clone())) else {
            return;
        };
        Self::bg(
            cx,
            move || -> Result<(), String> {
                let repo = Repo::discover(&root).map_err(|e| e.to_string())?.ok_or("not a repository")?;
                op(&repo).map_err(|e| e.to_string())
            },
            move |s, result, cx| {
                if let Err(e) = result
                    && let Some(pv) = s.workspace.projects.get_mut(&id)
                {
                    pv.git_error = Some(e);
                }
                s.refresh_git(id, cx);
            },
        );
    }
}

pub(super) fn coalesce_fs_batches(batches: Vec<(ProjectId, Vec<FsChange>)>) -> Vec<(ProjectId, Vec<FsChange>)> {
    let mut by_project: BTreeMap<ProjectId, BTreeMap<PathBuf, FsChange>> = BTreeMap::new();
    for (id, changes) in batches {
        let map = by_project.entry(id).or_default();
        for change in changes {
            map.insert(change.path.clone(), change);
        }
    }
    by_project.into_iter().map(|(id, map)| (id, map.into_values().collect())).collect()
}
