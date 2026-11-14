pub mod releases;

mod fetch;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use gpui_kit::App;
use serde_json::{Value, json};

use releases::{Manual, Release, Stage};

const STABLE_FEED: &str = "https://github.com/vibevalleyhq/vibevalley/releases/latest/download/release.json";
const RELEASE_LIST: &str = "https://api.github.com/repos/vibevalleyhq/vibevalley/releases?per_page=30";
const EVERY: Duration = Duration::from_secs(4 * 60 * 60);

#[derive(Debug, Clone, PartialEq)]
enum State {
    Idle,
    Checking,
    Downloading { next: String, percent: u8 },
    Ready { next: String, notes: Vec<String>, page: String },
    Manual { next: String, why: Manual, page: String },
    Failed { why: String },
}

impl State {
    fn json(&self, version: &str) -> Value {
        match self {
            State::Idle => json!({ "_tag": "idle", "version": version }),
            State::Checking => json!({ "_tag": "checking", "version": version }),
            State::Downloading { next, percent } => json!({ "_tag": "downloading", "version": version, "next": next, "percent": percent }),
            State::Ready { next, notes, page } => json!({ "_tag": "ready", "version": version, "next": next, "notes": notes, "newFarm": false, "page": page }),
            State::Manual { next, why, page } => json!({ "_tag": "manual", "version": version, "next": next, "why": why.name(), "page": page }),
            State::Failed { why } => json!({ "_tag": "failed", "version": version, "why": why }),
        }
    }

    fn busy(&self) -> bool {
        matches!(self, State::Checking | State::Downloading { .. } | State::Ready { .. })
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Feed {
    Off,
    /// One manifest (`VIBEVALLEY_UPDATE_FEED`).
    Manifest(String),
    Stage(Stage),
}

fn feed_of(asked: Option<&str>, packaged: bool, version: &str) -> Feed {
    match asked {
        Some("off") => Feed::Off,
        Some(url) if !url.is_empty() && packaged => Feed::Manifest(url.to_string()),
        _ if !packaged || version == "0.0.0" => Feed::Off,
        _ => releases::stage_of(version).map_or(Feed::Off, Feed::Stage),
    }
}

fn arch() -> &'static str {
    if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" }
}

struct Staged {
    app: PathBuf,
    bundle: PathBuf,
}

struct Updater {
    version: String,
    /// The .app this process runs from.
    bundle: Option<PathBuf>,
    /// Where downloads go, a folder a version.
    dir: PathBuf,
    feed: Feed,
    state: Mutex<State>,
    staged: Mutex<Option<Staged>>,
}

// Runs once this process has quit: if the new .app cannot be moved in, the old one goes back.
const SWAP_SCRIPT: &str = r#"#!/bin/sh
pid="$1"; current="$2"; next="$3"; old="$4"; reopen="$5"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
[ -d "$next" ] || exit 1
[ ! -e "$old" ] || exit 1
mv "$current" "$old" || exit 1
if ! mv "$next" "$current"; then
  mv "$old" "$current"
  exit 1
fi
if [ "$reopen" = 1 ]; then open "$current"; fi
"#;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".vibevalley-update-{}", std::process::id()));
    let made = std::fs::OpenOptions::new().write(true).create_new(true).open(&probe).is_ok();
    if made {
        let _ = std::fs::remove_file(&probe);
    }
    made
}

impl Updater {
    fn from_env() -> Updater {
        let exe = std::env::current_exe().ok();
        let bundle = exe.as_deref().and_then(Path::to_str).and_then(releases::bundle_of).map(PathBuf::from);
        let version = bundle
            .as_ref()
            .and_then(|b| std::fs::read_to_string(b.join("Contents/Info.plist")).ok())
            .and_then(|xml| releases::plist_version(&xml).map(str::to_string))
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
        let asked = std::env::var("VIBEVALLEY_UPDATE_FEED").ok();
        Updater {
            feed: feed_of(asked.as_deref(), bundle.is_some(), &version),
            version,
            bundle,
            dir: crate::hosted::server_home().join("updates"),
            state: Mutex::new(State::Idle),
            staged: Mutex::new(None),
        }
    }

    fn state(&self) -> Value {
        lock(&self.state).json(&self.version)
    }

    fn set(&self, next: State) {
        let mut state = lock(&self.state);
        if *state != next {
            // One line a change, for whoever drives the app from outside (scripts/release/update-check.ts).
            eprintln!("update: {}", next.json(&self.version));
            *state = next;
        }
    }

    /// The manifest of the latest release this app takes; `None` when there is none yet.
    fn manifest(&self) -> Result<Option<String>, String> {
        match &self.feed {
            Feed::Off => Ok(None),
            Feed::Manifest(url) => Ok(Some(url.clone())),
            Feed::Stage(Stage::Stable) => Ok(Some(STABLE_FEED.to_string())),
            Feed::Stage(stage) => {
                let (status, body) = fetch::text(RELEASE_LIST)?;
                if status != 200 {
                    return Err(format!("releases: {status}"));
                }
                let list: Vec<releases::ListedRelease> = serde_json::from_str(&body).map_err(|e| format!("releases: {e}"))?;
                Ok(releases::manifest_for(&list, *stage))
            }
        }
    }

    /// Asks once; blocks while it downloads. Does nothing while a check runs or an update is ready.
    fn check(&self) {
        {
            let mut state = lock(&self.state);
            if state.busy() || self.feed == Feed::Off {
                return;
            }
            *state = State::Checking;
        }
        eprintln!("update: {}", State::Checking.json(&self.version));
        let settled = self.look().unwrap_or_else(|why| State::Failed { why });
        self.set(settled);
    }

    fn look(&self) -> Result<State, String> {
        let Some(feed) = self.manifest()? else { return Ok(State::Idle) };
        let (status, body) = fetch::text(&feed)?;
        // No release yet.
        if status == 404 {
            return Ok(State::Idle);
        }
        if status != 200 {
            return Err(format!("release.json: {status}"));
        }
        let release: Release = serde_json::from_str(&body).map_err(|e| format!("release.json: {e}"))?;
        if !releases::is_version(&release.version) {
            return Err("release.json: invalid version".into());
        }
        if !releases::newer(&release.version, &self.version) {
            return Ok(State::Idle);
        }
        let manual = |why| State::Manual {
            next: release.version.clone(),
            why,
            page: release.page.clone(),
        };
        let Some(build) = releases::build_for(&release, arch()) else {
            return Ok(manual(Manual::NoBuild));
        };
        let Some(bundle) = &self.bundle else { return Ok(manual(Manual::ReadOnly)) };
        let can_write = writable(bundle) && bundle.parent().is_some_and(writable);
        if let Some(why) = releases::place_problem(&bundle.to_string_lossy(), can_write) {
            return Ok(manual(why));
        }
        let url = releases::beside(&feed, &build.file).ok_or_else(|| format!("{}: not a file beside release.json", build.file))?;
        let folder = self.dir.join(&release.version);
        let app = fetch::staged_app(&url, build, &release.version, bundle, &folder, |percent| {
            self.set(State::Downloading {
                next: release.version.clone(),
                percent,
            });
        })?;
        *lock(&self.staged) = Some(Staged { app, bundle: bundle.clone() });
        Ok(State::Ready {
            next: release.version,
            notes: release.notes,
            page: release.page,
        })
    }

    /// Hands the staged app to the swap script, which waits for this process to go.
    fn swap(&self, reopen: bool) -> bool {
        let mut pending = lock(&self.staged);
        let Some(staged) = pending.as_ref() else { return false };
        let Some(parent) = staged.bundle.parent() else { return false };
        let next = parent.join(format!(".VibeValley-update-{}.app", std::process::id()));
        let _ = std::fs::remove_dir_all(&next);
        let copied = std::process::Command::new("/usr/bin/ditto").arg(&staged.app).arg(&next).status();
        if !copied.is_ok_and(|s| s.success()) {
            eprintln!("update: cannot stage beside {}", staged.bundle.display());
            return false;
        }
        let script = self.dir.join("swap.sh");
        if let Err(e) = std::fs::write(&script, SWAP_SCRIPT) {
            eprintln!("update: {}: {e}", script.display());
            return false;
        }
        use std::os::unix::process::CommandExt as _;
        let spawned = std::process::Command::new("/bin/sh")
            .arg(&script)
            .arg(std::process::id().to_string())
            .arg(&staged.bundle)
            .arg(&next)
            .arg(parent.join(format!(".VibeValley-previous-{}.app", std::process::id())))
            .arg(if reopen { "1" } else { "0" })
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            // A group of its own: it outlives this process and whatever signal ends it.
            .process_group(0)
            .spawn();
        match spawned {
            Ok(_) => {
                *pending = None;
                true
            }
            Err(e) => {
                eprintln!("update: swap: {e}");
                false
            }
        }
    }
}

static UPDATER: OnceLock<Arc<Updater>> = OnceLock::new();

fn updater() -> &'static Arc<Updater> {
    UPDATER.get_or_init(|| Arc::new(Updater::from_env()))
}

pub fn version() -> &'static str {
    &updater().version
}

pub fn enter_bundle() {
    let exe = std::env::current_exe().ok();
    let Some(bundle) = exe.as_deref().and_then(Path::to_str).and_then(releases::bundle_of) else {
        return;
    };
    for (key, folder) in [("VIBEVALLEY_ASSETS", "assets"), ("VIBEVALLEY_UI_BUNDLE", "ui")] {
        let path = Path::new(bundle).join("Contents/Resources").join(folder);
        if std::env::var_os(key).is_none() && path.is_dir() {
            // SAFETY: called at the top of main, before any other thread exists.
            unsafe { std::env::set_var(key, path) };
        }
    }
}

pub fn install(cx: &mut App) {
    let updater = updater().clone();
    if updater.feed != Feed::Off {
        let asking = updater.clone();
        std::thread::spawn(move || {
            loop {
                asking.check();
                std::thread::sleep(EVERY);
            }
        });
    }
    cx.on_app_quit(move |_| {
        updater.swap(false);
        async {}
    })
    .detach();
}

pub fn ready() -> bool {
    matches!(*lock(&updater().state), State::Ready { .. })
}

pub fn host_call(op: &str, reply: crate::hosted::Replier, cx: &mut App) {
    use vibevalley_bridge::{BizCode, Envelope, refusal};
    let updater = updater().clone();
    match op {
        "host.updateState" => reply.send(Envelope::ok(updater.state())),
        // Answers once it has settled: it blocks while downloading.
        "host.updateCheck" => {
            std::thread::spawn(move || {
                updater.check();
                reply.send(Envelope::ok(Value::Null));
            });
        }
        // Restarts into the new version.
        "host.updateInstall" => {
            if updater.swap(true) {
                reply.send(Envelope::ok(Value::Null));
                cx.quit();
            } else {
                reply.send(refusal(BizCode::Refused, "no update is ready"));
            }
        }
        other => reply.send(refusal(BizCode::RouteNotFound, format!("the host has no op {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regression_a_failed_replacement_restores_the_previous_bundle() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().unwrap();
        let current = dir.path().join("VibeValley.app");
        let next = dir.path().join("next.app");
        let old = dir.path().join("previous.app");
        std::fs::create_dir(&current).unwrap();
        std::fs::create_dir(&next).unwrap();
        std::fs::write(current.join("version"), "old").unwrap();
        std::fs::write(next.join("version"), "new").unwrap();
        let mv = dir.path().join("mv");
        std::fs::write(&mv, "#!/bin/sh\ncase \"$1\" in */next.app) exit 1;; esac\nexec /bin/mv \"$@\"\n").unwrap();
        std::fs::set_permissions(&mv, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut finished = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let pid = finished.id();
        finished.wait().unwrap();
        let status = std::process::Command::new("/bin/sh")
            .args(["-c", SWAP_SCRIPT, "swap"])
            .arg(pid.to_string())
            .arg(&current)
            .arg(&next)
            .arg(&old)
            .arg("0")
            .env("PATH", dir.path())
            .status()
            .unwrap();
        assert!(!status.success());
        assert_eq!(std::fs::read_to_string(current.join("version")).unwrap(), "old");
        assert_eq!(std::fs::read_to_string(next.join("version")).unwrap(), "new");
        assert!(!old.exists());
    }

    #[test]
    fn only_a_packaged_tagged_app_asks_and_within_its_own_stage() {
        assert_eq!(feed_of(None, false, "0.4.0"), Feed::Off);
        assert_eq!(feed_of(Some("http://127.0.0.1:1/release.json"), false, "0.4.0"), Feed::Off);
        assert_eq!(feed_of(None, true, "0.0.0"), Feed::Off);
        assert_eq!(feed_of(None, true, "not a version"), Feed::Off);
        assert_eq!(feed_of(None, true, "0.4.0"), Feed::Stage(Stage::Stable));
        assert_eq!(feed_of(None, true, "0.4.0-beta.2"), Feed::Stage(Stage::Beta));
        assert_eq!(feed_of(None, true, "0.4.0-alpha.1"), Feed::Stage(Stage::Alpha));
        assert_eq!(feed_of(Some(""), true, "0.4.0"), Feed::Stage(Stage::Stable));
        assert_eq!(feed_of(Some("off"), true, "0.4.0"), Feed::Off);
        assert_eq!(
            feed_of(Some("http://127.0.0.1:1/release.json"), true, "0.0.0"),
            Feed::Manifest("http://127.0.0.1:1/release.json".into())
        );
    }

    #[test]
    fn each_state_is_said_in_the_contracts_shape() {
        assert_eq!(State::Idle.json("0.1.0"), json!({ "_tag": "idle", "version": "0.1.0" }));
        assert_eq!(
            State::Downloading {
                next: "0.2.0".into(),
                percent: 40
            }
            .json("0.1.0"),
            json!({ "_tag": "downloading", "version": "0.1.0", "next": "0.2.0", "percent": 40 })
        );
        assert_eq!(
            State::Ready {
                next: "0.2.0".into(),
                notes: vec!["One".into()],
                page: "p".into()
            }
            .json("0.1.0"),
            json!({ "_tag": "ready", "version": "0.1.0", "next": "0.2.0", "notes": ["One"], "newFarm": false, "page": "p" })
        );
        assert_eq!(
            State::Manual {
                next: "0.2.0".into(),
                why: Manual::DiskImage,
                page: "p".into()
            }
            .json("0.1.0"),
            json!({ "_tag": "manual", "version": "0.1.0", "next": "0.2.0", "why": "diskImage", "page": "p" })
        );
        assert_eq!(
            State::Failed { why: "x".into() }.json("0.1.0"),
            json!({ "_tag": "failed", "version": "0.1.0", "why": "x" })
        );
    }

    #[test]
    fn an_app_outside_a_bundle_never_asks_and_has_nothing_to_swap() {
        let dir = tempfile::tempdir().unwrap();
        let updater = Updater {
            version: "0.1.0".into(),
            bundle: None,
            dir: dir.path().to_path_buf(),
            feed: Feed::Off,
            state: Mutex::new(State::Idle),
            staged: Mutex::new(None),
        };
        updater.check();
        assert_eq!(updater.state()["_tag"], "idle");
        assert!(!updater.swap(true));
        assert!(writable(dir.path()));
        assert!(!writable(&dir.path().join("missing")));
    }
}
