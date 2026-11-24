use std::path::{Path, PathBuf};

use gpui::{AppContext as _, Context, Focusable, Window};
use serde_json::{Value, json};
use vibevalley_git::Repo;
use vibevalley_server::gateway::bridge::BridgeRpc as _;
use vibevalley_workspace::{Axis, PaneKind, ProjectId, TabId};

use crate::diff::DiffView;
use crate::hosted::HostedView;
use crate::markdown_pane::{MarkdownPaneEvent, MarkdownView};
use crate::panes::PaneEntity;
use crate::terminal::{SpawnSpec, TerminalEvent, TerminalView};
use crate::theme::Ui;
use crate::viewer::FileViewer;

use super::projects::SidebarTopics;
use super::{PaneSlot, PixelSlot, Shell, TerminalSlot};

impl Shell {
    pub(super) fn navigate_workbench(&mut self, route: &str, cx: &mut Context<Self>) {
        self.chrome.native_workspace = false;
        self.chrome.native_pixel = None;
        self.chrome.last_route = Some(route.to_string());
        self.sync_devtools_route(route);
        self.chrome.workbench.update(cx, |v, cx| v.navigate(route, cx));
        self.publish_host_debug(cx);
        cx.notify();
    }

    pub(super) fn show_workspace(&mut self, cx: &mut Context<Self>) {
        if self.chrome.native_workspace && self.chrome.native_pixel.is_none() && self.chrome.last_route.as_deref() == Some("/workspace") {
            return;
        }
        self.chrome.native_workspace = true;
        self.chrome.native_pixel = None;
        self.chrome.last_route = Some("/workspace".to_string());
        self.sync_devtools_route("/workspace");
        self.chrome.workbench.update(cx, |v, cx| v.navigate("/workspace", cx));
        self.publish_host_debug(cx);
        cx.notify();
    }

    pub(super) fn show_pixel(&mut self, scene: &str, mut props: Value, window: &mut Window, cx: &mut Context<Self>) {
        if props.get("cwd").is_none() {
            props["cwd"] = json!(self.workspace.ws.active().map(|p| p.root().to_path_buf()));
        }
        let view = cx.new(|cx| crate::pixel::view::PixelView::new(scene, props, cx));
        let sub = cx.subscribe_in(&view, window, |this, _, event: &crate::pixel::view::PixelEvent, window, cx| {
            this.on_pixel_event(event.clone(), window, cx)
        });
        self.chrome.native_workspace = false;
        self.chrome.native_pixel = Some(PixelSlot { view, _sub: sub });
        self.publish_host_debug(cx);
        cx.notify();
    }

    pub fn open_pane(&mut self, kind: PaneKind, window: &mut Window, cx: &mut Context<Self>) {
        if let PaneKind::Hosted { module, props } = &kind
            && (module == "vv" || module == "vibevalley")
        {
            self.navigate_workbench(props["route"].as_str().unwrap_or("/issues"), cx);
            return;
        }
        if let PaneKind::Pixel { scene, props } = kind {
            self.show_pixel(&scene, props, window, cx);
            return;
        }
        self.show_workspace(cx);
        self.with_workspace_project(window, cx, move |s, id, w, cx| {
            if let Ok(id) = id
                && let Some(project) = s.workspace.ws.project_mut(id)
            {
                project.layout.open(kind);
                s.layout_changed(w, cx);
            }
        });
    }

    pub fn open_file(&mut self, path: PathBuf, line: Option<u32>, window: &mut Window, cx: &mut Context<Self>) {
        self.show_workspace(cx);
        self.with_workspace_project(window, cx, move |s, id, window, cx| {
            let Ok(pid) = id else { return };
            let Some(project) = s.workspace.ws.project_mut(pid) else { return };
            let tab = project.layout.open(PaneKind::File { path: path.clone() });
            if let Some(pv) = s.workspace.projects.get_mut(&pid) {
                pv.tree.selected = Some(path);
            }
            s.ensure_panes(window, cx);
            if let (Some(line), Some(PaneEntity::File(v))) = (line, s.workspace.panes.get(&(pid, tab)).map(|s| &s.entity)) {
                v.update(cx, |v, cx| v.scroll_to_line(line, cx));
            }
            s.layout_changed(window, cx);
        });
    }

    fn next_terminal_directory(&self, cx: &gpui::App) -> Option<PathBuf> {
        let project = self.workspace.ws.active()?;
        match project.layout.active_tab().map(|t| &t.kind) {
            Some(PaneKind::Terminal { terminal_id, .. }) => {
                if let Some(slot) = self.workspace.terminals.get(terminal_id) {
                    let cwd = slot.view.read(cx).directory();
                    if cwd.is_dir() {
                        return Some(cwd);
                    }
                }
            }
            Some(PaneKind::Chat { cwd, .. }) if cwd.is_dir() => {
                return Some(cwd.clone());
            }
            _ => {}
        }
        Some(project.root().to_path_buf())
    }

    pub fn new_chat(&mut self, runtime: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        self.workspace.chat_menu_group = None;
        self.show_workspace(cx);
        self.with_workspace_project(window, cx, move |s, id, window, cx| {
            let Ok(id) = id else { return };
            let cwd = s
                .next_terminal_directory(cx)
                .or_else(|| s.workspace.ws.project(id).map(|p| p.root().to_path_buf()));
            let Some(cwd) = cwd else { return };
            let Some(project) = s.workspace.ws.project_mut(id) else { return };
            let runtime = runtime.as_deref().map(str::trim).filter(|r| !r.is_empty()).unwrap_or("antigravity").to_string();
            project.layout.add_tab(
                None,
                PaneKind::Chat {
                    session_id: String::new(),
                    runtime,
                    cwd,
                    title: None,
                },
            );
            s.layout_changed(window, cx);
        });
    }

    pub(super) fn open_chat_at(&mut self, cwd: PathBuf, runtime: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        self.workspace.chat_menu_group = None;
        if cwd.as_os_str().is_empty() {
            return self.new_chat(runtime, window, cx);
        }
        let known_roots: Vec<PathBuf> = self.workspace.ws.projects().iter().map(|p| p.root().to_owned()).collect();
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let resolved = cx.background_spawn(async move { resolve_project_directory(cwd, known_roots) }).await;
            let _ = cx.update_window(window_handle, |_, window, cx| {
                let _ = this.update(cx, |s, cx| match resolved {
                    Ok((directory, target)) => {
                        s.with_project_at(target, window, cx, move |s, id, window, cx| {
                            let Ok(id) = id else { return };
                            s.workspace.ws.activate(id);
                            s.show_workspace(cx);
                            let Some(project) = s.workspace.ws.project_mut(id) else { return };
                            let runtime = runtime.as_deref().map(str::trim).filter(|r| !r.is_empty()).unwrap_or("antigravity").to_string();
                            project.layout.add_tab(
                                None,
                                PaneKind::Chat {
                                    session_id: String::new(),
                                    runtime,
                                    cwd: directory,
                                    title: None,
                                },
                            );
                            s.layout_changed(window, cx);
                        });
                    }
                    Err(reason) => {
                        s.workspace.terminal_notice = Some(reason);
                        cx.notify();
                    }
                });
            });
        })
        .detach();
    }

    pub fn open_file_adjacent(&mut self, path: PathBuf, line: Option<u32>, window: &mut Window, cx: &mut Context<Self>) {
        self.show_workspace(cx);
        self.with_workspace_project(window, cx, move |s, id, window, cx| {
            let Ok(pid) = id else { return };
            let Some(project) = s.workspace.ws.project_mut(pid) else { return };
            let resolved = if path.is_absolute() { path } else { project.root().join(path) };
            let tab = project.layout.open_adjacent(PaneKind::File { path: resolved.clone() });
            if let Some(pv) = s.workspace.projects.get_mut(&pid) {
                pv.tree.selected = Some(resolved);
            }
            s.ensure_panes(window, cx);
            if let (Some(line), Some(PaneEntity::File(v))) = (line, s.workspace.panes.get(&(pid, tab)).map(|slot| &slot.entity)) {
                v.update(cx, |v, cx| v.scroll_to_line(line, cx));
            }
            s.layout_changed(window, cx);
        });
    }

    pub fn open_diff_adjacent(&mut self, path: Option<PathBuf>, staged: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.show_workspace(cx);
        self.with_workspace_project(window, cx, move |s, id, window, cx| {
            let Ok(pid) = id else { return };
            let Some(project) = s.workspace.ws.project_mut(pid) else { return };
            let root = project.root().to_path_buf();
            let rel = path.map(|p| p.strip_prefix(&root).map(Path::to_path_buf).unwrap_or(p));
            let spec = if staged {
                vibevalley_workspace::DiffSpec::Staged
            } else {
                vibevalley_workspace::DiffSpec::Unstaged
            };
            project.layout.open_adjacent(PaneKind::Diff { spec, path: rel, repo: None });
            s.layout_changed(window, cx);
        });
    }

    pub(super) fn bind_chat_session(&mut self, tab_id: TabId, session_id: String, runtime: Option<String>, cx: &mut Context<Self>) {
        let session_id = session_id.trim().to_string();
        let mut target_pid = None;
        let mut layout_dirty = false;
        let mut sid_changed = false;
        let ids: Vec<ProjectId> = self.workspace.ws.projects().iter().map(|p| p.id()).collect();
        for pid in ids {
            let Some(project) = self.workspace.ws.project_mut(pid) else { continue };
            let Some(vibevalley_workspace::Tab {
                kind:
                    PaneKind::Chat {
                        session_id: cur_sid,
                        runtime: cur_rt,
                        title: cur_title,
                        ..
                    },
                ..
            }) = project.layout.tab_mut(tab_id)
            else {
                continue;
            };
            target_pid = Some(pid);
            if *cur_sid != session_id {
                *cur_sid = session_id.clone();
                layout_dirty = true;
                sid_changed = true;
                if session_id.is_empty() {
                    *cur_title = None;
                }
            }
            if let Some(rt) = runtime.filter(|r| !r.trim().is_empty())
                && *cur_rt != rt
            {
                *cur_rt = rt;
                layout_dirty = true;
            }
            break;
        }
        if let Some(pid) = target_pid {
            if session_id.is_empty() {
                self.workspace.chat_statuses.remove(&(pid, tab_id));
            }
            if sid_changed {
                self.sync_chat_watches(cx);
            }
            if layout_dirty {
                self.schedule_save(cx);
            }
            self.push_sidebar(cx);
            cx.notify();
        }
    }

    pub(super) fn sync_chat_watches(&mut self, cx: &mut Context<Self>) {
        if !self.workspace.server_ready {
            return;
        }
        let wanted: std::collections::BTreeSet<String> = self
            .workspace
            .ws
            .projects()
            .iter()
            .flat_map(|p| p.layout.tabs())
            .filter_map(|t| match &t.kind {
                PaneKind::Chat { session_id, .. } if !session_id.trim().is_empty() => Some(session_id.trim().to_string()),
                _ => None,
            })
            .collect();

        let Some(bridge) = cx.try_global::<crate::hosted::BridgeHub>() else {
            return;
        };
        let server = bridge.0.server().clone();

        let stale: Vec<String> = self.workspace.chat_watches.keys().filter(|sid| !wanted.contains(*sid)).cloned().collect();
        for sid in stale {
            if let Some((sub_id, _task)) = self.workspace.chat_watches.remove(&sid) {
                server.unsubscribe(sub_id);
            }
        }

        for sid in wanted {
            if self.workspace.chat_watches.contains_key(&sid) {
                continue;
            }
            let Ok((sub_id, mut rx)) = server.subscribe("session.watch", json!({ "id": sid, "afterSeq": i64::MAX })) else {
                continue;
            };
            let watch_sid = sid.clone();
            let task = cx.spawn(async move |this, cx| {
                while let Some(value) = rx.recv().await {
                    let Ok(ev) = serde_json::from_value::<vibevalley_protocol::SessionWatchEvent>(value) else {
                        continue;
                    };
                    if this.update(cx, |shell, cx| shell.apply_chat_watch_event(&watch_sid, ev, cx)).is_err() {
                        return;
                    }
                }
                let _ = this.update(cx, |shell, cx| {
                    if let Some((sub_id, _)) = shell.workspace.chat_watches.remove(&watch_sid)
                        && let Some(bridge) = cx.try_global::<crate::hosted::BridgeHub>()
                    {
                        bridge.0.server().unsubscribe(sub_id);
                    }
                });
            });
            self.workspace.chat_watches.insert(sid, (sub_id, task));
        }
    }

    fn apply_chat_watch_event(&mut self, session_id: &str, event: vibevalley_protocol::SessionWatchEvent, cx: &mut Context<Self>) {
        match event {
            vibevalley_protocol::SessionWatchEvent::State {
                session,
                title,
                pending_permissions,
                pending_interactions,
                swarm,
                ..
            } => {
                let next_status = if session.phase.is_working() {
                    "working".to_string()
                } else {
                    "ready".to_string()
                };
                let next_attention = !pending_permissions.is_empty() || !pending_interactions.is_empty();
                let next_title = title
                    .as_deref()
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .or_else(|| swarm.as_ref().and_then(|s| s.title.as_deref()).map(str::trim).filter(|t| !t.is_empty()))
                    .map(str::to_owned);
                let next_runtime = (!session.runtime.trim().is_empty()).then_some(session.runtime);
                let mut changed = false;
                let mut layout_dirty = false;
                let mut matched_tabs = Vec::new();
                let ids: Vec<ProjectId> = self.workspace.ws.projects().iter().map(|p| p.id()).collect();
                for pid in ids {
                    let Some(project) = self.workspace.ws.project_mut(pid) else { continue };
                    let tab_ids: Vec<_> = project
                        .layout
                        .tabs()
                        .filter_map(|t| match &t.kind {
                            PaneKind::Chat { session_id: cur_sid, .. } if cur_sid == session_id => Some(t.id),
                            _ => None,
                        })
                        .collect();
                    for tab_id in tab_ids {
                        let Some(vibevalley_workspace::Tab {
                            kind:
                                PaneKind::Chat {
                                    runtime: cur_rt,
                                    title: cur_title,
                                    ..
                                },
                            ..
                        }) = project.layout.tab_mut(tab_id)
                        else {
                            continue;
                        };
                        matched_tabs.push((pid, tab_id));
                        if let Some(rt) = next_runtime.as_ref()
                            && cur_rt != rt
                        {
                            *cur_rt = rt.clone();
                            layout_dirty = true;
                            changed = true;
                        }
                        if let Some(t) = next_title.as_ref()
                            && cur_title.as_deref() != Some(t.as_str())
                        {
                            *cur_title = Some(t.clone());
                            layout_dirty = true;
                            changed = true;
                        }
                    }
                }
                for key in matched_tabs {
                    let entry = self.workspace.chat_statuses.entry(key).or_default();
                    if entry.status != next_status || entry.attention != next_attention {
                        entry.status = next_status.clone();
                        entry.attention = next_attention;
                        changed = true;
                    }
                }
                if layout_dirty {
                    self.schedule_save(cx);
                }
                if changed {
                    self.push_sidebar_topics(SidebarTopics::RAIL, cx);
                    cx.notify();
                }
            }
            vibevalley_protocol::SessionWatchEvent::Missing { .. } => {
                let mut changed = false;
                let ids: Vec<ProjectId> = self.workspace.ws.projects().iter().map(|p| p.id()).collect();
                for pid in ids {
                    let Some(project) = self.workspace.ws.project(pid) else { continue };
                    for tab in project.layout.tabs() {
                        if let PaneKind::Chat { session_id: cur_sid, .. } = &tab.kind
                            && cur_sid == session_id
                            && self.workspace.chat_statuses.remove(&(pid, tab.id)).is_some()
                        {
                            changed = true;
                        }
                    }
                }
                if let Some((sub_id, _)) = self.workspace.chat_watches.remove(session_id)
                    && let Some(bridge) = cx.try_global::<crate::hosted::BridgeHub>()
                {
                    bridge.0.server().unsubscribe(sub_id);
                }
                if changed {
                    self.push_sidebar_topics(SidebarTopics::RAIL, cx);
                    cx.notify();
                }
            }
            vibevalley_protocol::SessionWatchEvent::History { .. } | vibevalley_protocol::SessionWatchEvent::Event { .. } => {}
        }
    }

    pub fn new_terminal(&mut self, spec: Option<SpawnSpec>, window: &mut Window, cx: &mut Context<Self>) {
        self.show_workspace(cx);
        self.with_workspace_project(window, cx, move |s, id, window, cx| {
            let Some(spec) = spec.or_else(|| s.next_terminal_directory(cx).map(SpawnSpec::shell)) else {
                return;
            };
            let Ok(id) = id else { return };
            let Some(project) = s.workspace.ws.project_mut(id) else { return };
            let (id, _) = project.new_terminal_tab();
            let slot = s.make_terminal(&id, spec, window, cx);
            s.workspace.terminals.insert(id, slot);
            s.layout_changed(window, cx);
        });
    }

    /// A terminal tab at `cwd`, optionally running `command` first.
    pub(super) fn open_terminal_at(
        &mut self,
        cwd: PathBuf,
        title: Option<String>,
        command: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
        done: impl FnOnce(Result<String, String>) + 'static,
    ) {
        if cwd.as_os_str().is_empty() {
            self.show_workspace(cx);
            return self.with_workspace_project(window, cx, move |s, id, w, cx| {
                let result = id.and_then(|id| {
                    let cwd = s.workspace.ws.project(id).expect("loaded project").root().to_owned();
                    s.terminal_in_active_project(cwd, title, command, w, cx)
                });
                done(result);
            });
        }
        let known_roots: Vec<PathBuf> = self.workspace.ws.projects().iter().map(|p| p.root().to_owned()).collect();
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let resolved = cx.background_spawn(async move { resolve_project_directory(cwd, known_roots) }).await;
            let mut done = Some(done);
            let updated = cx.update_window(window_handle, |_, window, cx| {
                let _ = this.update(cx, |s, cx| match resolved {
                    Ok((directory, target)) => {
                        let callback = done.take().expect("callback not yet invoked");
                        s.with_project_at(target, window, cx, move |s, id, window, cx| {
                            let result = id.and_then(|id| {
                                s.workspace.ws.activate(id);
                                s.show_workspace(cx);
                                s.terminal_in_active_project(directory, title, command, window, cx)
                            });
                            if let Err(reason) = &result {
                                s.workspace.terminal_notice = Some(reason.clone());
                                cx.notify();
                            }
                            callback(result);
                        });
                    }
                    Err(reason) => {
                        s.workspace.terminal_notice = Some(reason.clone());
                        cx.notify();
                        if let Some(callback) = done.take() {
                            callback(Err(reason));
                        }
                    }
                });
            });
            if updated.is_err()
                && let Some(callback) = done.take()
            {
                callback(Err("window closed before terminal could open".into()));
            }
        })
        .detach();
    }

    fn terminal_in_active_project(
        &mut self,
        cwd: PathBuf,
        title: Option<String>,
        command: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Result<String, String> {
        let no_project = || vibevalley_i18n::t("desktop.terminal.noProject", &[]);
        self.workspace.terminal_notice = None;
        let mut spec = SpawnSpec::shell(cwd);
        spec.title = title.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty());
        if let Some(command) = command.filter(|c| !c.trim().is_empty()) {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            spec.program = Some(shell.clone());
            spec.args = vec!["-lc".into(), format!("{command}\nexec \"$0\" -l"), shell];
        }
        let link = spec
            .title
            .as_ref()
            .filter(|_| spec.program.is_none())
            .map(|title| vibevalley_workspace::TerminalLink {
                directory: spec.cwd.clone(),
                title: title.clone(),
            });
        let project = self.workspace.ws.active_mut().ok_or_else(no_project)?;
        if let Some(target) = &link {
            let existing = project.layout.tabs().find_map(|tab| {
                let PaneKind::Terminal {
                    terminal_id,
                    link: Some(origin),
                } = &tab.kind
                else {
                    return None;
                };
                if origin != target {
                    return None;
                }
                let in_directory = match self.workspace.terminals.get(terminal_id) {
                    Some(slot) => slot.view.read(cx).can_reopen_in(&target.directory),
                    None => project
                        .saved_terminal(terminal_id)
                        .is_some_and(|s| s.cwd.canonicalize().is_ok_and(|p| p.starts_with(&target.directory))),
                };
                in_directory.then(|| (tab.id, terminal_id.clone()))
            });
            if let Some((tab, id)) = existing {
                project.layout.activate(tab);
                self.layout_changed(window, cx);
                return Ok(id);
            }
        }
        let unused = project.layout.active_tab().and_then(|tab| {
            let PaneKind::Terminal { terminal_id, link: None } = &tab.kind else {
                return None;
            };
            (project.saved_terminal(terminal_id).is_none() && !self.workspace.terminals.contains_key(terminal_id)).then(|| (terminal_id.clone(), tab.id))
        });
        let (id, tab) = unused.unwrap_or_else(|| project.new_terminal_tab());
        if let Some(vibevalley_workspace::Tab {
            kind: PaneKind::Terminal { link: origin, .. },
            ..
        }) = project.layout.tab_mut(tab)
        {
            *origin = link;
        }
        let slot = self.make_terminal(&id, spec, window, cx);
        self.workspace.terminals.insert(id.clone(), slot);
        self.layout_changed(window, cx);
        Ok(id)
    }

    /// `$EDITOR file` in a new terminal tab (the viewer's "Open in editor").
    pub fn open_in_editor(&mut self, path: &Path, window: &mut Window, cx: &mut Context<Self>) {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let quoted = format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
        let cwd = path.parent().map(Path::to_path_buf).unwrap_or_default();
        let spec = SpawnSpec {
            cwd,
            project_root: self.workspace.ws.active().map(|p| p.root().to_path_buf()),
            program: Some(shell.clone()),
            args: vec!["-lc".into(), format!("${{EDITOR:-vi}} {quoted}; exec {shell} -l")],
            env: Vec::new(),
            history: None,
            title: None,
        };
        self.new_terminal(Some(spec), window, cx);
    }

    pub(super) fn split(&mut self, axis: Axis, window: &mut Window, cx: &mut Context<Self>) {
        let Some(cwd) = self.next_terminal_directory(cx) else { return };
        let id = vibevalley_workspace::util::new_id();
        let Some(project) = self.workspace.ws.active_mut() else { return };
        if project
            .layout
            .split(
                project.layout.focused,
                axis,
                PaneKind::Terminal {
                    terminal_id: id.clone(),
                    link: None,
                },
            )
            .is_none()
        {
            return;
        }
        let slot = self.make_terminal(&id, SpawnSpec::shell(cwd), window, cx);
        self.workspace.terminals.insert(id, slot);
        self.layout_changed(window, cx);
    }

    pub(super) fn close_active_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(project) = self.workspace.ws.active_mut() else { return };
        let Some(tab) = project.layout.active_tab().map(|t| t.id) else { return };
        self.close_tab(tab, window, cx);
    }

    pub fn close_tab(&mut self, tab: TabId, window: &mut Window, cx: &mut Context<Self>) {
        let Some(project) = self.workspace.ws.active_mut() else { return };
        let pid = project.id();
        let closed = project.close_tab(tab);
        if let Some(PaneKind::Terminal { terminal_id, .. }) = &closed {
            self.workspace.terminals.remove(terminal_id);
        }
        if let Some(session_id) = closed_chat_session_id(closed.as_ref())
            && let Some(bridge) = cx.try_global::<crate::hosted::BridgeHub>()
        {
            bridge.0.call("session.closeWorkspace".into(), json!({ "id": session_id }), |_| {});
        }
        self.workspace.panes.remove(&(pid, tab));
        self.workspace.chat_statuses.remove(&(pid, tab));
        if self.workspace.ws.active().is_some_and(|p| p.layout.tabs().next().is_none()) {
            self.new_terminal(None, window, cx);
            return;
        }
        self.layout_changed(window, cx);
    }

    pub fn layout_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.ensure_panes(window, cx);
        self.sync_chat_watches(cx);
        self.focus_active_pane(window, cx);
        self.schedule_save(cx);
        self.push_sidebar(cx);
        cx.notify();
    }

    pub fn focus_active_pane(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.ensure_panes(window, cx);
        let Some(project) = self.workspace.ws.active() else { return };
        let Some(tab) = project.layout.active_tab() else { return };
        let handle = match &tab.kind {
            PaneKind::Terminal { terminal_id, .. } => self.workspace.terminals.get(terminal_id).map(|t| t.view.read(cx).focus_handle(cx)),
            _ => self.workspace.panes.get(&(project.id(), tab.id)).map(|p| p.entity.focus_handle(cx)),
        };
        window.focus(&handle.unwrap_or_else(|| self.focus.clone()), cx);
    }

    /// Creates the entities for every visible tab of the active project.
    /// Entities of hidden projects stay alive in the maps.
    pub fn ensure_panes(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(pid) = self.workspace.ws.active_id() else { return };
        let Some(project) = self.workspace.ws.active() else { return };
        let visible: Vec<(TabId, PaneKind)> = project
            .layout
            .groups()
            .iter()
            .filter_map(|g| g.active_tab().map(|t| (t.id, t.kind.clone())))
            .collect();
        let root = project.root().to_path_buf();
        for (tab, kind) in visible {
            match kind {
                PaneKind::Terminal { terminal_id, .. } => {
                    if self.workspace.terminals.contains_key(&terminal_id) {
                        continue;
                    }
                    let saved = self.workspace.ws.active_mut().and_then(|p| p.take_restorable(&terminal_id));
                    let spec = match saved {
                        Some(saved) => SpawnSpec {
                            cwd: if saved.cwd.is_dir() { saved.cwd.clone() } else { root.clone() },
                            project_root: Some(root.clone()),
                            program: None,
                            args: Vec::new(),
                            env: Vec::new(),
                            history: Some(saved.scrollback).filter(|s| !s.trim().is_empty()),
                            title: saved.title.clone(),
                        },
                        None => SpawnSpec {
                            project_root: Some(root.clone()),
                            ..SpawnSpec::shell(root.clone())
                        },
                    };
                    let slot = self.make_terminal(&terminal_id, spec, window, cx);
                    self.workspace.terminals.insert(terminal_id, slot);
                }
                kind => {
                    if self.workspace.panes.contains_key(&(pid, tab)) {
                        continue;
                    }
                    let pane = self.make_pane(pid, tab, &root, kind, window, cx);
                    self.workspace.panes.insert((pid, tab), pane);
                }
            }
        }
    }

    fn make_terminal(&mut self, id: &str, mut spec: SpawnSpec, window: &mut Window, cx: &mut Context<Self>) -> TerminalSlot {
        if spec.project_root.is_none() {
            spec.project_root = self.workspace.ws.active().map(|p| p.root().to_path_buf());
        }
        let cwd = spec.cwd.clone();
        let initial_title = spec.title.clone();
        let view = cx.new(|cx| TerminalView::new(spec, cx));
        let tid = id.to_string();
        let sub = cx.subscribe_in(&view, window, move |this: &mut Shell, view, event: &TerminalEvent, window, cx| {
            let owner = this
                .workspace
                .ws
                .projects()
                .iter()
                .find(|p| p.layout.terminal_ids().contains(&tid))
                .map(|p| p.id());
            let Some(owner) = owner else { return };
            let on_screen = this.workspace.ws.active_id() == Some(owner);
            match event {
                TerminalEvent::OpenLink(target) => {
                    this.open_terminal_link(target.clone(), owner, window, cx);
                    return;
                }
                TerminalEvent::Spawned => {
                    if let Some(session) = view.read(cx).session()
                        && let Some(project) = this.workspace.ws.project_mut(owner)
                    {
                        project.attach_terminal(&tid, session.clone(), cwd.clone(), initial_title.clone());
                    }
                }
                TerminalEvent::TitleChanged => {
                    let title = view.read(cx).title().map(str::to_string);
                    let mut changed = false;
                    if let Some(project) = this.workspace.ws.project_mut(owner)
                        && let Some(entry) = project.terminal_mut(&tid)
                        && entry.title != title
                    {
                        entry.title = title;
                        changed = true;
                    }
                    if !changed {
                        return;
                    }
                }
                TerminalEvent::Bell | TerminalEvent::CommandFinished => {
                    if !on_screen
                        && let Some(project) = this.workspace.ws.project_mut(owner)
                        && let Some(entry) = project.terminal_mut(&tid)
                    {
                        entry.attention = true;
                    }
                }
                TerminalEvent::AgentTurnFinished { agent, label } => {
                    if !on_screen
                        && let Some(project) = this.workspace.ws.project_mut(owner)
                        && let Some(entry) = project.terminal_mut(&tid)
                    {
                        entry.attention = true;
                    }
                    if !crate::host::is_app_active() {
                        let title = this
                            .workspace
                            .ws
                            .project(owner)
                            .and_then(|p| p.root().file_name())
                            .and_then(|n| n.to_str())
                            .filter(|s| !s.is_empty())
                            .unwrap_or("VibeValley")
                            .to_string();
                        let display = crate::terminal::agent_display_name(agent, label);
                        let body = vibevalley_i18n::t("desktop.terminal.agentTurnDone", &[("agent", display.into())]);
                        Self::bg(
                            cx,
                            move || crate::host::notify(&title, &body),
                            |_, r, _| {
                                if let Err(e) = r {
                                    eprintln!("notify: {e}");
                                }
                            },
                        );
                    }
                }
                TerminalEvent::Exited => {
                    if let Some(project) = this.workspace.ws.project_mut(owner)
                        && let Some(entry) = project.terminal_mut(&tid)
                    {
                        entry.exited = true;
                    }
                }
                TerminalEvent::SpawnFailed(e) => {
                    eprintln!("terminal {tid}: {e}");
                    return;
                }
            }
            this.push_sidebar_topics(SidebarTopics::RAIL, cx);
            cx.notify();
        });
        TerminalSlot { view, _sub: sub }
    }

    fn open_terminal_link(&mut self, target: vibevalley_terminal::LinkTarget, owner: ProjectId, window: &mut Window, cx: &mut Context<Self>) {
        match target {
            vibevalley_terminal::LinkTarget::Url(url) => cx.open_url(&url),
            vibevalley_terminal::LinkTarget::File { path, line, col: _ } => {
                let project_root = self
                    .workspace
                    .ws
                    .project(owner)
                    .or_else(|| self.workspace.ws.active())
                    .map(|p| p.root().to_path_buf());
                let window = window.window_handle();
                cx.spawn(async move |this, cx| {
                    let viewer_target = cx
                        .background_spawn(async move {
                            match classify_terminal_file_action(path, line, project_root.as_deref()) {
                                TerminalFileAction::Viewer { path, line } => Some((path, line)),
                                TerminalFileAction::SystemOpen(path) => {
                                    if let Err(e) = crate::host::open(&path) {
                                        eprintln!("open {}: {e}", path.display());
                                    }
                                    None
                                }
                            }
                        })
                        .await;
                    if let Some((path, line)) = viewer_target {
                        let _ = cx.update_window(window, |_, window, cx| {
                            let _ = this.update(cx, |shell, cx| {
                                shell.open_file(path, line, window, cx);
                            });
                        });
                    }
                })
                .detach();
            }
        }
    }

    fn make_pane(&mut self, pid: ProjectId, tab: TabId, root: &Path, kind: PaneKind, window: &mut Window, cx: &mut Context<Self>) -> PaneSlot {
        let dark = Ui::get(cx).colors.dark;
        match kind {
            PaneKind::Chat {
                session_id,
                runtime,
                cwd,
                title,
            } => {
                let mut params = serde_json::Map::new();
                params.insert("tabId".into(), json!(tab));
                params.insert("sessionId".into(), json!(session_id));
                params.insert("runtime".into(), json!(runtime));
                params.insert("cwd".into(), json!(cwd));
                if let Some(repo) = root.file_name().and_then(|n| n.to_str()) {
                    params.insert("repo".into(), json!(repo));
                }
                if let Some(title) = title {
                    params.insert("title".into(), json!(title));
                }
                let view = cx.new(|cx| HostedView::new("workspace-chat", params, dark, window, cx));
                let sub = self.subscribe_hosted(&view, window, cx);
                PaneSlot {
                    entity: PaneEntity::Hosted(view),
                    _sub: sub,
                }
            }
            PaneKind::File { path } => {
                let view = cx.new(|cx| FileViewer::new(path, cx));
                let sub = cx.subscribe_in(&view, window, |this, view, event: &crate::viewer::ViewerEvent, window, cx| match event {
                    crate::viewer::ViewerEvent::OpenInEditor => {
                        let path = view.read(cx).path().to_path_buf();
                        this.open_in_editor(&path, window, cx);
                    }
                    crate::viewer::ViewerEvent::Preview => {
                        let path = view.read(cx).path().to_path_buf();
                        this.open_pane(
                            PaneKind::Hosted {
                                module: "markdown".into(),
                                props: json!({ "path": path }),
                            },
                            window,
                            cx,
                        );
                    }
                    crate::viewer::ViewerEvent::Reveal => {
                        let path = view.read(cx).path().to_path_buf();
                        Self::bg(cx, move || crate::host::reveal(&path), |_, _, _| {});
                    }
                });
                PaneSlot {
                    entity: PaneEntity::File(view),
                    _sub: sub,
                }
            }
            PaneKind::Diff { spec, path, repo } => {
                let repo = repo.unwrap_or_else(|| root.to_path_buf());
                let view = cx.new(|cx| DiffView::new(repo, spec, path, cx));
                let sub = cx.subscribe(&view, move |this: &mut Shell, _, _: &crate::diff::DiffChanged, cx| {
                    this.refresh_git(pid, cx);
                });
                PaneSlot {
                    entity: PaneEntity::Diff(view),
                    _sub: sub,
                }
            }
            PaneKind::Hosted { module, props } if module == "markdown" => {
                let path = props.get("path").and_then(|p| p.as_str()).map(PathBuf::from).unwrap_or_default();
                let view = cx.new(|cx| MarkdownView::new(path, window, cx));
                let sub = cx.subscribe_in(&view, window, |this, view, event: &MarkdownPaneEvent, window, cx| match event {
                    MarkdownPaneEvent::OpenSource => {
                        let path = view.read(cx).path().to_path_buf();
                        this.open_file(path, None, window, cx);
                    }
                    MarkdownPaneEvent::OpenFile(path) => {
                        this.open_file(path.clone(), None, window, cx);
                    }
                    MarkdownPaneEvent::OpenUrl(url) => {
                        if url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:") {
                            cx.open_url(url);
                        }
                    }
                    MarkdownPaneEvent::OpenRoute(route) => {
                        this.navigate_workbench(route, cx);
                    }
                    MarkdownPaneEvent::OpenInEditor => {
                        let path = view.read(cx).path().to_path_buf();
                        this.open_in_editor(&path, window, cx);
                    }
                    MarkdownPaneEvent::Reveal => {
                        let path = view.read(cx).path().to_path_buf();
                        Self::bg(cx, move || crate::host::reveal(&path), |_, _, _| {});
                    }
                });
                PaneSlot {
                    entity: PaneEntity::Markdown(view),
                    _sub: sub,
                }
            }
            PaneKind::Hosted { module, props } => {
                let mut params = props.as_object().cloned().unwrap_or_default();
                params.insert("module".into(), json!(module));
                let view = cx.new(|cx| HostedView::new(&module, params, dark, window, cx));
                let sub = self.subscribe_hosted(&view, window, cx);
                PaneSlot {
                    entity: PaneEntity::Hosted(view),
                    _sub: sub,
                }
            }
            PaneKind::Pixel { scene, mut props } => {
                if !props.is_object() {
                    props = json!({});
                }
                if props.get("cwd").is_none() {
                    props["cwd"] = json!(root);
                }
                let view = cx.new(|cx| crate::pixel::view::PixelView::new(&scene, props, cx));
                let sub = cx.subscribe_in(&view, window, |this, _, event: &crate::pixel::view::PixelEvent, window, cx| {
                    this.on_pixel_event(event.clone(), window, cx)
                });
                PaneSlot {
                    entity: PaneEntity::Pixel(view),
                    _sub: sub,
                }
            }
            PaneKind::Terminal { .. } => unreachable!("terminals are kept in Shell::workspace.terminals"),
        }
    }
}

fn resolve_project_directory(cwd: PathBuf, known_roots: Vec<PathBuf>) -> Result<(PathBuf, PathBuf), String> {
    let Some(directory) = cwd.canonicalize().ok().filter(|p| p.is_dir()) else {
        return Err(format!("{} {}", vibevalley_i18n::t("desktop.terminal.missingFolder", &[]), cwd.display()));
    };
    let repo = Repo::discover(&directory).ok().flatten();
    let root = repo.as_ref().map(|r| r.root()).unwrap_or(&directory);
    let target = known_roots
        .into_iter()
        .filter_map(|known| {
            let path = known.canonicalize().ok()?;
            (path == root || (repo.is_none() && directory.starts_with(&path))).then(|| (path.components().count(), known))
        })
        .max_by_key(|(depth, _)| *depth)
        .map(|(_, path)| path)
        .unwrap_or_else(|| root.to_owned());
    Ok((directory, target))
}

fn closed_chat_session_id(closed: Option<&PaneKind>) -> Option<String> {
    let PaneKind::Chat { session_id, .. } = closed? else { return None };
    let trimmed = session_id.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TerminalFileAction {
    Viewer { path: PathBuf, line: Option<u32> },
    SystemOpen(PathBuf),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FilePreviewKind {
    Text,
    Image,
    SystemOnly,
}

fn sniff_file_preview_kind(path: &Path) -> FilePreviewKind {
    use std::io::Read as _;

    const MAX_VIEWER_BYTES: u64 = 8 * 1024 * 1024;
    const SNIFF_BYTES: usize = 8192;
    const IMAGE_EXTS: &[&str] = &[
        "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "tif", "tiff", "heic", "heif", "avif", "svg",
    ];

    let Ok(meta) = std::fs::metadata(path) else {
        return FilePreviewKind::SystemOnly;
    };
    if !meta.is_file() {
        return FilePreviewKind::SystemOnly;
    }
    if path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
    {
        return FilePreviewKind::Image;
    }
    if meta.len() > MAX_VIEWER_BYTES {
        return FilePreviewKind::SystemOnly;
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return FilePreviewKind::SystemOnly;
    };
    let mut head = [0u8; SNIFF_BYTES];
    let n = file.read(&mut head).unwrap_or(0);
    let head = &head[..n];
    let utf16_bom = matches!(head, [0xFF, 0xFE, ..] | [0xFE, 0xFF, ..]);
    if !utf16_bom && head.contains(&0) {
        return FilePreviewKind::SystemOnly;
    }
    FilePreviewKind::Text
}

fn is_plain_text_name(path: &Path) -> bool {
    const TEXT_EXTS: &[&str] = &[
        "txt", "log", "env", "ini", "cfg", "conf", "csv", "tsv", "xml", "sql", "graphql", "gql", "proto", "diff", "patch", "lock", "nix", "rb", "java", "kt",
        "scala", "php", "lua", "vim", "fish", "tf", "hcl",
    ];
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| TEXT_EXTS.iter().any(|t| ext.eq_ignore_ascii_case(t)))
}

fn path_is_inside(path: &Path, root: &Path) -> bool {
    let canon_path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let canon_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    canon_path.starts_with(canon_root)
}

fn classify_terminal_file_action(path: PathBuf, line: Option<u32>, project_root: Option<&Path>) -> TerminalFileAction {
    let Some(root) = project_root else {
        return TerminalFileAction::SystemOpen(path);
    };
    let in_project = path_is_inside(&path, root);
    match sniff_file_preview_kind(&path) {
        FilePreviewKind::SystemOnly => TerminalFileAction::SystemOpen(path),
        FilePreviewKind::Image => {
            if in_project {
                TerminalFileAction::Viewer { path, line: None }
            } else {
                TerminalFileAction::SystemOpen(path)
            }
        }
        FilePreviewKind::Text => {
            if in_project || line.is_some() || vibevalley_files::Language::from_path(&path).is_some() || is_plain_text_name(&path) {
                TerminalFileAction::Viewer { path, line }
            } else {
                TerminalFileAction::SystemOpen(path)
            }
        }
    }
}

#[cfg(test)]
mod url_tests {
    #[test]
    fn file_urls_decode() {
        assert_eq!(crate::host::percent_decode("/tmp/%E6%88%AA%E5%9B%BE%201.png"), "/tmp/截图 1.png");
        assert_eq!(crate::host::percent_decode("/a%zzb%"), "/a%zzb%");
    }

    #[test]
    fn terminal_file_action_routes_project_text_to_viewer_and_binaries_or_external_media_to_system() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("proj");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        let proj_rs = project.join("main.rs");
        let proj_png = project.join("icon.png");
        let proj_bin = project.join("app.bin");
        let ext_rs = outside.join("lib.rs");
        let ext_unknown_text = outside.join("scratch");
        let ext_png = outside.join("photo.png");
        let ext_pdf = outside.join("doc.pdf");

        std::fs::write(&proj_rs, "fn main() {}\n").unwrap();
        std::fs::write(&proj_png, b"\x89PNG\r\n\x1a\n").unwrap();
        std::fs::write(&proj_bin, b"\x7fELF\0\x01\x02").unwrap();
        std::fs::write(&ext_rs, "pub fn x() {}\n").unwrap();
        std::fs::write(&ext_unknown_text, "plain text\n").unwrap();
        std::fs::write(&ext_png, b"\x89PNG\r\n\x1a\n").unwrap();
        std::fs::write(&ext_pdf, b"%PDF-1.7\0binary").unwrap();

        assert_eq!(
            super::classify_terminal_file_action(proj_rs.clone(), Some(12), Some(&project)),
            super::TerminalFileAction::Viewer {
                path: proj_rs.clone(),
                line: Some(12),
            }
        );
        assert_eq!(
            super::classify_terminal_file_action(proj_png.clone(), None, Some(&project)),
            super::TerminalFileAction::Viewer { path: proj_png, line: None }
        );
        assert_eq!(
            super::classify_terminal_file_action(proj_bin.clone(), None, Some(&project)),
            super::TerminalFileAction::SystemOpen(proj_bin)
        );
        assert_eq!(
            super::classify_terminal_file_action(ext_rs.clone(), Some(5), Some(&project)),
            super::TerminalFileAction::Viewer { path: ext_rs, line: Some(5) }
        );
        assert_eq!(
            super::classify_terminal_file_action(ext_unknown_text.clone(), None, Some(&project)),
            super::TerminalFileAction::SystemOpen(ext_unknown_text.clone())
        );
        assert_eq!(
            super::classify_terminal_file_action(ext_unknown_text.clone(), Some(3), Some(&project)),
            super::TerminalFileAction::Viewer {
                path: ext_unknown_text,
                line: Some(3),
            }
        );
        assert_eq!(
            super::classify_terminal_file_action(ext_png.clone(), None, Some(&project)),
            super::TerminalFileAction::SystemOpen(ext_png)
        );
        assert_eq!(
            super::classify_terminal_file_action(ext_pdf.clone(), None, Some(&project)),
            super::TerminalFileAction::SystemOpen(ext_pdf)
        );
        assert_eq!(
            super::classify_terminal_file_action(project.clone(), None, Some(&project)),
            super::TerminalFileAction::SystemOpen(project)
        );
        assert_eq!(
            super::classify_terminal_file_action(proj_rs.clone(), Some(1), None),
            super::TerminalFileAction::SystemOpen(proj_rs)
        );
    }

    #[test]
    fn closed_chat_session_id_only_matches_non_empty_chat_tabs() {
        use std::path::PathBuf;
        use vibevalley_workspace::PaneKind;

        assert_eq!(
            super::closed_chat_session_id(Some(&PaneKind::Chat {
                session_id: " w42 ".into(),
                runtime: "antigravity".into(),
                cwd: PathBuf::from("/tmp"),
                title: None,
            })),
            Some("w42".into())
        );
        assert_eq!(
            super::closed_chat_session_id(Some(&PaneKind::Chat {
                session_id: "   ".into(),
                runtime: "antigravity".into(),
                cwd: PathBuf::from("/tmp"),
                title: None,
            })),
            None
        );
        assert_eq!(
            super::closed_chat_session_id(Some(&PaneKind::Terminal {
                terminal_id: "t1".into(),
                link: None,
            })),
            None
        );
        assert_eq!(super::closed_chat_session_id(None), None);
    }

    #[test]
    fn resolve_project_directory_matches_known_root_and_rejects_missing_folder() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        let nested = project.join("src");
        std::fs::create_dir_all(&nested).unwrap();

        let (resolved_dir, target) = super::resolve_project_directory(nested.clone(), vec![project.clone()]).expect("existing directory resolves");
        assert_eq!(resolved_dir, nested.canonicalize().unwrap());
        assert_eq!(target, project);

        let missing = dir.path().join("does-not-exist");
        assert!(super::resolve_project_directory(missing, vec![]).is_err());
    }
}
