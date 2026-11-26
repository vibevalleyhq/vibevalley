use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use gpui::App;
use parking_lot::Mutex;
use serde_json::{Value, json};

use super::fetch;
use super::releases::{self, Manual, Release, Stage};

const STABLE_FEED: &str = "https://github.com/vibevalleyhq/vibevalley/releases/latest/download/release.json";
const RELEASE_LIST: &str = "https://api.github.com/repos/vibevalleyhq/vibevalley/releases?per_page=30";
const EVERY: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, PartialEq)]
pub(super) enum State {
    Idle,
    Checking,
    Downloading { next: String, percent: u8 },
    Ready { next: String, notes: Vec<String>, page: String },
    Manual { next: String, why: Manual, page: String },
    Failed { why: String },
}

impl State {
    pub(super) fn json(&self, version: &str) -> Value {
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
pub(super) enum Feed {
    Off,
    /// One manifest (`VIBEVALLEY_UPDATE_FEED` or `Info.plist` `VibeValleyUpdateFeed`).
    Manifest(String),
    Stage(Stage),
}

fn valid_https_url(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|parsed| parsed.scheme() == "https" && parsed.host().is_some())
}

pub(super) fn feed_of(asked: Option<&str>, plist_feed: Option<&str>, packaged: bool, version: &str) -> Feed {
    match asked {
        Some("off") => Feed::Off,
        Some(url) if !url.is_empty() && packaged => Feed::Manifest(url.to_string()),
        _ if !packaged || version == "0.0.0" => Feed::Off,
        _ => {
            let Some(stage) = releases::stage_of(version) else {
                return Feed::Off;
            };
            if let Some(feed) = plist_feed.map(str::trim).filter(|s| !s.is_empty())
                && ((stage == Stage::Alpha && feed.starts_with("file://")) || valid_https_url(feed))
            {
                return Feed::Manifest(feed.to_string());
            }
            Feed::Stage(stage)
        }
    }
}

fn arch() -> &'static str {
    if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" }
}

pub(super) struct Staged {
    app: PathBuf,
    bundle: PathBuf,
}

pub(super) struct Updater {
    pub(super) version: String,
    /// The .app this process runs from.
    pub(super) bundle: Option<PathBuf>,
    /// Where downloads go, a folder a version.
    pub(super) dir: PathBuf,
    pub(super) feed: Feed,
    pub(super) state: Mutex<State>,
    pub(super) staged: Mutex<Option<Staged>>,
}

// Runs once this process has quit: if the new .app cannot be moved in, the old one goes back.
pub(super) const SWAP_SCRIPT: &str = r#"#!/bin/sh
pid="$1"; current="$2"; next="$3"; old="$4"; reopen="$5"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
[ -d "$next" ] || exit 1
[ ! -e "$old" ] || exit 1
mv "$current" "$old" || exit 1
if ! mv "$next" "$current"; then
  mv "$old" "$current"
  exit 1
fi
rm -rf "$old" >/dev/null 2>&1 || true
if [ "$reopen" = 1 ]; then open "$current"; fi
"#;

pub(super) async fn writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".vibevalley-update-{}", std::process::id()));
    let made = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&probe).await.is_ok();
    if made {
        let _ = tokio::fs::remove_file(&probe).await;
    }
    made
}

impl Updater {
    fn from_env() -> Updater {
        let exe = std::env::current_exe().ok();
        let bundle = exe.as_deref().and_then(Path::to_str).and_then(releases::bundle_of).map(PathBuf::from);
        let plist = bundle.as_deref().and_then(|b| std::fs::read_to_string(b.join("Contents/Info.plist")).ok());
        let version = plist
            .as_deref()
            .and_then(releases::plist_version)
            .map(str::to_string)
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
        let plist_feed = plist.as_deref().and_then(releases::plist_update_feed);
        let asked = std::env::var("VIBEVALLEY_UPDATE_FEED").ok();
        Updater {
            feed: feed_of(asked.as_deref(), plist_feed, bundle.is_some(), &version),
            version,
            bundle,
            dir: crate::hosted::server_home().join("updates"),
            state: Mutex::new(State::Idle),
            staged: Mutex::new(None),
        }
    }

    pub(super) fn state(&self) -> Value {
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
    async fn manifest(&self) -> Result<Option<String>, String> {
        match &self.feed {
            Feed::Off => Ok(None),
            Feed::Manifest(url) => Ok(Some(url.clone())),
            Feed::Stage(Stage::Stable) => Ok(Some(STABLE_FEED.to_string())),
            Feed::Stage(stage) => {
                let (status, body) = fetch::text(RELEASE_LIST).await?;
                if status != 200 {
                    return Err(format!("releases: {status}"));
                }
                let list: Vec<releases::ListedRelease> = serde_json::from_str(&body).map_err(|e| format!("releases: {e}"))?;
                Ok(releases::manifest_for(&list, *stage))
            }
        }
    }

    /// Asks once; awaits while it downloads. Does nothing while a check runs or an update is ready.
    pub(super) async fn check(&self) {
        {
            let mut state = self.state.lock();
            if state.busy() || self.feed == Feed::Off {
                return;
            }
            *state = State::Checking;
        }
        eprintln!("update: {}", State::Checking.json(&self.version));
        let settled = self.look().await.unwrap_or_else(|why| State::Failed { why });
        self.set(settled);
    }

    async fn look(&self) -> Result<State, String> {
        let Some(feed) = self.manifest().await? else { return Ok(State::Idle) };
        let (status, body) = fetch::text(&feed).await?;
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
        let can_write = writable(bundle).await
            && match bundle.parent() {
                Some(parent) => writable(parent).await,
                None => false,
            };
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
        })
        .await?;
        *self.staged.lock() = Some(Staged { app, bundle: bundle.clone() });
        Ok(State::Ready {
            next: release.version,
            notes: release.notes,
            page: release.page,
        })
    }

    /// Hands the staged app to the swap script, which waits for this process to go.
    pub(super) async fn swap(&self, reopen: bool) -> bool {
        let Some(staged) = self.staged.lock().take() else { return false };
        let Some(parent) = staged.bundle.parent() else {
            *self.staged.lock() = Some(staged);
            return false;
        };
        let next = parent.join(format!(".VibeValley-update-{}.app", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&next).await;
        let copied = tokio::process::Command::new("/usr/bin/ditto")
            .arg(&staged.app)
            .arg(&next)
            .kill_on_drop(true)
            .status()
            .await;
        if !copied.is_ok_and(|s| s.success()) {
            eprintln!("update: cannot stage beside {}", staged.bundle.display());
            *self.staged.lock() = Some(staged);
            return false;
        }
        let script = self.dir.join("swap.sh");
        if let Err(e) = tokio::fs::write(&script, SWAP_SCRIPT).await {
            eprintln!("update: {}: {e}", script.display());
            *self.staged.lock() = Some(staged);
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
            Ok(_) => true,
            Err(e) => {
                eprintln!("update: swap: {e}");
                *self.staged.lock() = Some(staged);
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

pub fn install(cx: &mut App) {
    let updater = updater().clone();
    let cancel = (updater.feed != Feed::Off).then(|| {
        let asking = updater.clone();
        let cancel = tokio_util::sync::CancellationToken::new();
        let task_cancel = cancel.clone();
        vibevalley_runtime::rt::current_or_global_handle().spawn(async move {
            let mut interval = tokio::time::interval(EVERY);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    biased;
                    _ = task_cancel.cancelled() => break,
                    _ = interval.tick() => {
                        asking.check().await;
                    }
                }
            }
        });
        cancel
    });
    cx.on_app_quit(move |_| {
        if let Some(cancel) = &cancel {
            cancel.cancel();
        }
        let updater = updater.clone();
        let handle = vibevalley_runtime::rt::current_or_global_handle().spawn(async move {
            updater.swap(false).await;
        });
        async move {
            let _ = handle.await;
        }
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
    use vibevalley_server::gateway::bridge::{BizCode, Envelope, refusal};
    let updater = updater().clone();
    match op {
        UpdateOp::State => reply.send(Envelope::ok(updater.state())),
        // Answers once it has settled: it awaits while downloading.
        UpdateOp::Check => {
            vibevalley_runtime::rt::current_or_global_handle().spawn(async move {
                updater.check().await;
                reply.send(Envelope::ok(Value::Null));
            });
        }
        // Restarts into the new version.
        UpdateOp::Install => {
            let handle = vibevalley_runtime::rt::current_or_global_handle().spawn(async move { updater.swap(true).await });
            cx.spawn(async move |cx| {
                if handle.await.unwrap_or(false) {
                    reply.send(Envelope::ok(Value::Null));
                    cx.update(|cx| cx.quit());
                } else {
                    reply.send(refusal(BizCode::Refused, "no update is ready"));
                }
            })
            .detach();
        }
    }
}
