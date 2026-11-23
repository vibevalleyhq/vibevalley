pub mod releases;

mod fetch;

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use gpui::App;
use parking_lot::Mutex;
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

fn writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".vibevalley-update-{}", std::process::id()));
    let made = std::fs::OpenOptions::new().write(true).create_new(true).open(&probe).is_ok();
    if made {
        let _ = std::fs::remove_file(&probe);
    }
    made
}

pub fn bundle_version() -> String {
    let exe = std::env::current_exe().ok();
    exe.as_deref()
        .and_then(Path::to_str)
        .and_then(releases::bundle_of)
        .and_then(|b| std::fs::read_to_string(Path::new(b).join("Contents/Info.plist")).ok())
        .and_then(|xml| releases::plist_version(&xml).map(str::to_string))
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

impl Updater {
    fn from_env() -> Updater {
        let exe = std::env::current_exe().ok();
        let bundle = exe.as_deref().and_then(Path::to_str).and_then(releases::bundle_of).map(PathBuf::from);
        let version = bundle_version();
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
        self.state.lock().json(&self.version)
    }

    fn set(&self, next: State) {
        let mut state = self.state.lock();
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
            let mut state = self.state.lock();
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
        *self.staged.lock() = Some(Staged { app, bundle: bundle.clone() });
        Ok(State::Ready {
            next: release.version,
            notes: release.notes,
            page: release.page,
        })
    }

    /// Hands the staged app to the swap script, which waits for this process to go.
    fn swap(&self, reopen: bool) -> bool {
        let mut pending = self.staged.lock();
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

fn extract_login_path(output: &str) -> Option<&str> {
    let (_, rest) = output.split_once("__VV_PATH__")?;
    let (path, _) = rest.split_once("__VV_END__")?;
    (!path.is_empty()).then_some(path)
}

fn merge_path_entries(existing: Option<&std::ffi::OsStr>, login: &std::ffi::OsStr) -> std::ffi::OsString {
    let login_paths: Vec<PathBuf> = std::env::split_paths(login).filter(|p| !p.as_os_str().is_empty()).collect();
    let existing_paths: Vec<PathBuf> = existing
        .into_iter()
        .flat_map(std::env::split_paths)
        .filter(|p| !p.as_os_str().is_empty())
        .collect();
    let mut merged = Vec::with_capacity(existing_paths.len() + login_paths.len());
    for entry in &existing_paths {
        if !login_paths.contains(entry) && !merged.contains(entry) {
            merged.push(entry.clone());
        }
    }
    for entry in login_paths {
        if !merged.contains(&entry) {
            merged.push(entry);
        }
    }
    for entry in existing_paths {
        if !merged.contains(&entry) {
            merged.push(entry);
        }
    }
    std::env::join_paths(merged).unwrap_or_else(|_| login.to_os_string())
}

fn resolve_login_shell_path(timeout: Duration) -> Option<String> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| Path::new(s).is_file())
        .unwrap_or_else(|| "/bin/zsh".into());
    let mut child = std::process::Command::new(&shell)
        .args(["-ilc", "printf '__VV_PATH__%s__VV_END__' \"$PATH\""])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        use std::io::Read as _;
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(15)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let bytes = rx.recv_timeout(Duration::from_millis(200)).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    extract_login_path(&text).map(str::to_string)
}

pub fn enter_bundle() {
    let exe = std::env::current_exe().ok();
    let bundle = exe.as_deref().and_then(Path::to_str).and_then(releases::bundle_of);
    if (bundle.is_some() || std::env::var_os("SHLVL").is_none())
        && std::env::var_os("VIBEVALLEY_SKIP_LOGIN_PATH").is_none()
        && let Some(login_path) = resolve_login_shell_path(Duration::from_secs(2))
    {
        let merged = merge_path_entries(std::env::var_os("PATH").as_deref(), std::ffi::OsStr::new(&login_path));
        // SAFETY: called at the top of main, before GPUI or background threads start.
        unsafe { std::env::set_var("PATH", merged) };
    }
    let Some(bundle) = bundle else {
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
    matches!(*updater().state.lock(), State::Ready { .. })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateOp {
    State,
    Check,
    Install,
}

pub fn host_call(op: UpdateOp, reply: crate::hosted::Replier, cx: &mut App) {
    use vibevalley_server::transport::bridge::{BizCode, Envelope, refusal};
    let updater = updater().clone();
    match op {
        UpdateOp::State => reply.send(Envelope::ok(updater.state())),
        // Answers once it has settled: it blocks while downloading.
        UpdateOp::Check => {
            std::thread::spawn(move || {
                updater.check();
                reply.send(Envelope::ok(Value::Null));
            });
        }
        // Restarts into the new version.
        UpdateOp::Install => {
            if updater.swap(true) {
                reply.send(Envelope::ok(Value::Null));
                cx.quit();
            } else {
                reply.send(refusal(BizCode::Refused, "no update is ready"));
            }
        }
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

    #[test]
    fn login_path_extraction_and_merging_preserve_overrides_and_user_tools() {
        assert_eq!(
            extract_login_path("banner\n__VV_PATH__/opt/homebrew/bin:/usr/bin__VV_END__\n"),
            Some("/opt/homebrew/bin:/usr/bin")
        );
        assert_eq!(extract_login_path("__VV_PATH____VV_END__"), None);
        let launchd = std::ffi::OsStr::new("/usr/bin:/bin:/usr/sbin:/sbin");
        let login = std::ffi::OsStr::new("/Users/u/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin");
        assert_eq!(merge_path_entries(Some(launchd), login), login);
        let custom = std::ffi::OsStr::new("/tmp/mock-bin:/usr/bin:/bin");
        assert_eq!(
            merge_path_entries(Some(custom), login),
            std::ffi::OsStr::new("/tmp/mock-bin:/Users/u/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin")
        );
    }
}
