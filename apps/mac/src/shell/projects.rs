use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::FutureExt as _;
use gpui::{AppContext as _, Context, PathPromptOptions, Window};
use serde_json::json;
use vibevalley_files::{FileIndex, FsChange, Watcher};
use vibevalley_git::{Branch, Commit, Repo, Status, Worktree};
use vibevalley_workspace::{PaneKind, ProjectId, load_project};

use crate::hosted::frames::{self, RailProject, TreeState};
use crate::panes::PaneEntity;

use super::{ACTIVE_KEY, GitSummary, ProjectView, Shell};

type GitSnapshot = (
    Repo,
    Status,
    Vec<Branch>,
    Vec<Worktree>,
    HashMap<PathBuf, frames::WorktreeActivity>,
    Vec<Commit>,
);

impl Shell {
    pub fn activate_index(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(project) = self.workspace.ws.projects().get(index) {
            self.activate_path(project.root().to_owned(), window, cx, |_, _, _| {});
        }
    }

    pub fn activate_project(&mut self, id: ProjectId, window: &mut Window, cx: &mut Context<Self>) {
        if self.workspace.ws.activate(id) {
            self.after_activate(id, window, cx);
        }
    }

    pub(super) fn transient_project(&self, path: &Path) -> vibevalley_workspace::LoadedProject {
        let next_id = self.workspace.ws.projects().iter().map(|p| p.id()).min().unwrap_or(0).min(0) - 1;
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        vibevalley_workspace::LoadedProject {
            info: vibevalley_workspace::Project {
                id: next_id,
                path: path.to_owned(),
                name,
                position: self.workspace.ws.projects().len() as i64,
                last_opened_ms: 0,
            },
            layout: None,
            terminals: Vec::new(),
        }
    }

    pub(super) fn with_project_at(
        &mut self,
        path: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
        then: impl FnOnce(&mut Self, Result<ProjectId, String>, &mut Window, &mut Context<Self>) + 'static,
    ) {
        let running = self
            .workspace
            .project_open
            .take()
            .and_then(|mut task| (&mut task).now_or_never().is_none().then_some(task));
        let existing = self.workspace.ws.projects().iter().find(|p| p.root() == path).map(|p| p.id());
        if running.is_none()
            && let Some(id) = existing
        {
            return then(self, Ok(id), window, cx);
        }
        let store = self.workspace.store.clone();
        let window = window.window_handle();
        self.workspace.project_open = Some(cx.spawn(async move |this, cx| {
            // Preserve the user's order when a second path arrives during the first database load.
            if let Some(earlier) = running {
                earlier.await;
            }
            let loaded = cx
                .background_spawn(async move {
                    if !path.is_dir() {
                        return Err(format!("{}: {}", vibevalley_i18n::t("desktop.terminal.missingFolder", &[]), path.display()));
                    }
                    let loaded = store.and_then(|db| load_project(&*db, &path).map_err(|e| eprintln!("open project: {e}")).ok());
                    Ok((path, loaded))
                })
                .await;
            let _ = cx.update_window(window, |_, window, cx| {
                let _ = this.update(cx, |shell, cx| {
                    let id = loaded.map(|(path, loaded)| {
                        if let Some(project) = shell.workspace.ws.projects().iter().find(|p| p.root() == path) {
                            return project.id();
                        }
                        let id = shell.workspace.ws.open(loaded.unwrap_or_else(|| shell.transient_project(&path)));
                        shell.ensure_project_view(id, cx);
                        shell.sync_chat_watches(cx);
                        id
                    });
                    then(shell, id, window, cx);
                });
            });
        }));
    }

    pub(super) fn activate_path(
        &mut self,
        path: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
        then: impl FnOnce(&mut Self, &mut Window, &mut Context<Self>) + 'static,
    ) {
        self.with_project_at(path, window, cx, move |s, result, window, cx| match result {
            Ok(id) => {
                s.show_workspace(cx);
                s.activate_project(id, window, cx);
                then(s, window, cx);
            }
            Err(error) => eprintln!("open project: {error}"),
        });
    }

    pub(super) fn after_activate(&mut self, id: ProjectId, window: &mut Window, cx: &mut Context<Self>) {
        self.ensure_project_view(id, cx);
        if let Some(store) = self.workspace.store.clone() {
            Self::bg(
                cx,
                move || {
                    let _ = store.touch_project(id);
                    let _ = store.set_setting(ACTIVE_KEY, &json!(id));
                },
                |_, _, _| {},
            );
        }
        self.push_sidebar(cx);
        self.focus_active_pane(window, cx);
        cx.notify();
    }

    pub(super) fn add_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Add Project".into()),
        });
        let store = self.workspace.store.clone();
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = rx.await else { return };
            let (Some(path), Some(store)) = (paths.into_iter().next(), store) else {
                return;
            };
            let loaded = cx.background_spawn(async move { load_project(&*store, &path) }).await;
            let _ = cx.update_window(window_handle, |_, window, cx| {
                let _ = this.update(cx, |s, cx| match loaded {
                    Ok(p) => {
                        let id = s.workspace.ws.open(p);
                        s.activate_project(id, window, cx);
                        s.refresh_summaries(cx);
                    }
                    Err(e) => eprintln!("add project: {e}"),
                });
            });
        })
        .detach();
    }

    pub(super) fn close_project(&mut self, id: ProjectId, cx: &mut Context<Self>) {
        let Some(job) = self.workspace.ws.close(id) else { return };
        self.workspace.projects.remove(&id);
        self.workspace.panes.retain(|(p, _), _| *p != id);
        self.workspace.chat_statuses.retain(|(p, _), _| *p != id);
        self.sync_chat_watches(cx);
        let live: std::collections::BTreeSet<String> = self.workspace.ws.projects().iter().flat_map(|p| p.layout.terminal_ids()).collect();
        self.workspace.terminals.retain(|tid, _| live.contains(tid));
        if let Some(store) = self.workspace.store.clone() {
            Self::bg(
                cx,
                move || {
                    let _ = job.run(&*store);
                    let _ = store.remove_project(id);
                },
                |_, _, _| {},
            );
        }
        if let Some(active) = self.workspace.ws.active_id() {
            self.ensure_project_view(active, cx);
        }
        self.refresh_summaries(cx);
        self.push_sidebar(cx);
        cx.notify();
    }

    /// Starts the watcher, lists the root, reads git state and indexes files
    /// the first time a project is shown.
    pub fn ensure_project_view(&mut self, id: ProjectId, cx: &mut Context<Self>) {
        if self.workspace.projects.contains_key(&id) {
            return;
        }
        let Some(root) = self.workspace.ws.project(id).map(|p| p.root().to_path_buf()) else {
            return;
        };
        self.workspace.projects.insert(
            id,
            ProjectView {
                tree: TreeState::new(root.clone()),
                repo_root: None,
                status: None,
                tones: HashMap::new(),
                branches: Vec::new(),
                worktrees: Vec::new(),
                worktree_activity: HashMap::new(),
                log: Vec::new(),
                git_error: None,
                git_busy: false,
                index: None,
                _watcher: None,
            },
        );
        let tx = self.workspace.fs_tx.clone();
        let watch_root = root.clone();
        Self::bg(
            cx,
            move || {
                Watcher::new(&watch_root, move |changes| {
                    let _ = tx.send((id, changes));
                })
                .map_err(|e| format!("watch {}: {e}", watch_root.display()))
            },
            move |s, watcher, _| match watcher {
                Ok(watcher) => {
                    if let Some(pv) = s.workspace.projects.get_mut(&id) {
                        pv._watcher = Some(watcher);
                    }
                }
                Err(e) => eprintln!("{e}"),
            },
        );
        self.load_dirs(id, cx);
        self.refresh_git(id, cx);
        let index_root = root.clone();
        Self::bg(
            cx,
            move || FileIndex::build(&index_root),
            move |s, index, cx| match index {
                Ok(index) => {
                    if let Some(pv) = s.workspace.projects.get_mut(&id) {
                        pv.index = Some(Arc::new(index));
                    }
                    s.refresh_palette(cx);
                }
                Err(e) => eprintln!("index {}: {e}", root.display()),
            },
        );
    }

    pub(super) fn load_dirs(&mut self, id: ProjectId, cx: &mut Context<Self>) {
        let Some(pv) = self.workspace.projects.get(&id) else { return };
        let wanted = pv.tree.wanted();
        if wanted.is_empty() {
            self.push_sidebar(cx);
            return;
        }
        let root = pv.tree.root.clone();
        Self::bg(
            cx,
            move || {
                wanted
                    .into_iter()
                    .map(|dir| {
                        let listed = vibevalley_files::list_dir(&root, &dir, false);
                        (dir, listed)
                    })
                    .collect::<Vec<_>>()
            },
            move |s, listed, cx| {
                if let Some(pv) = s.workspace.projects.get_mut(&id) {
                    for (dir, result) in listed {
                        match result {
                            Ok(entries) => {
                                pv.tree.children.insert(dir, entries);
                            }
                            Err(e) => {
                                eprintln!("list {}: {e}", dir.display());
                                pv.tree.expanded.remove(&dir);
                                pv.tree.children.insert(dir, Vec::new());
                            }
                        }
                    }
                }
                s.push_sidebar(cx);
            },
        );
    }

    /// Reads the branch and worktrees of every project the sidebar lists.
    pub fn refresh_summaries(&mut self, cx: &mut Context<Self>) {
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
            |s, read, cx| {
                s.workspace.git_summaries = read.into_iter().collect();
                s.push_sidebar(cx);
            },
        );
    }

    pub fn refresh_git(&mut self, id: ProjectId, cx: &mut Context<Self>) {
        let Some(pv) = self.workspace.projects.get_mut(&id) else { return };
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
                if let Some(pv) = s.workspace.projects.get_mut(&id) {
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
                }
                s.push_sidebar(cx);
                s.reload_diffs(id, cx);
            },
        );
    }

    pub(super) fn on_fs_changes(&mut self, id: ProjectId, changes: Vec<FsChange>, cx: &mut Context<Self>) {
        let mut git = false;
        let mut files = Vec::new();
        if let Some(pv) = self.workspace.projects.get_mut(&id) {
            for change in &changes {
                if Watcher::is_git_state_path(&change.path) {
                    git = true;
                    continue;
                }
                git = true;
                pv.tree.invalidate(&change.path);
                files.push(change.path.clone());
            }
            if pv.tree.children.is_empty() || !files.is_empty() {
                self.load_dirs(id, cx);
            }
        }
        for ((p, _), pane) in &self.workspace.panes {
            if *p == id {
                match &pane.entity {
                    PaneEntity::File(viewer) => {
                        let path = viewer.read(cx).path().to_path_buf();
                        if files.contains(&path) {
                            viewer.update(cx, |v, cx| v.reload(cx));
                        }
                    }
                    PaneEntity::Markdown(md) => {
                        let path = md.read(cx).path().to_path_buf();
                        if files.contains(&path) {
                            md.update(cx, |v, cx| v.reload(cx));
                        }
                    }
                    PaneEntity::Diff(_) | PaneEntity::Hosted(_) | PaneEntity::Pixel(_) => {}
                }
            }
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

    pub(super) fn reload_diffs(&mut self, id: ProjectId, cx: &mut Context<Self>) {
        for ((p, _), pane) in &self.workspace.panes {
            if *p == id
                && let PaneEntity::Diff(view) = &pane.entity
            {
                view.update(cx, |v, cx| v.reload(cx));
            }
        }
    }

    pub fn push_sidebar(&mut self, cx: &mut Context<Self>) {
        self.publish_host_debug(cx);
        let sidebar_ready = self.chrome.sidebar.read(cx).is_ready();
        let inspector_ready = self.chrome.inspector_open && self.chrome.inspector.as_ref().is_some_and(|slot| slot.view.read(cx).is_ready());
        if !sidebar_ready && !inspector_ready {
            return;
        }
        let rail_items: Vec<RailProject> = self
            .workspace
            .ws
            .projects()
            .iter()
            .map(|p| {
                let pv = self.workspace.projects.get(&p.id());
                let summary = self.workspace.git_summaries.get(&p.id());
                let worktrees_src = pv.map(|v| &v.worktrees).filter(|w| !w.is_empty()).or(summary.map(|s| &s.worktrees));
                let branch = pv
                    .and_then(|v| v.status.as_ref()?.branch.clone())
                    .or_else(|| summary.and_then(|s| s.branch.clone()));
                let main_root = worktrees_src.and_then(|ws| ws.iter().find(|w| w.is_main).map(|w| w.path.to_string_lossy().into_owned()));
                let worktrees = worktrees_src
                    .map(|ws| {
                        ws.iter()
                            .map(|w| vibevalley_protocol::HostRailWorktree {
                                path: w.path.to_string_lossy().into_owned(),
                                branch: w.branch.clone(),
                                main: w.is_main,
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                let active_tab = p.layout.active_tab().map(|t| t.id);
                let names = crate::panes::numbered_titles(self, p.layout.tabs(), cx);
                let tabs: Vec<vibevalley_protocol::HostRailTab> = p
                    .layout
                    .tabs()
                    .map(|t| {
                        let title = names.get(&t.id).cloned().unwrap_or_else(|| crate::panes::tab_title(self, t, cx));
                        let (kind, running, running_state, running_agent, running_label, attention) = match &t.kind {
                            PaneKind::Terminal { terminal_id, .. } => {
                                let status = self
                                    .workspace
                                    .terminals
                                    .get(terminal_id)
                                    .map(|v| v.view.read(cx).terminal_status())
                                    .unwrap_or_default();
                                let att = p.terminal(terminal_id).is_some_and(|e| e.attention);
                                let running_label = if status.is_coding_agent() {
                                    status
                                        .agent
                                        .as_deref()
                                        .map(|agent| crate::terminal::agent_display_name(agent, status.label.as_deref().unwrap_or(agent)))
                                } else {
                                    status.label
                                };
                                let state = match status.state {
                                    crate::terminal::RunningState::Working => vibevalley_protocol::HostRailRunningState::Working,
                                    crate::terminal::RunningState::Ready => vibevalley_protocol::HostRailRunningState::Ready,
                                    crate::terminal::RunningState::Idle => vibevalley_protocol::HostRailRunningState::Idle,
                                };
                                (
                                    "terminal",
                                    status.state == crate::terminal::RunningState::Working,
                                    state,
                                    status.agent,
                                    running_label,
                                    att,
                                )
                            }
                            PaneKind::Chat { runtime, .. } => {
                                let st = self.workspace.chat_statuses.get(&(p.id(), t.id));
                                let raw = st.map(|s| s.status.as_str()).filter(|s| !s.is_empty()).unwrap_or("ready");
                                let state = match raw {
                                    "working" => vibevalley_protocol::HostRailRunningState::Working,
                                    "idle" => vibevalley_protocol::HostRailRunningState::Idle,
                                    _ => vibevalley_protocol::HostRailRunningState::Ready,
                                };
                                let att = st.is_some_and(|s| s.attention);
                                (
                                    "chat",
                                    state == vibevalley_protocol::HostRailRunningState::Working,
                                    state,
                                    Some(runtime.clone()),
                                    None,
                                    att,
                                )
                            }
                            PaneKind::File { .. } => ("file", false, vibevalley_protocol::HostRailRunningState::Idle, None, None, false),
                            PaneKind::Diff { .. } => ("diff", false, vibevalley_protocol::HostRailRunningState::Idle, None, None, false),
                            PaneKind::Hosted { .. } => ("hosted", false, vibevalley_protocol::HostRailRunningState::Idle, None, None, false),
                            PaneKind::Pixel { .. } => ("pixel", false, vibevalley_protocol::HostRailRunningState::Idle, None, None, false),
                        };
                        vibevalley_protocol::HostRailTab {
                            id: t.id,
                            title,
                            active: active_tab == Some(t.id),
                            kind: kind.to_string(),
                            running: Some(running),
                            running_state: Some(running_state),
                            running_agent,
                            running_label,
                            attention: Some(attention),
                        }
                    })
                    .collect();
                RailProject {
                    id: p.id(),
                    name: &p.info.name,
                    path: p.root(),
                    active: Some(p.id()) == self.workspace.ws.active_id(),
                    attention: p.needs_attention() || self.workspace.chat_statuses.iter().any(|((pid, _), st)| *pid == p.id() && st.attention),
                    terminals: p.live_terminals(),
                    branch,
                    main_root,
                    worktrees: Some(worktrees),
                    tabs: Some(tabs),
                }
            })
            .collect();
        let rail = frames::rail(&rail_items, self.chrome.panel, Some(self.chrome.inspector_open));
        let (files, git) = match self.workspace.ws.active_id().and_then(|id| self.workspace.projects.get(&id)) {
            Some(pv) => (
                frames::file_tree(&pv.tree, &pv.tones),
                frames::git_panel(&frames::GitView {
                    status: pv.status.as_ref(),
                    branches: &pv.branches,
                    worktrees: &pv.worktrees,
                    worktree_activity: &pv.worktree_activity,
                    current_root: pv.repo_root.as_deref(),
                    log: &pv.log,
                    error: pv.git_error.as_deref(),
                    busy: pv.git_busy,
                }),
            ),
            None => (frames::empty_file_tree(!self.workspace.loaded), frames::empty_git_panel(!self.workspace.loaded)),
        };
        if sidebar_ready {
            self.chrome.sidebar.update(cx, |v, cx| {
                v.push("rail", rail.clone(), cx);
                v.push("files", files.clone(), cx);
                v.push("git", git.clone(), cx);
            });
        }
        if inspector_ready && let Some(slot) = &self.chrome.inspector {
            slot.view.update(cx, |v, cx| {
                v.push("rail", rail, cx);
                v.push("files", files, cx);
                v.push("git", git, cx);
            });
        }
    }

    pub(super) fn add_worktree(&mut self, branch: String, window: &mut Window, cx: &mut Context<Self>) {
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

    pub(super) fn remove_worktree(&mut self, path: PathBuf, force: bool, window: &mut Window, cx: &mut Context<Self>) {
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

    pub(super) fn git_op(&mut self, op: impl FnOnce(&Repo) -> vibevalley_git::Result<()> + Send + 'static, cx: &mut Context<Self>) {
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

    pub(super) fn with_workspace_project(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        then: impl FnOnce(&mut Self, Result<ProjectId, String>, &mut Window, &mut Context<Self>) + 'static,
    ) {
        if let Some(id) = self.workspace.ws.active_id() {
            return then(self, Ok(id), window, cx);
        }
        if !self.workspace.loaded {
            return then(self, Err(vibevalley_i18n::t("desktop.terminal.noProject", &[])), window, cx);
        }
        let root = crate::serving::work_root();
        let dir = first_workspace_repo(&root).or_else(|| std::fs::create_dir_all(&root).ok().map(|()| root));
        let Some(dir) = dir else {
            return then(self, Err(vibevalley_i18n::t("desktop.terminal.noProject", &[])), window, cx);
        };
        self.with_project_at(dir, window, cx, move |s, id, w, cx| {
            if let Ok(id) = id {
                s.workspace.ws.activate(id);
                s.refresh_summaries(cx);
                s.push_sidebar(cx);
            }
            then(s, id, w, cx);
        });
    }
}

pub(super) fn first_workspace_repo(work_root: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(work_root).ok()?;
    let mut dirs: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).collect();
    dirs.sort();
    dirs.iter()
        .find(|p| Repo::discover(p).ok().flatten().is_some())
        .cloned()
        .or_else(|| dirs.into_iter().next())
}
