use gpui::Context;
use vibevalley_workspace::{PaneKind, ProjectId, TabId};

use super::super::Shell;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalHookMenuEntry {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    pub tab_enabled: bool,
    pub workspace_enabled: bool,
    pub source: Option<vibevalley_terminal::HookSource>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TerminalHookMenuModel {
    pub repo_name: String,
    pub status: crate::terminal::TerminalHookStatus,
    pub entries: Vec<TerminalHookMenuEntry>,
}

impl Shell {
    pub(crate) fn terminal_hook_status_for_tab(&self, tab: &vibevalley_workspace::Tab, cx: &gpui::App) -> crate::terminal::TerminalHookStatus {
        let PaneKind::Terminal { terminal_id, hooks, .. } = &tab.kind else {
            return crate::terminal::TerminalHookStatus::default();
        };
        if let Some(slot) = self.workspace.terminals.get(terminal_id) {
            return slot.view.read(cx).hook_status();
        }
        let workspace_root = self.workspace.ws.projects().iter().find(|p| p.layout.tab(tab.id).is_some()).map(|p| p.root());
        let resolved = self.workspace.terminal_hooks.resolve_for_tab(workspace_root, hooks);
        crate::terminal::TerminalHookStatus::from_resolved(&resolved, &resolved)
    }

    pub(crate) fn terminal_hook_menu_model(&self, pid: ProjectId, tab: &vibevalley_workspace::Tab, cx: &gpui::App) -> Option<TerminalHookMenuModel> {
        let PaneKind::Terminal { hooks, .. } = &tab.kind else {
            return None;
        };
        let project = self.workspace.ws.project(pid)?;
        let root = project.root();
        let repo_name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| project.info.name.clone());
        let resolved = self.workspace.terminal_hooks.resolve_for_tab(Some(root), hooks);
        let status = self.terminal_hook_status_for_tab(tab, cx);
        let entries = self
            .workspace
            .terminal_hooks
            .catalog()
            .into_iter()
            .map(|tmpl| {
                let workspace_enabled = self.workspace.terminal_hooks.is_workspace_hook_enabled(Some(root), &tmpl.id);
                let active_entry = resolved.active.iter().find(|a| a.id == tmpl.id);
                let tab_enabled = active_entry.is_some();
                let source = active_entry.map(|a| a.source);
                TerminalHookMenuEntry {
                    id: tmpl.id,
                    label: tmpl.label,
                    description: tmpl.description,
                    tab_enabled,
                    workspace_enabled,
                    source,
                }
            })
            .collect();
        Some(TerminalHookMenuModel { repo_name, status, entries })
    }

    pub(crate) fn toggle_terminal_tab_hook(&mut self, pid: ProjectId, tab_id: TabId, hook_id: &str, cx: &mut Context<Self>) {
        let Some(project) = self.workspace.ws.project_mut(pid) else { return };
        let root = project.root().to_path_buf();
        let workspace_default = self.workspace.terminal_hooks.is_workspace_hook_enabled(Some(&root), hook_id);
        let Some(vibevalley_workspace::Tab {
            kind: PaneKind::Terminal { terminal_id, hooks, .. },
            ..
        }) = project.layout.tab_mut(tab_id)
        else {
            return;
        };
        let tid = terminal_id.clone();
        let resolved_before = self.workspace.terminal_hooks.resolve_for_tab(Some(&root), hooks);
        let norm_id = vibevalley_terminal::hooks::normalize_hook_id(hook_id).unwrap_or_else(|| hook_id.to_string());
        let currently_enabled = resolved_before.active.iter().any(|h| h.id == norm_id);
        hooks.set_enabled(&norm_id, workspace_default, !currently_enabled);
        self.schedule_save(cx);
        self.apply_terminal_hook_change(pid, &tid, cx);
        cx.notify();
    }

    pub(crate) fn toggle_workspace_terminal_hook(&mut self, pid: ProjectId, hook_id: &str, cx: &mut Context<Self>) {
        let Some(root) = self.workspace.ws.project(pid).map(|p| p.root().to_path_buf()) else {
            return;
        };
        let currently_enabled = self.workspace.terminal_hooks.is_workspace_hook_enabled(Some(&root), hook_id);
        self.workspace.terminal_hooks.set_workspace_hook_enabled(&root, hook_id, !currently_enabled);
        self.save_terminal_hooks_async(cx);
        let terminal_ids = self.workspace.ws.project(pid).map(|p| p.layout.terminal_ids()).unwrap_or_default();
        for tid in terminal_ids {
            self.apply_terminal_hook_change(pid, &tid, cx);
        }
        cx.notify();
    }

    pub(crate) fn restart_terminal_tab(&mut self, pid: ProjectId, tab_id: TabId, cx: &mut Context<Self>) {
        let Some(project) = self.workspace.ws.project(pid) else { return };
        let root = project.root().to_path_buf();
        let Some(vibevalley_workspace::Tab {
            kind: PaneKind::Terminal { terminal_id, hooks, .. },
            ..
        }) = project.layout.tab(tab_id)
        else {
            return;
        };
        let tid = terminal_id.clone();
        let resolved = self.workspace.terminal_hooks.resolve_for_tab(Some(&root), hooks);
        if let Some(slot) = self.workspace.terminals.get(&tid) {
            slot.view.update(cx, |view, cx| view.respawn_with_hooks(resolved, cx));
        }
        self.workspace.terminal_hooks_menu_group = None;
        cx.notify();
    }

    fn apply_terminal_hook_change(&mut self, pid: ProjectId, terminal_id: &str, cx: &mut Context<Self>) {
        let Some(project) = self.workspace.ws.project(pid) else { return };
        let root = project.root().to_path_buf();
        let overrides = project.layout.terminal_hook_overrides(terminal_id).cloned().unwrap_or_default();
        let resolved = self.workspace.terminal_hooks.resolve_for_tab(Some(&root), &overrides);
        let Some(slot) = self.workspace.terminals.get(terminal_id) else {
            return;
        };
        let (unchanged, action) = {
            let view = slot.view.read(cx);
            let unchanged = *view.desired_hooks() == resolved;
            let action = crate::terminal::classify_hook_toggle_action(view.is_alive(), view.has_foreground_process());
            (unchanged, action)
        };
        if unchanged {
            return;
        }
        match action {
            crate::terminal::HookToggleAction::RespawnNow => {
                slot.view.update(cx, |view, cx| view.respawn_with_hooks(resolved, cx));
            }
            crate::terminal::HookToggleAction::PendingRestart => {
                slot.view.update(cx, |view, cx| view.set_desired_hooks(resolved, cx));
            }
        }
    }

    fn save_terminal_hooks_async(&self, cx: &mut Context<Self>) {
        let Some(store) = self.workspace.store.clone() else { return };
        let config = self.workspace.terminal_hooks.clone();
        Self::bg_tokio(
            cx,
            async move { vibevalley_workspace::save_terminal_hooks(&*store, &config).await },
            |_, r, _| {
                if let Err(e) = r {
                    eprintln!("save terminal hooks: {e}");
                }
            },
        );
    }
}
