use gpui::Context;
use vibevalley_workspace::PaneKind;

use crate::hosted::frames::{self, RailProject};

use super::super::Shell;
use super::SidebarTopics;

impl Shell {
    pub fn push_sidebar(&mut self, cx: &mut Context<Self>) {
        self.push_sidebar_topics(SidebarTopics::ALL, cx);
    }

    pub(in crate::shell) fn push_sidebar_topics(&mut self, topics: SidebarTopics, cx: &mut Context<Self>) {
        if topics.rail {
            self.publish_host_debug(cx);
        }
        let sidebar_ready = self.chrome.sidebar.read(cx).is_ready();
        let inspector_ready = self.chrome.inspector_open && self.chrome.inspector.as_ref().is_some_and(|slot| slot.view.read(cx).is_ready());
        if !sidebar_ready && !inspector_ready {
            return;
        }
        let rail = topics.rail.then(|| {
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
                    let names = super::super::numbered_titles(self, p.layout.tabs(), cx);
                    let tabs: Vec<vibevalley_protocol::HostRailTab> = p
                        .layout
                        .tabs()
                        .map(|t| {
                            let title = names.get(&t.id).cloned().unwrap_or_else(|| super::super::tab_title(self, t, cx));
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
                                PaneKind::Diorama { .. } => ("diorama", false, vibevalley_protocol::HostRailRunningState::Idle, None, None, false),
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
            frames::rail(&rail_items, self.chrome.panel, Some(self.chrome.inspector_open))
        });
        let active_pv = self.workspace.ws.active_id().and_then(|id| self.workspace.projects.get(&id));
        let files = topics.files.then(|| match active_pv {
            Some(pv) => frames::file_tree(&pv.tree, &pv.tones),
            None => frames::empty_file_tree(!self.workspace.loaded),
        });
        let git = topics.git.then(|| match active_pv {
            Some(pv) => frames::git_panel(&frames::GitView {
                status: pv.status.as_ref(),
                branches: &pv.branches,
                worktrees: &pv.worktrees,
                worktree_activity: &pv.worktree_activity,
                current_root: pv.repo_root.as_deref(),
                log: &pv.log,
                error: pv.git_error.as_deref(),
                busy: pv.git_busy,
            }),
            None => frames::empty_git_panel(!self.workspace.loaded),
        });
        if sidebar_ready {
            self.chrome.sidebar.update(cx, |v, cx| {
                if let Some(r) = &rail {
                    v.push("rail", r.clone(), cx);
                }
                if let Some(f) = &files {
                    v.push("files", f.clone(), cx);
                }
                if let Some(g) = &git {
                    v.push("git", g.clone(), cx);
                }
            });
        }
        if inspector_ready && let Some(slot) = &self.chrome.inspector {
            slot.view.update(cx, |v, cx| {
                if let Some(r) = rail {
                    v.push("rail", r, cx);
                }
                if let Some(f) = files {
                    v.push("files", f, cx);
                }
                if let Some(g) = git {
                    v.push("git", g, cx);
                }
            });
        }
    }
}
