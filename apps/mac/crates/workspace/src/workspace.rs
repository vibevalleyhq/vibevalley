//! Open projects and the registry that keeps their terminal sessions alive
//! while another project is on screen. Pure state: nothing here blocks. The
//! blocking halves (`load_*`, `SaveJob::run`) are separate functions meant for
//! background threads.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::store::{Project, ProjectId, SavedTerminal};

use crate::layout::{Layout, PaneKind};
use crate::persist::Persistence;
use crate::util::new_id;

/// Total budget for shutting down all live terminal sessions concurrently on quit.
pub const SHUTDOWN_BUDGET: std::time::Duration = std::time::Duration::from_secs(3);

/// What the registry needs from a live terminal. Implemented for
/// `vibevalley_terminal::TermSession`.
pub trait TerminalHandle: Clone + Send + 'static {
    fn cwd(&self) -> Option<PathBuf>;
    /// Blocking round-trip.
    fn scrollback_text(&self, max_lines: usize) -> String;
    fn is_alive(&self) -> bool;
    fn kill(&self);
    /// Initiates graceful shutdown without blocking.
    fn begin_shutdown(&self) {
        self.kill();
    }
    fn shutdown_and_wait(&self) {
        self.kill();
    }
    fn shutdown_and_wait_with_timeout(&self, timeout: std::time::Duration) {
        let _ = timeout;
        self.shutdown_and_wait();
    }
}

impl TerminalHandle for vibevalley_terminal::TermSession {
    fn cwd(&self) -> Option<PathBuf> {
        self.local_cwd().or_else(|| vibevalley_terminal::TermSession::cwd(self))
    }
    fn scrollback_text(&self, max_lines: usize) -> String {
        vibevalley_terminal::TermSession::scrollback_text(self, max_lines)
    }
    fn is_alive(&self) -> bool {
        vibevalley_terminal::TermSession::is_alive(self)
    }
    fn kill(&self) {
        vibevalley_terminal::TermSession::kill(self)
    }
    fn begin_shutdown(&self) {
        vibevalley_terminal::TermSession::begin_shutdown(self)
    }
    fn shutdown_and_wait(&self) {
        vibevalley_terminal::TermSession::shutdown_and_wait(self, SHUTDOWN_BUDGET)
    }
    fn shutdown_and_wait_with_timeout(&self, timeout: std::time::Duration) {
        let _ = vibevalley_terminal::TermSession::wait_shutdown(self, timeout);
    }
}

pub const SAVED_SCROLLBACK_LINES: usize = 2000;

#[derive(Debug, Clone)]
pub struct TerminalEntry<T> {
    pub id: String,
    pub handle: T,
    pub title: Option<String>,
    /// Where it was started; the live cwd comes from the handle.
    pub initial_cwd: PathBuf,
    /// Rang the bell (or finished a command) while not on screen.
    pub attention: bool,
    pub exited: bool,
}

/// Everything read from the store to open one project.
#[derive(Debug, Clone)]
pub struct LoadedProject {
    pub info: Project,
    pub layout: Option<serde_json::Value>,
    pub terminals: Vec<SavedTerminal>,
}

/// Blocking. Registers `path` (or finds it) and reads its saved state.
pub fn load_project(store: &dyn Persistence, path: &Path) -> crate::store::Result<LoadedProject> {
    let info = store.add_project(path)?;
    load_existing(store, info)
}

/// Blocking. Reads every stored project, in rail order.
pub fn load_all(store: &dyn Persistence) -> crate::store::Result<Vec<LoadedProject>> {
    let mut projects = store.projects()?;
    projects.sort_by_key(|p| p.position);
    projects.into_iter().map(|info| load_existing(store, info)).collect()
}

/// Blocking. Drops stored projects whose directory no longer exists on disk
/// (such as removed git worktrees) and deletes their stale rows from the store.
pub fn prune_missing_projects(store: &dyn Persistence, projects: Vec<LoadedProject>) -> Vec<LoadedProject> {
    let mut kept = Vec::with_capacity(projects.len());
    for project in projects {
        if project.info.path.is_dir() {
            kept.push(project);
        } else {
            let _ = store.remove_project(project.info.id);
        }
    }
    kept
}

fn load_existing(store: &dyn Persistence, info: Project) -> crate::store::Result<LoadedProject> {
    let layout = store.layout(info.id)?;
    let terminals = store.terminals(info.id)?;
    Ok(LoadedProject { info, layout, terminals })
}

pub struct OpenProject<T> {
    pub info: Project,
    pub layout: Layout,
    terminals: BTreeMap<String, TerminalEntry<T>>,
    /// Saved terminals not yet respawned. Sessions start lazily, the first
    /// time their pane is shown, so opening the app does not fork a shell
    /// for every tab of every project.
    restorable: BTreeMap<String, SavedTerminal>,
}

impl<T: TerminalHandle> OpenProject<T> {
    pub fn from_loaded(loaded: LoadedProject) -> Self {
        let mut layout = loaded.layout.as_ref().and_then(Layout::from_json).unwrap_or_default();
        let mut restorable: BTreeMap<String, SavedTerminal> = loaded.terminals.into_iter().map(|t| (t.id.clone(), t)).collect();
        let referenced = layout.terminal_ids();
        restorable.retain(|id, _| referenced.contains(id));
        if layout.tabs().next().is_none() {
            layout.add_tab(
                None,
                PaneKind::Terminal {
                    terminal_id: new_id(),
                    link: None,
                    hooks: Default::default(),
                },
            );
        }
        OpenProject {
            info: loaded.info,
            layout,
            terminals: BTreeMap::new(),
            restorable,
        }
    }

    pub fn id(&self) -> ProjectId {
        self.info.id
    }

    pub fn root(&self) -> &Path {
        &self.info.path
    }

    /// Adds a terminal tab; the session itself is attached once spawned.
    pub fn new_terminal_tab(&mut self) -> (String, crate::layout::TabId) {
        let id = new_id();
        let tab = self.layout.add_tab(
            None,
            PaneKind::Terminal {
                terminal_id: id.clone(),
                link: None,
                hooks: Default::default(),
            },
        );
        (id, tab)
    }

    pub fn terminal(&self, id: &str) -> Option<&TerminalEntry<T>> {
        self.terminals.get(id)
    }

    pub fn terminal_mut(&mut self, id: &str) -> Option<&mut TerminalEntry<T>> {
        self.terminals.get_mut(id)
    }

    pub fn terminals(&self) -> impl Iterator<Item = &TerminalEntry<T>> {
        self.terminals.values()
    }

    pub fn saved_terminal(&self, id: &str) -> Option<&SavedTerminal> {
        self.restorable.get(id)
    }

    /// Saved state for a terminal that has not been respawned yet. Taking it
    /// hands responsibility for the session to the caller.
    pub fn take_restorable(&mut self, id: &str) -> Option<SavedTerminal> {
        self.restorable.remove(id)
    }

    pub fn attach_terminal(&mut self, id: &str, handle: T, cwd: PathBuf, title: Option<String>) {
        self.restorable.remove(id);
        let entry = TerminalEntry {
            id: id.to_string(),
            handle,
            title,
            initial_cwd: cwd,
            attention: false,
            exited: false,
        };
        if let Some(old) = self.terminals.insert(id.to_string(), entry) {
            old.handle.kill();
        }
    }

    /// Kills and forgets a session (its tab was closed).
    pub fn drop_terminal(&mut self, id: &str) {
        self.restorable.remove(id);
        if let Some(entry) = self.terminals.remove(id) {
            entry.handle.kill();
        }
    }

    /// Closes a tab and releases whatever session it owned.
    pub fn close_tab(&mut self, tab: crate::layout::TabId) -> Option<PaneKind> {
        let kind = self.layout.close_tab(tab)?;
        if let PaneKind::Terminal { terminal_id, .. } = &kind {
            self.drop_terminal(terminal_id);
        }
        Some(kind)
    }

    pub fn needs_attention(&self) -> bool {
        self.terminals.values().any(|t| t.attention)
    }

    pub fn live_terminals(&self) -> usize {
        self.terminals.values().filter(|t| !t.exited).count()
    }

    /// Captures what must be written to the store. Cheap; run the job on a
    /// background thread.
    pub fn save_job(&self) -> SaveJob<T> {
        let referenced = self.layout.terminal_ids();
        SaveJob {
            project: self.info.id,
            layout: self.layout.to_json(),
            live: self
                .terminals
                .values()
                .filter(|t| referenced.contains(&t.id))
                .map(|t| (t.id.clone(), t.title.clone(), t.initial_cwd.clone(), t.handle.clone()))
                .collect(),
            dormant: self.restorable.values().filter(|t| referenced.contains(&t.id)).cloned().collect(),
        }
    }

    fn into_handles(self) -> Vec<T> {
        self.terminals.into_values().map(|t| t.handle).collect()
    }
}

pub struct SaveJob<T> {
    pub project: ProjectId,
    layout: serde_json::Value,
    live: Vec<(String, Option<String>, PathBuf, T)>,
    /// Never respawned this run; written back unchanged.
    dormant: Vec<SavedTerminal>,
}

impl<T: TerminalHandle> SaveJob<T> {
    /// Blocking: asks each session for its scrollback, then writes.
    pub fn run(self, store: &dyn Persistence) -> crate::store::Result<()> {
        let mut saved = self.dormant;
        for (id, title, initial_cwd, handle) in self.live {
            saved.push(SavedTerminal {
                id,
                project_id: self.project,
                cwd: handle.cwd().unwrap_or(initial_cwd),
                title,
                scrollback: handle.scrollback_text(SAVED_SCROLLBACK_LINES),
            });
        }
        store.set_layout(self.project, &self.layout)?;
        store.set_terminals(self.project, &saved)
    }
}

pub struct Workspace<T> {
    projects: Vec<OpenProject<T>>,
    active: Option<ProjectId>,
}

impl<T: TerminalHandle> Default for Workspace<T> {
    fn default() -> Self {
        Workspace {
            projects: Vec::new(),
            active: None,
        }
    }
}

impl<T: TerminalHandle> Workspace<T> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn projects(&self) -> &[OpenProject<T>] {
        &self.projects
    }

    pub fn project(&self, id: ProjectId) -> Option<&OpenProject<T>> {
        self.projects.iter().find(|p| p.info.id == id)
    }

    pub fn project_mut(&mut self, id: ProjectId) -> Option<&mut OpenProject<T>> {
        self.projects.iter_mut().find(|p| p.info.id == id)
    }

    pub fn active_id(&self) -> Option<ProjectId> {
        self.active
    }

    pub fn active(&self) -> Option<&OpenProject<T>> {
        self.active.and_then(|id| self.project(id))
    }

    pub fn active_mut(&mut self) -> Option<&mut OpenProject<T>> {
        self.active.and_then(|id| self.project_mut(id))
    }

    /// Adds a project to the rail (or returns the already-open one). The
    /// first project opened becomes active.
    pub fn open(&mut self, loaded: LoadedProject) -> ProjectId {
        let id = loaded.info.id;
        if self.project(id).is_none() {
            self.projects.push(OpenProject::from_loaded(loaded));
        }
        if self.active.is_none() {
            self.active = Some(id);
        }
        id
    }

    /// Switches the visible project. Sessions of the previous one keep running.
    pub fn activate(&mut self, id: ProjectId) -> bool {
        let found = self.project(id).is_some();
        if found {
            self.active = Some(id);
        }
        found
    }

    /// Cmd+1…9: `index` is zero-based rail position.
    pub fn activate_index(&mut self, index: usize) -> Option<ProjectId> {
        let id = self.projects.get(index)?.info.id;
        self.active = Some(id);
        Some(id)
    }

    /// Removes a project from the rail and kills its terminals. Returns the
    /// final save job so the caller can persist the state it had.
    pub fn close(&mut self, id: ProjectId) -> Option<SaveJob<T>> {
        let index = self.projects.iter().position(|p| p.info.id == id)?;
        let project = self.projects.remove(index);
        let job = project.save_job();
        if self.active == Some(id) {
            self.active = self.projects.get(index.saturating_sub(1)).or(self.projects.first()).map(|p| p.info.id);
        }
        for handle in project.into_handles() {
            handle.kill();
        }
        Some(job)
    }

    pub fn reorder(&mut self, id: ProjectId, to_index: usize) -> Vec<ProjectId> {
        if let Some(from) = self.projects.iter().position(|p| p.info.id == id) {
            let project = self.projects.remove(from);
            let to = to_index.min(self.projects.len());
            self.projects.insert(to, project);
        }
        self.projects.iter().map(|p| p.info.id).collect()
    }

    pub fn save_jobs(&self) -> Vec<SaveJob<T>> {
        self.projects.iter().map(|p| p.save_job()).collect()
    }

    pub fn kill_all(&mut self) {
        for project in &mut self.projects {
            for entry in project.terminals.values() {
                entry.handle.kill();
            }
        }
    }

    pub fn shutdown_all_and_wait(&mut self) {
        let handles: Vec<T> = self
            .projects
            .iter_mut()
            .flat_map(|project| std::mem::take(&mut project.terminals).into_values().map(|entry| entry.handle))
            .collect();
        if handles.is_empty() {
            return;
        }
        for handle in &handles {
            handle.begin_shutdown();
        }
        let deadline = std::time::Instant::now() + SHUTDOWN_BUDGET;
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let total = handles.len();
        for handle in handles {
            let tx = done_tx.clone();
            std::thread::spawn(move || {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                handle.shutdown_and_wait_with_timeout(remaining);
                let _ = tx.send(());
            });
        }
        drop(done_tx);
        for _ in 0..total {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() || done_rx.recv_timeout(remaining).is_err() {
                break;
            }
        }
    }
}

/// How to start the shell for a restored terminal so that its old output is
/// visible above the new prompt.
///
/// `TermSession` has no way to pre-fill scrollback, so the saved text is
/// written to a file that the spawned command prints before exec-ing the
/// login shell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreCommand {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
}

/// Blocking (writes one small file under `scratch_dir`).
pub fn restore_command(saved: &SavedTerminal, scratch_dir: &Path, shell: &str) -> std::io::Result<Option<RestoreCommand>> {
    let text = saved.scrollback.trim_end();
    if text.is_empty() {
        return Ok(None);
    }
    std::fs::create_dir_all(scratch_dir)?;
    let file = scratch_dir.join(format!("{}.restore", saved.id));
    std::fs::write(&file, format!("{text}\n"))?;
    let script = r#"cat "$1"; rm -f "$1"; printf '\033[2m── restored ──\033[0m\n'; exec "$2" -l"#;
    Ok(Some(RestoreCommand {
        program: "/bin/sh".into(),
        args: vec![
            "-c".into(),
            script.into(),
            "vibevalley-restore".into(),
            file.to_string_lossy().into_owned(),
            shell.into(),
        ],
        cwd: if saved.cwd.is_dir() { saved.cwd.clone() } else { PathBuf::from("/") },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{FakeTerm, MemStore};

    fn open(store: &MemStore, ws: &mut Workspace<FakeTerm>, path: &str) -> ProjectId {
        ws.open(load_project(store, Path::new(path)).unwrap())
    }

    fn first_terminal<T: TerminalHandle>(ws: &Workspace<T>, id: ProjectId) -> String {
        ws.project(id).unwrap().layout.terminal_ids()[0].clone()
    }

    #[test]
    fn a_new_project_starts_with_one_terminal_tab_and_becomes_active() {
        let store = MemStore::default();
        let mut ws = Workspace::new();
        let a = open(&store, &mut ws, "/code/alpha");
        assert_eq!(ws.active_id(), Some(a));
        assert_eq!(ws.active().unwrap().layout.terminal_ids().len(), 1);
        assert_eq!(open(&store, &mut ws, "/code/alpha"), a, "opening twice does not duplicate");
        assert_eq!(ws.projects().len(), 1);
    }

    #[test]
    fn switching_projects_keeps_every_session_alive() {
        let store = MemStore::default();
        let mut ws = Workspace::new();
        let a = open(&store, &mut ws, "/code/alpha");
        let b = open(&store, &mut ws, "/code/beta");
        let term_a = FakeTerm::new("/code/alpha", "");
        let term_b = FakeTerm::new("/code/beta", "");
        let (ta, tb) = (first_terminal(&ws, a), first_terminal(&ws, b));
        ws.project_mut(a).unwrap().attach_terminal(&ta, term_a.clone(), "/code/alpha".into(), None);
        ws.project_mut(b).unwrap().attach_terminal(&tb, term_b.clone(), "/code/beta".into(), None);

        assert!(ws.activate(b));
        assert_eq!(ws.activate_index(0), Some(a));
        assert_eq!(ws.activate_index(7), None);
        assert_eq!(ws.active_id(), Some(a));
        assert!(!ws.activate(999));
        assert!(!term_a.was_killed() && !term_b.was_killed());
        assert!(ws.project(b).unwrap().terminal(&tb).is_some());
        assert_eq!(ws.project(b).unwrap().live_terminals(), 1);
    }

    #[test]
    fn closing_a_tab_kills_only_its_session() {
        let store = MemStore::default();
        let mut ws = Workspace::new();
        let a = open(&store, &mut ws, "/code/alpha");
        let project = ws.project_mut(a).unwrap();
        let first = project.layout.terminal_ids()[0].clone();
        let (second, tab) = project.new_terminal_tab();
        let (t1, t2) = (FakeTerm::default(), FakeTerm::default());
        project.attach_terminal(&first, t1.clone(), "/".into(), None);
        project.attach_terminal(&second, t2.clone(), "/".into(), None);
        project.close_tab(tab);
        assert!(t2.was_killed() && !t1.was_killed());
        assert!(project.terminal(&second).is_none());
    }

    #[test]
    fn closing_a_project_kills_its_sessions_and_activates_a_neighbour() {
        let store = MemStore::default();
        let mut ws = Workspace::new();
        let a = open(&store, &mut ws, "/code/alpha");
        let b = open(&store, &mut ws, "/code/beta");
        let term_b = FakeTerm::new("/code/beta/src", "$ ls\n");
        let tb = first_terminal(&ws, b);
        ws.project_mut(b).unwrap().attach_terminal(&tb, term_b.clone(), "/code/beta".into(), None);
        ws.activate(b);
        let job = ws.close(b).unwrap();
        assert!(term_b.was_killed());
        assert_eq!(ws.active_id(), Some(a));
        // The final state is still saved.
        job.run(&store).unwrap();
        assert_eq!(store.terminals.lock().unwrap()[&b][0].scrollback, "$ ls\n");
        assert!(ws.close(b).is_none());
    }

    #[test]
    fn save_and_restore_round_trip() {
        let store = MemStore::default();
        let mut ws = Workspace::new();
        let a = open(&store, &mut ws, "/code/alpha");
        let project = ws.project_mut(a).unwrap();
        let live = project.layout.terminal_ids()[0].clone();
        project.attach_terminal(
            &live,
            FakeTerm::new("/code/alpha/sub", "$ make\nok\n"),
            "/code/alpha".into(),
            Some("make".into()),
        );
        project.layout.open(PaneKind::File { path: "README.md".into() });
        let group = project.layout.focused;
        project
            .layout
            .split(group, crate::layout::Axis::Horizontal, PaneKind::File { path: "Cargo.toml".into() });
        let layout_before = project.layout.clone();
        for job in ws.save_jobs() {
            job.run(&store).unwrap();
        }

        let mut ws2: Workspace<FakeTerm> = Workspace::new();
        for loaded in load_all(&store).unwrap() {
            ws2.open(loaded);
        }
        let restored = ws2.project_mut(a).unwrap();
        assert_eq!(restored.layout, layout_before);
        assert!(restored.terminal(&live).is_none(), "sessions respawn lazily");
        let saved = restored.take_restorable(&live).unwrap();
        assert_eq!(saved.cwd, PathBuf::from("/code/alpha/sub"), "the live cwd wins over the initial one");
        assert_eq!(saved.scrollback, "$ make\nok\n");
        assert_eq!(saved.title.as_deref(), Some("make"));
        assert!(restored.take_restorable(&live).is_none());
    }

    #[test]
    fn terminals_never_shown_survive_a_second_save() {
        let store = MemStore::default();
        let mut ws = Workspace::new();
        let a = open(&store, &mut ws, "/code/alpha");
        let id = first_terminal(&ws, a);
        ws.project_mut(a)
            .unwrap()
            .attach_terminal(&id, FakeTerm::new("/x", "history\n"), "/x".into(), None);
        ws.save_jobs().into_iter().for_each(|j| j.run(&store).unwrap());

        // Second run: the project is opened but its terminal is never shown.
        let mut ws2: Workspace<FakeTerm> = Workspace::new();
        load_all(&store).unwrap().into_iter().for_each(|l| {
            ws2.open(l);
        });
        ws2.save_jobs().into_iter().for_each(|j| j.run(&store).unwrap());
        assert_eq!(store.terminals.lock().unwrap()[&a][0].scrollback, "history\n");
    }

    #[test]
    fn saved_terminals_without_a_tab_are_dropped() {
        let store = MemStore::default();
        let info = store.add_project(Path::new("/code/alpha")).unwrap();
        store
            .set_terminals(
                info.id,
                &[SavedTerminal {
                    id: "orphan".into(),
                    project_id: info.id,
                    cwd: "/".into(),
                    title: None,
                    scrollback: "x".into(),
                }],
            )
            .unwrap();
        let mut ws: Workspace<FakeTerm> = Workspace::new();
        let a = ws.open(load_project(&store, Path::new("/code/alpha")).unwrap());
        assert!(ws.project_mut(a).unwrap().take_restorable("orphan").is_none());
    }

    #[test]
    fn reorder_reports_the_new_rail_order() {
        let store = MemStore::default();
        let mut ws = Workspace::new();
        let a = open(&store, &mut ws, "/code/alpha");
        let b = open(&store, &mut ws, "/code/beta");
        let c = open(&store, &mut ws, "/code/gamma");
        assert_eq!(ws.reorder(c, 0), vec![c, a, b]);
        assert_eq!(ws.reorder(c, 99), vec![a, b, c]);
    }

    #[test]
    fn restore_command_prints_saved_output_then_execs_the_shell() {
        let dir = std::env::temp_dir().join(format!("vibevalley-ws-test-{}", new_id()));
        let saved = SavedTerminal {
            id: "t1".into(),
            project_id: 1,
            cwd: "/definitely/not/here".into(),
            title: None,
            scrollback: "$ echo hi\nhi\n\n\n".into(),
        };
        let cmd = restore_command(&saved, &dir, "/bin/zsh").unwrap().unwrap();
        assert_eq!(cmd.cwd, PathBuf::from("/"), "a vanished cwd falls back instead of failing the spawn");
        assert_eq!(std::fs::read_to_string(&cmd.args[3]).unwrap(), "$ echo hi\nhi\n");
        // Run the script with `true` standing in for the shell.
        let out = std::process::Command::new(&cmd.program)
            .args(&cmd.args[..4])
            .arg("/usr/bin/true")
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).starts_with("$ echo hi\nhi\n"));
        assert!(!Path::new(&cmd.args[3]).exists(), "the scratch file is removed");
        let empty = SavedTerminal {
            scrollback: "  \n".into(),
            ..saved
        };
        assert!(restore_command(&empty, &dir, "/bin/zsh").unwrap().is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn regression_prune_missing_projects_removes_deleted_directories_from_store() {
        let store = MemStore::default();
        let live_dir = std::env::temp_dir().join(format!("vibevalley-ws-live-{}", new_id()));
        std::fs::create_dir_all(&live_dir).unwrap();
        let gone_dir = std::env::temp_dir().join(format!("vibevalley-ws-gone-{}", new_id()));
        let _ = std::fs::remove_dir_all(&gone_dir);

        load_project(&store, &live_dir).unwrap();
        load_project(&store, &gone_dir).unwrap();

        let loaded = load_all(&store).unwrap();
        assert_eq!(loaded.len(), 2);

        let kept = prune_missing_projects(&store, loaded);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].info.path, live_dir);

        let stored = store.projects().unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].path, live_dir);

        let _ = std::fs::remove_dir_all(live_dir);
    }

    #[derive(Clone)]
    struct BarrierFakeTerm {
        gate: std::sync::Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
        barrier: Option<std::sync::Arc<std::sync::Barrier>>,
        wait_limit: std::time::Duration,
        begun: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        finished: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }

    impl TerminalHandle for BarrierFakeTerm {
        fn cwd(&self) -> Option<PathBuf> {
            None
        }
        fn scrollback_text(&self, _max_lines: usize) -> String {
            String::new()
        }
        fn is_alive(&self) -> bool {
            true
        }
        fn kill(&self) {}
        fn begin_shutdown(&self) {
            self.begun.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        fn shutdown_and_wait(&self) {
            if let Some(barrier) = &self.barrier {
                barrier.wait();
            }
            if !self.wait_limit.is_zero() {
                let (lock, cv) = &*self.gate;
                let guard = lock.lock().unwrap();
                let _ = cv.wait_timeout_while(guard, self.wait_limit, |released| !*released).unwrap();
            }
            self.finished.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    #[test]
    fn shutdown_all_and_wait_fans_out_concurrently_within_budget() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Barrier, Condvar, Mutex};
        use std::time::{Duration, Instant};

        let store = MemStore::default();
        let mut ws: Workspace<BarrierFakeTerm> = Workspace::new();
        let project_id = ws.open(load_project(&store, Path::new("/code/alpha")).unwrap());
        let begun = Arc::new(AtomicUsize::new(0));
        let finished = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        // A sequential shutdown_all_and_wait would deadlock on this 5-party barrier.
        let barrier = Arc::new(Barrier::new(5));

        for i in 0..5 {
            let id = if i == 0 {
                first_terminal(&ws, project_id)
            } else {
                ws.project_mut(project_id).unwrap().new_terminal_tab().0
            };
            ws.project_mut(project_id).unwrap().attach_terminal(
                &id,
                BarrierFakeTerm {
                    gate: gate.clone(),
                    barrier: Some(barrier.clone()),
                    wait_limit: Duration::from_millis(200),
                    begun: begun.clone(),
                    finished: finished.clone(),
                },
                "/code/alpha".into(),
                None,
            );
        }

        let start = Instant::now();
        ws.shutdown_all_and_wait();
        let elapsed = start.elapsed();

        assert_eq!(begun.load(Ordering::SeqCst), 5);
        assert_eq!(finished.load(Ordering::SeqCst), 5);
        assert!(
            elapsed < Duration::from_millis(1500),
            "5 tabs must execute concurrently within budget (took {elapsed:?})"
        );
    }

    #[test]
    fn shutdown_all_and_wait_bounds_hung_terminals_to_budget() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Condvar, Mutex};
        use std::time::{Duration, Instant};

        let store = MemStore::default();
        let mut ws: Workspace<BarrierFakeTerm> = Workspace::new();
        let project_id = ws.open(load_project(&store, Path::new("/code/beta")).unwrap());
        let begun = Arc::new(AtomicUsize::new(0));
        let finished = Arc::new(AtomicUsize::new(0));
        let fast_gate = Arc::new((Mutex::new(true), Condvar::new()));
        let stuck_gate = Arc::new((Mutex::new(false), Condvar::new()));
        let first = first_terminal(&ws, project_id);
        let (second, _) = ws.project_mut(project_id).unwrap().new_terminal_tab();

        ws.project_mut(project_id).unwrap().attach_terminal(
            &first,
            BarrierFakeTerm {
                gate: fast_gate,
                barrier: None,
                wait_limit: Duration::ZERO,
                begun: begun.clone(),
                finished: finished.clone(),
            },
            "/code/beta".into(),
            None,
        );
        ws.project_mut(project_id).unwrap().attach_terminal(
            &second,
            BarrierFakeTerm {
                gate: stuck_gate.clone(),
                barrier: None,
                wait_limit: Duration::from_secs(10),
                begun: begun.clone(),
                finished: finished.clone(),
            },
            "/code/beta".into(),
            None,
        );

        let start = Instant::now();
        ws.shutdown_all_and_wait();
        let elapsed = start.elapsed();

        // Release the stuck waiter thread immediately after assertion.
        *stuck_gate.0.lock().unwrap() = true;
        stuck_gate.1.notify_all();

        assert_eq!(begun.load(Ordering::SeqCst), 2);
        assert_eq!(finished.load(Ordering::SeqCst), 1);
        assert!(
            elapsed < Duration::from_millis(3600),
            "hung terminal must be bounded by SHUTDOWN_BUDGET (~3s), took {elapsed:?}"
        );
    }
}
