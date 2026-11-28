use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use gpui::{AppContext as _, Context, Entity, Subscription};
use serde_json::{Value, json};
use vibevalley_files::{FileIndex, Watcher};
use vibevalley_git::{Branch, Commit, Status, Worktree};
use vibevalley_workspace::PaneKind;

use crate::hosted::HostedView;
use crate::hosted::frames::{self, PaletteMode, TreeState};
use crate::panes::PaneEntity;
use crate::terminal::TerminalView;

use super::Shell;

/// UI-side state of one open project: its tree, git state and file index.
pub struct ProjectView {
    pub tree: TreeState,
    pub repo_root: Option<PathBuf>,
    pub status: Option<Status>,
    pub tones: HashMap<PathBuf, &'static str>,
    pub branches: Vec<Branch>,
    pub worktrees: Vec<Worktree>,
    pub worktree_activity: HashMap<PathBuf, frames::WorktreeActivity>,
    pub log: Vec<Commit>,
    pub git_error: Option<String>,
    pub git_busy: bool,
    pub index: Option<Arc<FileIndex>>,
    pub(super) dirs_gen: u64,
    pub(super) git_gen: u64,
    pub(super) _watcher: Option<Watcher>,
}

pub struct Palette {
    pub view: Entity<HostedView>,
    pub open: bool,
    pub mode: PaletteMode,
    pub query: String,
    /// Bumped per query so late results of an older one are dropped.
    pub(super) seq: u64,
    pub(super) _sub: Subscription,
}

/// Lazily mounted right-side workspace inspector QuickJS surface; dropped immediately when closed.
pub struct InspectorSlot {
    pub view: Entity<HostedView>,
    pub(super) _sub: Subscription,
}

/// A project's git state as the sidebar shows it.
#[derive(PartialEq, Eq)]
pub struct GitSummary {
    pub branch: Option<String>,
    pub worktrees: Vec<Worktree>,
}

pub struct TerminalSlot {
    pub view: Entity<TerminalView>,
    pub(super) _sub: Subscription,
}

pub struct PaneSlot {
    pub entity: PaneEntity,
    pub(super) _sub: Subscription,
}

pub struct DioramaSlot {
    pub view: Entity<crate::diorama::DioramaView>,
    pub(super) _sub: Subscription,
}

#[derive(Debug, Clone, Default)]
pub struct ChatTabStatus {
    pub status: String,
    pub attention: bool,
}

impl Shell {
    pub(super) fn publish_host_debug(&self, cx: &gpui::App) {
        let Some(handle) = cx.try_global::<crate::hosted::ShellDebugHandle>() else {
            return;
        };
        let active_project = self.workspace.ws.active_id();
        let projects: Vec<Value> = self
            .workspace
            .ws
            .projects()
            .iter()
            .map(|p| {
                let active_tab = p.layout.active_tab().map(|t| t.id);
                let tabs: Vec<Value> = p
                    .layout
                    .tabs()
                    .map(|t| {
                        json!({
                            "id": t.id,
                            "active": active_tab == Some(t.id),
                            "kind": match &t.kind {
                                PaneKind::Terminal { .. } => "terminal",
                                PaneKind::Chat { .. } => "chat",
                                PaneKind::File { .. } => "file",
                                PaneKind::Diff { .. } => "diff",
                                PaneKind::Hosted { .. } => "hosted",
                                PaneKind::Diorama { .. } => "diorama",
                            },
                            "title": super::tab_title(self, t, cx),
                        })
                    })
                    .collect();
                json!({
                    "id": p.id(),
                    "name": p.info.name,
                    "root": p.root().to_string_lossy(),
                    "active": active_project == Some(p.id()),
                    "tabs": tabs,
                })
            })
            .collect();
        let active_diorama = self.chrome.native_diorama.as_ref().map(|slot| {
            let view = slot.view.read(cx);
            json!({
                "kind": view.kind,
                "framesSeen": view.frames_seen,
            })
        });
        let routes = json!({
            "current": self.chrome.last_route.as_deref().unwrap_or("/issues"),
            "loaded": self.workspace.loaded,
            "nativeWorkspace": self.chrome.native_workspace,
            "panel": self.chrome.panel.as_str(),
            "sidebarVisible": self.chrome.sidebar_visible,
            "inspectorOpen": self.chrome.inspector_open,
            "activeProjectId": active_project,
            "projects": projects,
            "activeDiorama": active_diorama,
        });
        let caches = vec![
            crate::hosted::DebugCacheEntry {
                name: "panes".into(),
                entries: self.workspace.panes.len() as u32,
                detail: Some("open pane entities".into()),
            },
            crate::hosted::DebugCacheEntry {
                name: "terminals".into(),
                entries: self.workspace.terminals.len() as u32,
                detail: Some("live terminal views".into()),
            },
            crate::hosted::DebugCacheEntry {
                name: "projects".into(),
                entries: self.workspace.projects.len() as u32,
                detail: Some("loaded project views".into()),
            },
            crate::hosted::DebugCacheEntry {
                name: "chatWatches".into(),
                entries: self.workspace.chat_watches.len() as u32,
                detail: Some("active chat status watches".into()),
            },
        ];
        handle.update_shell(routes, caches);
    }

    /// Runs `work` on a background thread, then `then` on the UI thread.
    pub fn bg<R, W, T>(cx: &mut Context<Self>, work: W, then: T)
    where
        R: Send + 'static,
        W: FnOnce() -> R + Send + 'static,
        T: FnOnce(&mut Self, R, &mut Context<Self>) + 'static,
    {
        let task = cx.background_spawn(async move { work() });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |shell, cx| then(shell, result, cx));
        })
        .detach();
    }

    /// Runs a Tokio future on the shared I/O runtime without blocking GPUI threads,
    /// then delivers its result to `then` on the UI thread.
    pub fn bg_tokio<R, F, T>(cx: &mut Context<Self>, fut: F, then: T)
    where
        R: Send + 'static,
        F: std::future::Future<Output = R> + Send + 'static,
        T: FnOnce(&mut Self, R, &mut Context<Self>) + 'static,
    {
        let task = vibevalley_kit::rt::current_or_global_handle().spawn(fut);
        cx.spawn(async move |this, cx| {
            if let Ok(result) = task.await {
                let _ = this.update(cx, |shell, cx| then(shell, result, cx));
            }
        })
        .detach();
    }

    /// The opening says it is there (or failed), then gives way after a moment.
    pub(super) fn finish_opening(&mut self, ok: bool, cx: &mut Context<Self>) {
        let Some(opening) = self.overlays.launch.clone() else { return };
        if ok && (!self.workspace.loaded || !self.workspace.server_ready || !self.workspace.workbench_ready || self.workspace.load_error.is_some()) {
            return;
        }
        opening.update(cx, |v, _| {
            v.set_phase(
                if ok {
                    crate::diorama::opening::Phase::Ready
                } else {
                    crate::diorama::opening::Phase::Failed
                },
                100.0,
            )
        });
        if !ok {
            return;
        }
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(std::time::Duration::from_millis(350)).await;
            let _ = this.update(cx, |s, cx| {
                s.overlays.launch = None;
                cx.notify();
            });
        })
        .detach();
    }
}
