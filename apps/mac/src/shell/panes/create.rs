use std::path::{Path, PathBuf};

use gpui::{AppContext as _, Context, Window};
use serde_json::json;
use vibevalley_workspace::{PaneKind, ProjectId, TabId};

use crate::diff::DiffView;
use crate::hosted::HostedView;
use crate::markdown_pane::{MarkdownPaneEvent, MarkdownView};
use crate::panes::PaneEntity;
use crate::terminal::SpawnSpec;
use crate::theme::Ui;
use crate::viewer::FileViewer;

use super::super::{PaneSlot, Shell};

impl Shell {
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
                            hooks: Default::default(),
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
                    crate::viewer::ViewerEvent::OpenInEditor(target) => {
                        let path = view.read(cx).path().to_path_buf();
                        this.open_in_editor_target(&path, target.clone(), window, cx);
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
                    MarkdownPaneEvent::OpenInEditor(target) => {
                        let path = view.read(cx).path().to_path_buf();
                        this.open_in_editor_target(&path, target.clone(), window, cx);
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
            PaneKind::Diorama { scene, mut props } => {
                if !props.is_object() {
                    props = json!({});
                }
                if props.get("cwd").is_none() {
                    props["cwd"] = json!(root);
                }
                let view = cx.new(|cx| crate::diorama::DioramaView::new(&scene, props, cx));
                let sub = cx.subscribe_in(&view, window, |this, _, event: &crate::diorama::DioramaEvent, window, cx| {
                    this.on_diorama_event(event.clone(), window, cx)
                });
                PaneSlot {
                    entity: PaneEntity::Diorama(view),
                    _sub: sub,
                }
            }
            PaneKind::Terminal { .. } => unreachable!("terminals are kept in Shell::workspace.terminals"),
        }
    }
}
