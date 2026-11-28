use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures_util::FutureExt as _;
use gpui::{AppContext as _, Context, PathPromptOptions, Window};
use serde_json::json;
use vibevalley_files::{FileIndex, Watcher};
use vibevalley_workspace::{ProjectId, load_project};

use crate::hosted::frames::TreeState;

use super::super::{ACTIVE_KEY, ProjectView, Shell};
use super::{SidebarTopics, first_workspace_repo, git_repo_mount_root};

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

    pub(in crate::shell) fn transient_project(&self, path: &Path) -> vibevalley_workspace::LoadedProject {
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

    pub(in crate::shell) fn with_project_at(
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
            let loaded = vibevalley_kit::rt::current_or_global_handle()
                .spawn(async move {
                    if !tokio::fs::metadata(&path).await.is_ok_and(|m| m.is_dir()) {
                        return Err(format!("{}: {}", vibevalley_i18n::t("desktop.terminal.missingFolder", &[]), path.display()));
                    }
                    let loaded = match store {
                        Some(db) => load_project(&*db, &path).await.map_err(|e| eprintln!("open project: {e}")).ok(),
                        None => None,
                    };
                    Ok((path, loaded))
                })
                .await
                .unwrap_or_else(|e| Err(format!("open project task failed: {e}")));
            let _ = cx.update_window(window, |_, window, cx| {
                let _ = this.update(cx, |shell, cx| {
                    let id = loaded.map(|(path, loaded)| {
                        if let Some(project) = shell.workspace.ws.projects().iter().find(|p| p.root() == path) {
                            return project.id();
                        }
                        let id = shell.workspace.ws.open(loaded.unwrap_or_else(|| shell.transient_project(&path)));
                        shell.ensure_project_view(id, cx);
                        shell.sync_chat_watches(cx);
                        shell.sync_repo_mounts(vec![path], cx);
                        id
                    });
                    then(shell, id, window, cx);
                });
            });
        }));
    }

    pub(in crate::shell) fn activate_path(
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

    pub(in crate::shell) fn after_activate(&mut self, id: ProjectId, window: &mut Window, cx: &mut Context<Self>) {
        self.ensure_project_view(id, cx);
        if let Some(store) = self.workspace.store.clone() {
            Self::bg_tokio(
                cx,
                async move {
                    let _ = store.touch_project(id).await;
                    let _ = store.set_setting(ACTIVE_KEY, &json!(id)).await;
                },
                |_, _, _| {},
            );
        }
        self.push_sidebar(cx);
        self.focus_active_pane(window, cx);
        cx.notify();
    }

    pub(in crate::shell) fn add_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
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
            let loaded = vibevalley_kit::rt::current_or_global_handle()
                .spawn(async move { load_project(&*store, &path).await })
                .await
                .unwrap_or_else(|e| Err(vibevalley_workspace::StoreError::Io(e.to_string())));
            let _ = cx.update_window(window_handle, |_, window, cx| {
                let _ = this.update(cx, |s, cx| match loaded {
                    Ok(p) => {
                        let id = s.workspace.ws.open(p);
                        let root = s.workspace.ws.project(id).map(|proj| proj.root().to_path_buf());
                        s.activate_project(id, window, cx);
                        s.refresh_summaries(cx);
                        if let Some(root) = root {
                            s.sync_repo_mounts(vec![root], cx);
                        }
                    }
                    Err(e) => eprintln!("add project: {e}"),
                });
            });
        })
        .detach();
    }

    pub(in crate::shell) fn close_project(&mut self, id: ProjectId, cx: &mut Context<Self>) {
        let Some(job) = self.workspace.ws.close(id) else { return };
        self.workspace.projects.remove(&id);
        self.workspace.panes.retain(|(p, _), _| *p != id);
        self.workspace.chat_statuses.retain(|(p, _), _| *p != id);
        self.sync_chat_watches(cx);
        let live: BTreeSet<String> = self.workspace.ws.projects().iter().flat_map(|p| p.layout.terminal_ids()).collect();
        self.workspace.terminals.retain(|tid, _| live.contains(tid));
        if let Some(store) = self.workspace.store.clone() {
            Self::bg_tokio(
                cx,
                async move {
                    let _ = job.run(&*store).await;
                    let _ = store.remove_project(id).await;
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
                dirs_gen: 0,
                git_gen: 0,
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

    pub(in crate::shell) fn load_dirs(&mut self, id: ProjectId, cx: &mut Context<Self>) {
        let Some(pv) = self.workspace.projects.get_mut(&id) else { return };
        pv.dirs_gen = pv.dirs_gen.wrapping_add(1);
        let generation = pv.dirs_gen;
        let wanted = pv.tree.wanted();
        if wanted.is_empty() {
            self.push_sidebar_topics(SidebarTopics::FILES, cx);
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
                let mut applied = false;
                if let Some(pv) = s.workspace.projects.get_mut(&id)
                    && pv.dirs_gen == generation
                {
                    applied = true;
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
                if applied {
                    s.push_sidebar_topics(SidebarTopics::FILES, cx);
                }
            },
        );
    }

    /// Ensures every git repository currently open in Workspace is mounted on the server.
    pub(in crate::shell) fn sync_all_project_mounts(&self, cx: &mut Context<Self>) {
        let roots: Vec<PathBuf> = self.workspace.ws.projects().iter().map(|p| p.root().to_path_buf()).collect();
        self.sync_repo_mounts(roots, cx);
    }

    /// Discovers main git repository roots for `paths` and mounts them via `repo.mount`.
    pub(in crate::shell) fn sync_repo_mounts(&self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        if paths.is_empty() || !self.workspace.server_ready {
            return;
        }
        let Some(server) = cx.try_global::<crate::hosted::BridgeHub>().map(|b| b.0.server().clone()) else {
            return;
        };
        cx.spawn(async move |this, cx| {
            let repo_roots = cx
                .background_spawn(async move {
                    let mut unique = BTreeSet::new();
                    for path in paths {
                        if let Some(root) = git_repo_mount_root(&path) {
                            unique.insert(root);
                        }
                    }
                    unique.into_iter().collect::<Vec<_>>()
                })
                .await;
            if repo_roots.is_empty() {
                return;
            }
            let (tx, rx) = tokio::sync::oneshot::channel();
            let rt = vibevalley_kit::rt::current_or_global_handle();
            rt.spawn(async move {
                let mut any_mounted = false;
                for root in repo_roots {
                    let env = Arc::clone(&server)
                        .call_with_async(
                            vibevalley_server::gateway::bridge::CallerContext::local(),
                            "repo.mount".into(),
                            json!({ "path": root.to_string_lossy() }),
                        )
                        .await;
                    if env.data.is_some() {
                        any_mounted = true;
                    }
                }
                let _ = tx.send(any_mounted);
            });
            if rx.await.unwrap_or(false) {
                let _ = this.update(cx, |shell, cx| {
                    shell.chrome.workbench.update(cx, |view, cx| view.notify_repos_changed(cx));
                    shell.chrome.sidebar.update(cx, |view, cx| view.notify_repos_changed(cx));
                    shell.push_sidebar_topics(SidebarTopics::RAIL, cx);
                });
            }
        })
        .detach();
    }

    pub(in crate::shell) fn with_workspace_project(
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
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let dir = cx
                .background_spawn(async move { first_workspace_repo(&root).or_else(|| std::fs::create_dir_all(&root).ok().map(|()| root)) })
                .await;
            let _ = cx.update_window(window_handle, |_, window, cx| {
                let _ = this.update(cx, |s, cx| {
                    if let Some(id) = s.workspace.ws.active_id() {
                        return then(s, Ok(id), window, cx);
                    }
                    let Some(dir) = dir else {
                        return then(s, Err(vibevalley_i18n::t("desktop.terminal.noProject", &[])), window, cx);
                    };
                    s.with_project_at(dir, window, cx, move |s, id, w, cx| {
                        if let Ok(id) = id {
                            s.workspace.ws.activate(id);
                            s.refresh_summaries(cx);
                            s.push_sidebar(cx);
                        }
                        then(s, id, w, cx);
                    });
                });
            });
        })
        .detach();
    }
}
