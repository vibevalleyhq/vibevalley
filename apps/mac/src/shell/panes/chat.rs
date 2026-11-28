use std::path::PathBuf;

use gpui::{AppContext as _, Context, Window};
use serde_json::json;
use vibevalley_workspace::{PaneKind, ProjectId, TabId};

use super::super::Shell;
use super::super::projects::SidebarTopics;
use super::policy::resolve_project_directory;

impl Shell {
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

    pub(in crate::shell) fn open_chat_at(&mut self, cwd: PathBuf, runtime: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
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

    pub(in crate::shell) fn bind_chat_session(&mut self, tab_id: TabId, session_id: String, runtime: Option<String>, cx: &mut Context<Self>) {
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

    pub(in crate::shell) fn sync_chat_watches(&mut self, cx: &mut Context<Self>) {
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
            let watch_sid = sid.clone();
            let server_for_watch = server.clone();
            let task = cx.spawn(async move |this, cx| {
                let Ok((sub_id, mut rx)) = server_for_watch
                    .clone()
                    .subscribe_with_async(
                        vibevalley_server::gateway::bridge::CallerContext::local(),
                        "session.watch".into(),
                        json!({ "id": watch_sid, "afterSeq": i64::MAX }),
                    )
                    .await
                else {
                    let _ = this.update(cx, |shell, _| {
                        shell.workspace.chat_watches.remove(&watch_sid);
                    });
                    return;
                };
                if this
                    .update(cx, |shell, _| {
                        if let Some(entry) = shell.workspace.chat_watches.get_mut(&watch_sid) {
                            entry.0 = sub_id;
                        } else {
                            server_for_watch.unsubscribe(sub_id);
                        }
                    })
                    .is_err()
                {
                    server_for_watch.unsubscribe(sub_id);
                    return;
                }
                while let Some(value) = rx.recv().await {
                    let Ok(ev) = serde_json::from_value::<vibevalley_protocol::SessionWatchEvent>(value) else {
                        continue;
                    };
                    if this.update(cx, |shell, cx| shell.apply_chat_watch_event(&watch_sid, ev, cx)).is_err() {
                        server_for_watch.unsubscribe(sub_id);
                        return;
                    }
                }
                let _ = this.update(cx, |shell, cx| {
                    if let Some((sub_id, _)) = shell.workspace.chat_watches.remove(&watch_sid)
                        && sub_id != 0
                        && let Some(bridge) = cx.try_global::<crate::hosted::BridgeHub>()
                    {
                        bridge.0.server().unsubscribe(sub_id);
                    }
                });
            });
            self.workspace.chat_watches.insert(sid, (0, task));
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
}
