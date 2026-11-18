use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::event::{EventKind, ModifyKind};
use notify::{RecursiveMode, Watcher as _};

use crate::walk::io_error;
use crate::{FilesError, FsChange, FsChangeKind, Result};

/// A batch is delivered once nothing has happened for this long...
const QUIET: Duration = Duration::from_millis(80);
/// ...or this long after its first event, whichever comes first.
const MAX_DELAY: Duration = Duration::from_millis(400);

type Callback = Box<dyn Fn(Vec<FsChange>) + Send + 'static>;

pub(crate) struct Inner {
    // Dropping the notify watcher closes the channel, which ends the thread.
    _watcher: notify::RecommendedWatcher,
    stopped: Arc<AtomicBool>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Relaxed);
    }
}

/// Files directly inside a git directory whose change alters what
/// `git status` / the branch list would say.
const GIT_STATE_FILES: &[&str] = &[
    "index",
    "HEAD",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "REBASE_HEAD",
    "BISECT_LOG",
    "FETCH_HEAD",
    "packed-refs",
];

/// `relative` is a path inside a git directory.
fn is_git_state(relative: &Path) -> bool {
    let mut parts = relative.components().filter_map(|c| match c {
        Component::Normal(name) => name.to_str(),
        _ => None,
    });
    let Some(first) = parts.next() else { return false };
    let rest: Vec<&str> = parts.collect();
    match rest.last() {
        None => GIT_STATE_FILES.contains(&first),
        Some(last) => {
            first == "refs"
                && !last.ends_with(".lock")
                // VibeValley's own snapshot refs change nothing the user sees.
                && rest.first() != Some(&"vibevalley")
        }
    }
}

pub(crate) fn is_git_state_path(path: &Path) -> bool {
    let parts: Vec<Component<'_>> = path.components().collect();
    parts
        .iter()
        .rposition(|c| c.as_os_str() == ".git")
        .is_some_and(|at| is_git_state(&parts[at + 1..].iter().collect::<PathBuf>()))
}

/// For a linked worktree `.git` is a file pointing at the real git dir.
fn linked_git_dir(root: &Path) -> Option<PathBuf> {
    let dot_git = root.join(".git");
    if !dot_git.is_file() {
        return None;
    }
    let text = std::fs::read_to_string(&dot_git).ok()?;
    let target = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    root.join(target).canonicalize().ok()
}

struct Filter {
    /// Canonical, as the OS reports event paths.
    root: PathBuf,
    /// As the caller named it; reported paths are rebuilt under this.
    given_root: PathBuf,
    linked_git_dir: Option<PathBuf>,
    ignore: Gitignore,
    /// Whether a directory named `target*` is a cargo target directory.
    cargo_dirs: HashMap<PathBuf, bool>,
}

impl Filter {
    fn new(root: PathBuf, given_root: PathBuf) -> Filter {
        let linked_git_dir = linked_git_dir(&root);
        let ignore = Self::load_ignore(&root, linked_git_dir.as_deref());
        Filter {
            root,
            given_root,
            linked_git_dir,
            ignore,
            cargo_dirs: HashMap::new(),
        }
    }

    fn load_ignore(root: &Path, linked_git_dir: Option<&Path>) -> Gitignore {
        let mut builder = GitignoreBuilder::new(root);
        let _ = builder.add(root.join(".gitignore"));
        let git_dir = linked_git_dir.map(Path::to_path_buf).unwrap_or_else(|| root.join(".git"));
        let _ = builder.add(git_dir.join("info/exclude"));
        builder.build().unwrap_or_else(|_| Gitignore::empty())
    }

    fn is_cargo_target(&mut self, dir: &Path) -> bool {
        if let Some(known) = self.cargo_dirs.get(dir) {
            return *known;
        }
        // Cargo tags every target directory it creates.
        let tagged = dir.join("CACHEDIR.TAG").is_file();
        self.cargo_dirs.insert(dir.to_path_buf(), tagged);
        tagged
    }

    /// The path to report for an event at `path`, or `None` to drop it.
    fn accept(&mut self, path: &Path) -> Option<PathBuf> {
        if let Some(git_dir) = &self.linked_git_dir
            && let Ok(inside) = path.strip_prefix(git_dir)
        {
            return is_git_state(inside).then(|| path.to_path_buf());
        }
        let relative = path.strip_prefix(&self.root).ok()?;
        let mut parts = relative.components();
        let first = parts.next()?;
        if first.as_os_str() == ".git" {
            return is_git_state(parts.as_path()).then(|| self.given_root.join(relative));
        }

        let mut prefix = self.root.clone();
        for part in relative.components() {
            let name = part.as_os_str().to_string_lossy();
            prefix.push(part);
            // `.git` deeper down belongs to a nested repository.
            if name == ".git" || name == "node_modules" || name == ".DS_Store" {
                return None;
            }
            if name.starts_with("target") && self.is_cargo_target(&prefix) {
                return None;
            }
        }
        if relative == Path::new(".gitignore") {
            self.ignore = Self::load_ignore(&self.root, self.linked_git_dir.as_deref());
        } else if self.ignore.matched_path_or_any_parents(relative, path.is_dir()).is_ignore() {
            return None;
        }
        Some(self.given_root.join(relative))
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Seen {
    Appeared,
    Changed,
}

/// Events gathered for one batch, in first-seen order.
#[derive(Default)]
struct Pending {
    order: Vec<PathBuf>,
    /// Real path on disk and how it first showed up, by reported path.
    paths: HashMap<PathBuf, (PathBuf, Seen)>,
    rescan: bool,
}

impl Pending {
    fn absorb(&mut self, event: notify::Event, filter: &mut Filter) {
        if event.need_rescan() {
            self.rescan = true;
        }
        let seen = match event.kind {
            EventKind::Access(_) => return,
            // A rename shows up as a name change on both the old and the
            // new path; whichever exists afterwards has appeared.
            EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(_)) => Seen::Appeared,
            _ => Seen::Changed,
        };
        for path in event.paths {
            let Some(reported) = filter.accept(&path) else { continue };
            if !self.paths.contains_key(&reported) {
                self.order.push(reported.clone());
                self.paths.insert(reported, (path, seen));
            }
        }
    }

    fn is_empty(&self) -> bool {
        self.order.is_empty() && !self.rescan
    }

    /// What is on disk now decides the kind: the event stream coalesces and
    /// reorders too freely to trust its own flags.
    fn into_batch(mut self, filter: &Filter) -> Vec<FsChange> {
        let mut batch = Vec::with_capacity(self.order.len() + 1);
        if self.rescan {
            // Events were dropped by the OS: everything may have changed.
            batch.push(FsChange {
                path: filter.given_root.clone(),
                kind: FsChangeKind::Modified,
            });
        }
        for reported in self.order {
            let Some((real, seen)) = self.paths.remove(&reported) else { continue };
            let kind = match (real.symlink_metadata().is_ok(), seen) {
                (false, _) => FsChangeKind::Removed,
                (true, Seen::Appeared) => FsChangeKind::Created,
                (true, Seen::Changed) => FsChangeKind::Modified,
            };
            batch.push(FsChange { path: reported, kind });
        }
        batch
    }
}

impl Inner {
    pub fn start(root: &Path, on_change: Callback) -> Result<Inner> {
        let canonical = root.canonicalize().map_err(|e| io_error(root, e))?;
        if !canonical.is_dir() {
            return Err(io_error(root, "not a directory"));
        }
        let watch_error = |e: notify::Error| FilesError::Watch(e.to_string());

        let (sender, receiver) = mpsc::channel::<notify::Result<notify::Event>>();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })
        .map_err(watch_error)?;
        watcher.watch(&canonical, RecursiveMode::Recursive).map_err(watch_error)?;

        let mut filter = Filter::new(canonical, root.to_path_buf());
        if let Some(git_dir) = &filter.linked_git_dir {
            // Best effort: without it the tree is still watched.
            let _ = watcher.watch(git_dir, RecursiveMode::NonRecursive);
        }

        let stopped = Arc::new(AtomicBool::new(false));
        let thread_stopped = stopped.clone();
        std::thread::Builder::new()
            .name("vibevalley-files-watch".into())
            .spawn(move || {
                while let Ok(first) = receiver.recv() {
                    let mut pending = Pending::default();
                    if let Ok(event) = first {
                        pending.absorb(event, &mut filter);
                    }
                    let started = Instant::now();
                    let mut disconnected = false;
                    // Nothing accepted yet: no batch is open, so no need to
                    // wait out the quiet period.
                    while !pending.is_empty() {
                        let left = MAX_DELAY.saturating_sub(started.elapsed());
                        if left.is_zero() {
                            break;
                        }
                        match receiver.recv_timeout(QUIET.min(left)) {
                            Ok(Ok(event)) => pending.absorb(event, &mut filter),
                            Ok(Err(_)) => {}
                            Err(RecvTimeoutError::Timeout) => break,
                            Err(RecvTimeoutError::Disconnected) => {
                                disconnected = true;
                                break;
                            }
                        }
                    }
                    if disconnected || thread_stopped.load(Ordering::Relaxed) {
                        return;
                    }
                    if !pending.is_empty() {
                        let batch = pending.into_batch(&filter);
                        if !batch.is_empty() {
                            on_change(batch);
                        }
                    }
                }
            })
            .map_err(|e| FilesError::Watch(e.to_string()))?;

        Ok(Inner { _watcher: watcher, stopped })
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Mutex;

    use super::*;
    use crate::Watcher;

    type Log = Arc<Mutex<Vec<Vec<FsChange>>>>;

    struct Watched {
        _tmp: tempfile::TempDir,
        root: PathBuf,
        log: Log,
        watcher: Option<Watcher>,
    }

    impl Watched {
        fn new(prepare: impl FnOnce(&Path)) -> Watched {
            let tmp = tempfile::tempdir().unwrap();
            // Deliberately not canonical (/var vs /private/var on macOS).
            let root = tmp.path().join("project");
            fs::create_dir_all(root.join(".git/refs/heads")).unwrap();
            fs::write(root.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
            prepare(&root);
            // Let the events of the setup above drain before watching.
            std::thread::sleep(Duration::from_millis(300));
            let log: Log = Arc::default();
            let sink = log.clone();
            let watcher = Watcher::new(&root, move |batch| sink.lock().unwrap().push(batch)).unwrap();
            std::thread::sleep(Duration::from_millis(200));
            Watched {
                _tmp: tmp,
                root,
                log,
                watcher: Some(watcher),
            }
        }

        fn changes(&self) -> Vec<FsChange> {
            self.log.lock().unwrap().iter().flatten().cloned().collect()
        }

        fn kind_of(&self, relative: &str) -> Option<FsChangeKind> {
            let path = self.root.join(relative);
            self.changes().iter().rev().find(|c| c.path == path).map(|c| c.kind)
        }

        /// Waits until `relative` has been reported (with `kind`, if given).
        fn wait_for(&self, relative: &str, kind: Option<FsChangeKind>) {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let got = self.kind_of(relative);
                if got.is_some() && (kind.is_none() || got == kind) {
                    return;
                }
                assert!(Instant::now() < deadline, "no {kind:?} for {relative}; got {:#?}", self.changes());
                std::thread::sleep(Duration::from_millis(20));
            }
        }

        fn settle(&self) {
            std::thread::sleep(MAX_DELAY + Duration::from_millis(400));
        }
    }

    #[test]
    fn reports_create_modify_remove_and_rename() {
        let w = Watched::new(|root| {
            fs::create_dir_all(root.join("src")).unwrap();
            fs::write(root.join("src/existing.rs"), "old\n").unwrap();
            fs::write(root.join("doomed.txt"), "x\n").unwrap();
            fs::write(root.join("old name.txt"), "x\n").unwrap();
        });

        fs::write(w.root.join("src/新 文件.rs"), "fn main() {}\n").unwrap();
        w.wait_for("src/新 文件.rs", Some(FsChangeKind::Created));

        fs::write(w.root.join("src/existing.rs"), "new\n").unwrap();
        w.wait_for("src/existing.rs", Some(FsChangeKind::Modified));

        fs::remove_file(w.root.join("doomed.txt")).unwrap();
        w.wait_for("doomed.txt", Some(FsChangeKind::Removed));

        fs::rename(w.root.join("old name.txt"), w.root.join("new name.txt")).unwrap();
        w.wait_for("old name.txt", Some(FsChangeKind::Removed));
        w.wait_for("new name.txt", Some(FsChangeKind::Created));

        fs::create_dir(w.root.join("newdir")).unwrap();
        w.wait_for("newdir", Some(FsChangeKind::Created));

        // Every reported path is under the root exactly as it was given.
        assert!(w.changes().iter().all(|c| c.path.starts_with(&w.root)), "{:#?}", w.changes());
    }

    #[test]
    fn batches_a_burst_of_changes() {
        let w = Watched::new(|_| {});
        for n in 0..300 {
            fs::write(w.root.join(format!("burst-{n}.txt")), "x").unwrap();
        }
        w.wait_for("burst-299.txt", None);
        w.settle();

        let batches = w.log.lock().unwrap().clone();
        let total: usize = batches.iter().map(Vec::len).sum();
        assert_eq!(total, 300, "each path is reported once");
        assert!(batches.len() <= 20, "300 changes arrived in {} batches", batches.len());
        let mut names: Vec<_> = batches.iter().flatten().map(|c| c.path.clone()).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), 300);
    }

    #[test]
    fn filters_noise_but_reports_git_state() {
        let w = Watched::new(|root| {
            fs::write(root.join(".gitignore"), "*.log\n/dist/\n").unwrap();
            for dir in ["target/debug", "target-agent/debug", "targets", "dist", "node_modules/pkg", ".git/objects/ab"] {
                fs::create_dir_all(root.join(dir)).unwrap();
            }
            for dir in ["target", "target-agent"] {
                fs::write(root.join(dir).join("CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n").unwrap();
            }
        });

        // Noise: build output, dependencies, ignored files, git internals.
        fs::write(w.root.join("target/debug/app.o"), "x").unwrap();
        fs::write(w.root.join("target-agent/debug/app.o"), "x").unwrap();
        fs::write(w.root.join("node_modules/pkg/index.js"), "x").unwrap();
        fs::write(w.root.join("build.log"), "x").unwrap();
        fs::write(w.root.join("dist/bundle.js"), "x").unwrap();
        fs::write(w.root.join(".DS_Store"), "x").unwrap();
        fs::write(w.root.join(".git/objects/ab/cdef"), "x").unwrap();
        fs::write(w.root.join(".git/index.lock"), "x").unwrap();
        fs::write(w.root.join(".git/COMMIT_EDITMSG"), "x").unwrap();
        fs::create_dir_all(w.root.join(".git/refs/vibevalley/snapshots/x")).unwrap();
        fs::write(w.root.join(".git/refs/vibevalley/snapshots/x/abc"), "x").unwrap();
        // Signal: git writes the index by renaming the lock over it.
        fs::rename(w.root.join(".git/index.lock"), w.root.join(".git/index")).unwrap();
        fs::write(w.root.join(".git/HEAD"), "ref: refs/heads/other\n").unwrap();
        fs::write(w.root.join(".git/refs/heads/other"), "0123\n").unwrap();
        // A directory that merely looks like a target dir is not noise.
        fs::write(w.root.join("targets/list.txt"), "x").unwrap();
        fs::write(w.root.join("kept.txt"), "x").unwrap();

        w.wait_for(".git/index", None);
        w.wait_for(".git/HEAD", Some(FsChangeKind::Modified));
        w.wait_for(".git/refs/heads/other", Some(FsChangeKind::Created));
        w.wait_for("targets/list.txt", None);
        w.wait_for("kept.txt", None);
        w.settle();

        let mut reported: Vec<String> = w
            .changes()
            .iter()
            .map(|c| c.path.strip_prefix(&w.root).unwrap().to_string_lossy().into_owned())
            .collect();
        reported.sort();
        reported.dedup();
        assert_eq!(
            reported,
            vec![".git/HEAD", ".git/index", ".git/refs/heads/other", "kept.txt", "targets/list.txt"]
        );
        assert!(Watcher::is_git_state_path(&w.root.join(".git/index")));
        assert!(Watcher::is_git_state_path(Path::new(".git/refs/remotes/origin/main")));
        assert!(!Watcher::is_git_state_path(&w.root.join(".git/objects/ab/cdef")));
        assert!(!Watcher::is_git_state_path(&w.root.join("src/index")));

        // Editing .gitignore takes effect for later events.
        fs::write(w.root.join(".gitignore"), "/dist/\n").unwrap();
        w.wait_for(".gitignore", None);
        fs::write(w.root.join("now-visible.log"), "x").unwrap();
        w.wait_for("now-visible.log", None);
    }

    #[test]
    fn linked_worktree_reports_its_git_dir_in_the_main_repository() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let git_dir = base.join("main/.git/worktrees/task");
        let root = base.join("task");
        fs::create_dir_all(&git_dir).unwrap();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(".git"), format!("gitdir: {}\n", git_dir.display())).unwrap();
        std::thread::sleep(Duration::from_millis(300));

        let log: Log = Arc::default();
        let sink = log.clone();
        let _watcher = Watcher::new(&root, move |batch| sink.lock().unwrap().push(batch)).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        fs::write(git_dir.join("index"), "x").unwrap();
        fs::write(git_dir.join("ORIG_HEAD"), "x").unwrap();

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let seen: Vec<PathBuf> = log.lock().unwrap().iter().flatten().map(|c| c.path.clone()).collect();
            if seen.contains(&git_dir.join("index")) {
                assert!(!seen.contains(&git_dir.join("ORIG_HEAD")));
                break;
            }
            assert!(Instant::now() < deadline, "index change not reported: {seen:?}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn dropping_the_watcher_stops_delivery() {
        let mut w = Watched::new(|_| {});
        fs::write(w.root.join("before.txt"), "x").unwrap();
        w.wait_for("before.txt", None);
        w.settle();

        drop(w.watcher.take());
        let delivered = w.changes().len();
        fs::write(w.root.join("after.txt"), "x").unwrap();
        w.settle();
        assert_eq!(w.changes().len(), delivered);

        assert!(matches!(Watcher::new(&w.root.join("missing"), |_| {}), Err(FilesError::Io(_))));
    }
}
