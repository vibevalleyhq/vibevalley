use std::path::{Path, PathBuf};

use gpui::{AppContext as _, Context, Focusable, Window};
use serde_json::{Value, json};
use vibevalley_server::gateway::bridge::BridgeRpc as _;
use vibevalley_workspace::{Axis, PaneKind, ProjectId, TabId};

use crate::panes::PaneEntity;
use crate::terminal::SpawnSpec;

use super::super::{DioramaSlot, Shell};
use super::policy::{TabCloseAction, closed_chat_session_id, non_terminal_tab_busy_label, tab_close_action, terminal_history_path};

impl Shell {
    pub(crate) fn navigate_workbench(&mut self, route: &str, cx: &mut Context<Self>) {
        self.chrome.native_workspace = false;
        self.chrome.native_diorama = None;
        self.chrome.explicit_route = true;
        self.chrome.last_route = Some(route.to_string());
        self.sync_devtools_route(route);
        self.chrome.workbench.update(cx, |v, cx| v.navigate(route, cx));
        self.publish_host_debug(cx);
        cx.notify();
    }

    pub(crate) fn show_workspace(&mut self, cx: &mut Context<Self>) {
        if self.chrome.native_workspace && self.chrome.native_diorama.is_none() && self.chrome.last_route.as_deref() == Some("/workspace") {
            return;
        }
        self.chrome.native_workspace = true;
        self.chrome.native_diorama = None;
        self.chrome.last_route = Some("/workspace".to_string());
        self.sync_devtools_route("/workspace");
        self.chrome.workbench.update(cx, |v, cx| v.navigate("/workspace", cx));
        self.publish_host_debug(cx);
        cx.notify();
    }

    pub(crate) fn show_diorama(&mut self, scene: &str, mut props: Value, window: &mut Window, cx: &mut Context<Self>) {
        if props.get("cwd").is_none() {
            props["cwd"] = json!(self.workspace.ws.active().map(|p| p.root().to_path_buf()));
        }
        let view = cx.new(|cx| crate::diorama::DioramaView::new(scene, props, cx));
        let sub = cx.subscribe_in(&view, window, |this, _, event: &crate::diorama::DioramaEvent, window, cx| {
            this.on_diorama_event(event.clone(), window, cx)
        });
        self.chrome.native_workspace = false;
        window.focus(&gpui::Focusable::focus_handle(view.read(cx), cx), cx);
        self.chrome.native_diorama = Some(DioramaSlot { view, _sub: sub });
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
        if let PaneKind::Diorama { scene, props } = kind {
            self.show_diorama(&scene, props, window, cx);
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

    pub(in crate::shell) fn split(&mut self, axis: Axis, window: &mut Window, cx: &mut Context<Self>) {
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
                    hooks: Default::default(),
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

    pub(in crate::shell) fn close_active_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(project) = self.workspace.ws.active() else { return };
        let Some(tab) = project.layout.active_tab().map(|t| t.id) else { return };
        self.close_tab(tab, window, cx);
    }

    pub fn close_tab(&mut self, tab: TabId, window: &mut Window, cx: &mut Context<Self>) {
        self.close_tab_with_force(tab, false, window, cx);
    }

    pub fn close_tab_with_force(&mut self, tab: TabId, force: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(project) = self.workspace.ws.active() else { return };
        let pid = project.id();
        let Some(tab_ref) = project.layout.tabs().find(|t| t.id == tab) else { return };
        let busy = if force { None } else { self.busy_tab_label(pid, tab_ref, cx) };
        match tab_close_action(busy, force) {
            TabCloseAction::CloseNow => self.force_close_tab(pid, tab, window, cx),
            TabCloseAction::ConfirmBusy { label } => {
                let title_text = super::super::tab_title(self, tab_ref, cx);
                let title = vibevalley_i18n::t("desktop.tab.closeBusy.title", &[("title", title_text.into())]);
                let detail = vibevalley_i18n::t("desktop.tab.closeBusy.detail", &[("process", label.into())]);
                let cancel = vibevalley_i18n::t("desktop.tab.closeBusy.cancel", &[]);
                let confirm = vibevalley_i18n::t("desktop.tab.closeBusy.confirm", &[]);
                let rx = window.prompt(
                    gpui::PromptLevel::Warning,
                    &title,
                    Some(&detail),
                    &[gpui::PromptButton::cancel(cancel), gpui::PromptButton::new(confirm)],
                    cx,
                );
                let shell = cx.weak_entity();
                window
                    .spawn(cx, async move |cx| {
                        if rx.await == Ok(1) {
                            let _ = cx.update(|window, cx| {
                                let _ = shell.update(cx, |shell, cx| shell.force_close_tab(pid, tab, window, cx));
                            });
                        }
                    })
                    .detach();
            }
        }
    }

    fn busy_tab_label(&self, pid: ProjectId, tab: &vibevalley_workspace::Tab, cx: &gpui::App) -> Option<String> {
        match &tab.kind {
            PaneKind::Terminal { terminal_id, .. } => self.workspace.terminals.get(terminal_id).and_then(|slot| slot.view.read(cx).busy_label()),
            kind => non_terminal_tab_busy_label(kind, self.workspace.chat_statuses.get(&(pid, tab.id))),
        }
    }

    fn force_close_tab(&mut self, pid: ProjectId, tab: TabId, window: &mut Window, cx: &mut Context<Self>) {
        let Some(project) = self.workspace.ws.project_mut(pid) else { return };
        let Some(closed) = project.close_tab(tab) else { return };
        if let PaneKind::Terminal { terminal_id, .. } = &closed {
            self.workspace.terminals.remove(terminal_id);
            vibevalley_terminal::history::remove_history_file(&terminal_history_path(terminal_id));
        }
        if let Some(session_id) = closed_chat_session_id(Some(&closed))
            && let Some(bridge) = cx.try_global::<crate::hosted::BridgeHub>()
        {
            bridge.0.call("session.closeWorkspace".into(), json!({ "id": session_id }), |_| {});
        }
        self.workspace.panes.remove(&(pid, tab));
        self.workspace.chat_statuses.remove(&(pid, tab));
        if self.workspace.ws.active_id() == Some(pid) {
            if self.workspace.ws.active().is_some_and(|p| p.layout.tabs().next().is_none()) {
                self.new_terminal(None, window, cx);
                return;
            }
            self.layout_changed(window, cx);
        } else {
            self.schedule_save(cx);
            self.push_sidebar(cx);
            cx.notify();
        }
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
}
