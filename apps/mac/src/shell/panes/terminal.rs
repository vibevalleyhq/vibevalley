use std::path::{Path, PathBuf};

use gpui::{AppContext as _, Context, Window};
use vibevalley_workspace::{PaneKind, ProjectId};

use crate::terminal::{SpawnSpec, TerminalEvent, TerminalView};

use super::super::projects::SidebarTopics;
use super::super::{Shell, TerminalSlot};
use super::policy::{TerminalFileAction, classify_terminal_file_action, resolve_project_directory, terminal_history_dir, terminal_history_path_in};

impl Shell {
    pub(super) fn next_terminal_directory(&self, cx: &gpui::App) -> Option<PathBuf> {
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
    pub(in crate::shell) fn open_terminal_at(
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
                    ..
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
            let PaneKind::Terminal { terminal_id, link: None, .. } = &tab.kind else {
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

    /// `$EDITOR file` in a new terminal tab (the viewer's "Terminal ($EDITOR)").
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
            hooks: Default::default(),
        };
        self.new_terminal(Some(spec), window, cx);
    }

    /// Opens `path` in the selected editor target (GUI app, terminal `$EDITOR`, or macOS Default App).
    pub fn open_in_editor_target(&mut self, path: &Path, target: crate::host::EditorTarget, window: &mut Window, cx: &mut Context<Self>) {
        match target {
            crate::host::EditorTarget::TerminalEditor => self.open_in_editor(path, window, cx),
            crate::host::EditorTarget::DefaultApp => {
                let path = path.to_path_buf();
                Self::bg(
                    cx,
                    move || crate::host::open(&path),
                    |_, result, _| {
                        if let Err(err) = result {
                            tracing::warn!(error = %err, "failed to open file in default app");
                        }
                    },
                );
            }
            crate::host::EditorTarget::Cursor { app_path } | crate::host::EditorTarget::VsCode { app_path } | crate::host::EditorTarget::Zed { app_path } => {
                let path = path.to_path_buf();
                Self::bg(
                    cx,
                    move || crate::host::open_with_app(&app_path, &path),
                    |_, result, _| {
                        if let Err(err) = result {
                            tracing::warn!(error = %err, "failed to open file in external editor");
                        }
                    },
                );
            }
        }
    }

    pub(super) fn make_terminal(&mut self, id: &str, mut spec: SpawnSpec, window: &mut Window, cx: &mut Context<Self>) -> TerminalSlot {
        if spec.project_root.is_none() {
            spec.project_root = self.workspace.ws.active().map(|p| p.root().to_path_buf());
        }
        let owner_project = self
            .workspace
            .ws
            .projects()
            .iter()
            .find(|p| p.layout.terminal_ids().iter().any(|tid| tid == id))
            .or_else(|| self.workspace.ws.active());
        let workspace_root = spec.project_root.as_deref().or_else(|| owner_project.map(|p| p.root()));
        let tab_overrides = owner_project.and_then(|p| p.layout.terminal_hook_overrides(id)).cloned().unwrap_or_default();
        let resolved_hooks = self.workspace.terminal_hooks.resolve_for_tab(workspace_root, &tab_overrides);
        if !resolved_hooks.is_empty() {
            resolved_hooks.apply_to_spawn_env(&mut spec.env);
        }
        spec.hooks = resolved_hooks;
        let history_dir = terminal_history_dir();
        vibevalley_terminal::history::configure_env(&mut spec.env, &history_dir.join("zdotdir"), &terminal_history_path_in(&history_dir, id));
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
}
