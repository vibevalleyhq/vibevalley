use std::path::{Path, PathBuf};

use gpui::{AppContext as _, Context, Focusable, Window};
use serde_json::{Value, json};
use vibevalley_git::Repo;
use vibevalley_workspace::{Axis, PaneKind, ProjectId, TabId};

use crate::diff::DiffView;
use crate::hosted::HostedView;
use crate::panes::PaneEntity;
use crate::terminal::{SpawnSpec, TerminalEvent, TerminalView};
use crate::theme::Ui;
use crate::viewer::FileViewer;

use super::{PaneSlot, PixelSlot, Shell, TerminalSlot};

impl Shell {
    pub(super) fn navigate_workbench(&mut self, route: &str, cx: &mut Context<Self>) {
        self.native_workspace = false;
        self.native_pixel = None;
        self.workbench.update(cx, |v, cx| v.navigate(route, cx));
        cx.notify();
    }

    pub(super) fn show_workspace(&mut self, cx: &mut Context<Self>) {
        self.native_workspace = true;
        self.native_pixel = None;
        self.workbench.update(cx, |v, cx| v.navigate("/workspace", cx));
        cx.notify();
    }

    pub(super) fn show_pixel(&mut self, scene: &str, mut props: Value, window: &mut Window, cx: &mut Context<Self>) {
        if props.get("cwd").is_none() {
            props["cwd"] = json!(self.ws.active().map(|p| p.root().to_path_buf()));
        }
        let view = cx.new(|cx| crate::pixel::view::PixelView::new(scene, props, cx));
        let sub = cx.subscribe_in(&view, window, |this, _, event: &crate::pixel::view::PixelEvent, window, cx| {
            this.on_pixel_event(event.clone(), window, cx)
        });
        self.native_workspace = false;
        self.native_pixel = Some(PixelSlot { view, _sub: sub });
        cx.notify();
    }

    pub fn open_pane(&mut self, kind: PaneKind, window: &mut Window, cx: &mut Context<Self>) {
        if let PaneKind::Hosted { module, props } = &kind
            && (module == "vv" || module == "vibevalley")
        {
            self.native_workspace = false;
            self.native_pixel = None;
            self.workbench.update(cx, |v, cx| v.navigate(props["route"].as_str().unwrap_or("/issues"), cx));
            cx.notify();
            return;
        }
        if let PaneKind::Pixel { scene, props } = kind {
            self.show_pixel(&scene, props, window, cx);
            return;
        }
        self.show_workspace(cx);
        self.with_workspace_project(window, cx, move |s, id, w, cx| {
            if let Ok(id) = id
                && let Some(project) = s.ws.project_mut(id)
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
            let Some(project) = s.ws.project_mut(pid) else { return };
            let tab = project.layout.open(PaneKind::File { path: path.clone() });
            if let Some(pv) = s.projects.get_mut(&pid) {
                pv.tree.selected = Some(path);
            }
            s.ensure_panes(window, cx);
            if let (Some(line), Some(PaneEntity::File(v))) = (line, s.panes.get(&(pid, tab)).map(|s| &s.entity)) {
                v.update(cx, |v, cx| v.scroll_to_line(line, cx));
            }
            s.push_sidebar(cx);
            s.layout_changed(window, cx);
        });
    }

    fn next_terminal_directory(&self, cx: &gpui::App) -> Option<PathBuf> {
        let project = self.ws.active()?;
        match project.layout.active_tab().map(|t| &t.kind) {
            Some(PaneKind::Terminal { terminal_id, .. }) => {
                if let Some(slot) = self.terminals.get(terminal_id) {
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
        self.chat_menu_group = None;
        self.show_workspace(cx);
        self.with_workspace_project(window, cx, move |s, id, window, cx| {
            let Ok(id) = id else { return };
            let cwd = s.next_terminal_directory(cx).or_else(|| s.ws.project(id).map(|p| p.root().to_path_buf()));
            let Some(cwd) = cwd else { return };
            let Some(project) = s.ws.project_mut(id) else { return };
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
        self.chat_menu_group = None;
        if cwd.as_os_str().is_empty() {
            return self.new_chat(runtime, window, cx);
        }
        let Some(directory) = cwd.canonicalize().ok().filter(|p| p.is_dir()) else {
            let reason = format!("{} {}", vibevalley_i18n::t("desktop.terminal.missingFolder", &[]), cwd.display());
            self.terminal_notice = Some(reason);
            cx.notify();
            return;
        };
        let repo = Repo::discover(&directory).ok().flatten();
        let root = repo.as_ref().map(|r| r.root()).unwrap_or(&directory);
        let target = self
            .ws
            .projects()
            .iter()
            .filter_map(|p| {
                let path = p.root().canonicalize().ok()?;
                (path == root || (repo.is_none() && directory.starts_with(&path))).then(|| (path.components().count(), p.root().to_owned()))
            })
            .max_by_key(|(depth, _)| *depth)
            .map(|(_, path)| path)
            .unwrap_or_else(|| root.to_owned());
        self.with_project_at(target, window, cx, move |s, id, window, cx| {
            let Ok(id) = id else { return };
            s.ws.activate(id);
            s.show_workspace(cx);
            let Some(project) = s.ws.project_mut(id) else { return };
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

    pub fn open_file_adjacent(&mut self, path: PathBuf, line: Option<u32>, window: &mut Window, cx: &mut Context<Self>) {
        self.show_workspace(cx);
        self.with_workspace_project(window, cx, move |s, id, window, cx| {
            let Ok(pid) = id else { return };
            let Some(project) = s.ws.project_mut(pid) else { return };
            let resolved = if path.is_absolute() { path } else { project.root().join(path) };
            let tab = project.layout.open_adjacent(PaneKind::File { path: resolved.clone() });
            if let Some(pv) = s.projects.get_mut(&pid) {
                pv.tree.selected = Some(resolved);
            }
            s.ensure_panes(window, cx);
            if let (Some(line), Some(PaneEntity::File(v))) = (line, s.panes.get(&(pid, tab)).map(|slot| &slot.entity)) {
                v.update(cx, |v, cx| v.scroll_to_line(line, cx));
            }
            s.push_sidebar(cx);
            s.layout_changed(window, cx);
        });
    }

    pub fn open_diff_adjacent(&mut self, path: Option<PathBuf>, staged: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.show_workspace(cx);
        self.with_workspace_project(window, cx, move |s, id, window, cx| {
            let Ok(pid) = id else { return };
            let Some(project) = s.ws.project_mut(pid) else { return };
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

    #[allow(clippy::too_many_arguments)]
    pub(super) fn update_chat_tab(
        &mut self,
        tab_id: TabId,
        session_id: Option<String>,
        runtime: Option<String>,
        title: Option<String>,
        status: Option<String>,
        attention: Option<bool>,
        cx: &mut Context<Self>,
    ) {
        let mut target_pid = None;
        let mut layout_dirty = false;
        let ids: Vec<ProjectId> = self.ws.projects().iter().map(|p| p.id()).collect();
        for pid in ids {
            let Some(project) = self.ws.project_mut(pid) else { continue };
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
            if let Some(sid) = session_id.filter(|s| !s.is_empty())
                && *cur_sid != sid
            {
                *cur_sid = sid;
                layout_dirty = true;
            }
            if let Some(rt) = runtime.filter(|r| !r.is_empty())
                && *cur_rt != rt
            {
                *cur_rt = rt;
                layout_dirty = true;
            }
            if let Some(t) = title.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty())
                && cur_title.as_deref() != Some(t.as_str())
            {
                *cur_title = Some(t);
                layout_dirty = true;
            }
            break;
        }
        if let Some(pid) = target_pid {
            let entry = self.chat_statuses.entry((pid, tab_id)).or_default();
            if let Some(st) = status {
                entry.status = st;
            }
            if let Some(att) = attention {
                entry.attention = att;
            }
            if layout_dirty {
                self.schedule_save(cx);
            }
            self.push_sidebar(cx);
            cx.notify();
        }
    }

    pub fn new_terminal(&mut self, spec: Option<SpawnSpec>, window: &mut Window, cx: &mut Context<Self>) {
        self.show_workspace(cx);
        self.with_workspace_project(window, cx, move |s, id, window, cx| {
            let Some(spec) = spec.or_else(|| s.next_terminal_directory(cx).map(SpawnSpec::shell)) else {
                return;
            };
            let Ok(id) = id else { return };
            let Some(project) = s.ws.project_mut(id) else { return };
            let (id, _) = project.new_terminal_tab();
            let slot = s.make_terminal(&id, spec, window, cx);
            s.terminals.insert(id, slot);
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
                    let cwd = s.ws.project(id).expect("loaded project").root().to_owned();
                    s.terminal_in_active_project(cwd, title, command, w, cx)
                });
                done(result);
            });
        }
        let Some(directory) = cwd.canonicalize().ok().filter(|p| p.is_dir()) else {
            let reason = format!("{} {}", vibevalley_i18n::t("desktop.terminal.missingFolder", &[]), cwd.display());
            self.terminal_notice = Some(reason.clone());
            cx.notify();
            return done(Err(reason));
        };
        let repo = Repo::discover(&directory).ok().flatten();
        let root = repo.as_ref().map(|r| r.root()).unwrap_or(&directory);
        let target = self
            .ws
            .projects()
            .iter()
            .filter_map(|p| {
                let path = p.root().canonicalize().ok()?;
                (path == root || (repo.is_none() && directory.starts_with(&path))).then(|| (path.components().count(), p.root().to_owned()))
            })
            .max_by_key(|(depth, _)| *depth)
            .map(|(_, path)| path)
            .unwrap_or_else(|| root.to_owned());
        self.with_project_at(target, window, cx, move |s, id, window, cx| {
            let result = id.and_then(|id| {
                s.ws.activate(id);
                s.show_workspace(cx);
                s.terminal_in_active_project(directory, title, command, window, cx)
            });
            if let Err(reason) = &result {
                s.terminal_notice = Some(reason.clone());
                cx.notify();
            }
            done(result);
        });
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
        self.terminal_notice = None;
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
        let project = self.ws.active_mut().ok_or_else(no_project)?;
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
                let in_directory = match self.terminals.get(terminal_id) {
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
            (project.saved_terminal(terminal_id).is_none() && !self.terminals.contains_key(terminal_id)).then(|| (terminal_id.clone(), tab.id))
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
        self.terminals.insert(id.clone(), slot);
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
            project_root: self.ws.active().map(|p| p.root().to_path_buf()),
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
        let Some(project) = self.ws.active_mut() else { return };
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
        self.terminals.insert(id, slot);
        self.layout_changed(window, cx);
    }

    pub(super) fn close_active_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(project) = self.ws.active_mut() else { return };
        let Some(tab) = project.layout.active_tab().map(|t| t.id) else { return };
        self.close_tab(tab, window, cx);
    }

    pub fn close_tab(&mut self, tab: TabId, window: &mut Window, cx: &mut Context<Self>) {
        let Some(project) = self.ws.active_mut() else { return };
        let pid = project.id();
        if let Some(PaneKind::Terminal { terminal_id, .. }) = project.close_tab(tab) {
            self.terminals.remove(&terminal_id);
        }
        self.panes.remove(&(pid, tab));
        self.chat_statuses.remove(&(pid, tab));
        if self.ws.active().is_some_and(|p| p.layout.tabs().next().is_none()) {
            self.new_terminal(None, window, cx);
            return;
        }
        self.layout_changed(window, cx);
    }

    pub fn layout_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.ensure_panes(window, cx);
        self.focus_active_pane(window, cx);
        self.schedule_save(cx);
        self.push_sidebar(cx);
        cx.notify();
    }

    pub fn focus_active_pane(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.ensure_panes(window, cx);
        let Some(project) = self.ws.active() else { return };
        let Some(tab) = project.layout.active_tab() else { return };
        let handle = match &tab.kind {
            PaneKind::Terminal { terminal_id, .. } => self.terminals.get(terminal_id).map(|t| t.view.read(cx).focus_handle(cx)),
            _ => self.panes.get(&(project.id(), tab.id)).map(|p| p.entity.focus_handle(cx)),
        };
        window.focus(&handle.unwrap_or_else(|| self.focus.clone()), cx);
    }

    /// Creates the entities for every visible tab of the active project.
    /// Entities of hidden projects stay alive in the maps.
    pub fn ensure_panes(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(pid) = self.ws.active_id() else { return };
        let Some(project) = self.ws.active() else { return };
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
                    if self.terminals.contains_key(&terminal_id) {
                        continue;
                    }
                    let saved = self.ws.active_mut().and_then(|p| p.take_restorable(&terminal_id));
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
                    self.terminals.insert(terminal_id, slot);
                }
                kind => {
                    if self.panes.contains_key(&(pid, tab)) {
                        continue;
                    }
                    let pane = self.make_pane(pid, tab, &root, kind, window, cx);
                    self.panes.insert((pid, tab), pane);
                }
            }
        }
    }

    fn make_terminal(&mut self, id: &str, mut spec: SpawnSpec, window: &mut Window, cx: &mut Context<Self>) -> TerminalSlot {
        if spec.project_root.is_none() {
            spec.project_root = self.ws.active().map(|p| p.root().to_path_buf());
        }
        let cwd = spec.cwd.clone();
        let initial_title = spec.title.clone();
        let view = cx.new(|cx| TerminalView::new(spec, cx));
        let tid = id.to_string();
        let sub = cx.subscribe_in(&view, window, move |this: &mut Shell, view, event: &TerminalEvent, window, cx| {
            let owner = this.ws.projects().iter().find(|p| p.layout.terminal_ids().contains(&tid)).map(|p| p.id());
            let Some(owner) = owner else { return };
            let on_screen = this.ws.active_id() == Some(owner);
            match event {
                TerminalEvent::OpenLink(target) => {
                    this.open_terminal_link(target.clone(), owner, window, cx);
                    return;
                }
                TerminalEvent::Spawned => {
                    if let Some(session) = view.read(cx).session()
                        && let Some(project) = this.ws.project_mut(owner)
                    {
                        project.attach_terminal(&tid, session.clone(), cwd.clone(), initial_title.clone());
                    }
                }
                TerminalEvent::TitleChanged => {
                    let title = view.read(cx).title().map(str::to_string);
                    if let Some(project) = this.ws.project_mut(owner)
                        && let Some(entry) = project.terminal_mut(&tid)
                    {
                        entry.title = title;
                    }
                }
                TerminalEvent::Bell | TerminalEvent::CommandFinished => {
                    if !on_screen
                        && let Some(project) = this.ws.project_mut(owner)
                        && let Some(entry) = project.terminal_mut(&tid)
                    {
                        entry.attention = true;
                    }
                }
                TerminalEvent::AgentTurnFinished { agent, label } => {
                    if !on_screen
                        && let Some(project) = this.ws.project_mut(owner)
                        && let Some(entry) = project.terminal_mut(&tid)
                    {
                        entry.attention = true;
                    }
                    if !crate::host::is_app_active() {
                        let title = this
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
                    if let Some(project) = this.ws.project_mut(owner)
                        && let Some(entry) = project.terminal_mut(&tid)
                    {
                        entry.exited = true;
                    }
                }
                TerminalEvent::SpawnFailed(e) => eprintln!("terminal {tid}: {e}"),
            }
            this.push_sidebar(cx);
            cx.notify();
        });
        TerminalSlot { view, _sub: sub }
    }

    fn open_terminal_link(&mut self, target: vibevalley_terminal::LinkTarget, owner: ProjectId, window: &mut Window, cx: &mut Context<Self>) {
        match target {
            vibevalley_terminal::LinkTarget::Url(url) => cx.open_url(&url),
            vibevalley_terminal::LinkTarget::File { path, line, col: _ } => {
                let project_root = self.ws.project(owner).or_else(|| self.ws.active()).map(|p| p.root().to_path_buf());
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
                let sub = self.subscribe_hosted(&view, None, window, cx);
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
            PaneKind::Hosted { module, props } => {
                let mut params = props.as_object().cloned().unwrap_or_default();
                params.insert("module".into(), json!(module));
                let doc = (module == "markdown").then(|| props["path"].as_str().map(PathBuf::from)).flatten();
                let view = cx.new(|cx| HostedView::new(&module, params, dark, window, cx));
                let sub = self.subscribe_hosted(&view, doc, window, cx);
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
            PaneKind::Terminal { .. } => unreachable!("terminals are kept in Shell::terminals"),
        }
    }
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

/// `%XX` escapes of a `file:` URL's path decoded (spaces, CJK names).
pub(super) fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(hex) = s.get(i + 1..i + 3)
            && let Ok(b) = u8::from_str_radix(hex, 16)
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod url_tests {
    #[test]
    fn file_urls_decode() {
        assert_eq!(super::percent_decode("/tmp/%E6%88%AA%E5%9B%BE%201.png"), "/tmp/截图 1.png");
        assert_eq!(super::percent_decode("/a%zzb%"), "/a%zzb%");
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
}
