use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use gpui::App;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::sync::watch;

use super::fetch::{self, EtagCache, FailureKind, UpdateError};
use super::releases::{self, Manual, Release, Stage};

const STABLE_FEED: &str = "https://github.com/vibevalleyhq/vibevalley/releases/latest/download/release.json";
const RELEASE_LIST: &str = "https://api.github.com/repos/vibevalleyhq/vibevalley/releases?per_page=30";
const EVERY: Duration = Duration::from_secs(30 * 60);
const SWAP_FAILED_FILE: &str = "swap-failed.txt";

#[derive(Debug, Clone, PartialEq)]
pub(super) enum State {
    Disabled,
    Idle {
        checked_at: Option<i64>,
    },
    Checking,
    Downloading {
        next: String,
        percent: u8,
        downloaded_bytes: u64,
        total_bytes: u64,
        speed_bps: Option<u64>,
    },
    Verifying {
        next: String,
    },
    Ready {
        next: String,
        notes: Vec<String>,
        page: String,
    },
    Installing {
        next: String,
    },
    Manual {
        next: String,
        why: Manual,
        page: String,
    },
    Failed {
        kind: FailureKind,
        why: String,
        page: Option<String>,
    },
}

impl State {
    pub(super) fn json(&self, version: &str) -> Value {
        match self {
            State::Disabled => json!({ "_tag": "disabled", "version": version }),
            State::Idle { checked_at } => {
                let mut map = Map::new();
                map.insert("_tag".into(), json!("idle"));
                map.insert("version".into(), json!(version));
                if let Some(ts) = checked_at {
                    map.insert("checkedAt".into(), json!(ts));
                }
                Value::Object(map)
            }
            State::Checking => json!({ "_tag": "checking", "version": version }),
            State::Downloading {
                next,
                percent,
                downloaded_bytes,
                total_bytes,
                speed_bps,
            } => {
                let mut map = Map::new();
                map.insert("_tag".into(), json!("downloading"));
                map.insert("version".into(), json!(version));
                map.insert("next".into(), json!(next));
                map.insert("percent".into(), json!(percent));
                map.insert("downloadedBytes".into(), json!(downloaded_bytes));
                map.insert("totalBytes".into(), json!(total_bytes));
                if let Some(bps) = speed_bps {
                    map.insert("speedBps".into(), json!(bps));
                }
                Value::Object(map)
            }
            State::Verifying { next } => json!({ "_tag": "verifying", "version": version, "next": next }),
            State::Ready { next, notes, page } => {
                json!({ "_tag": "ready", "version": version, "next": next, "notes": notes, "newFarm": false, "page": page })
            }
            State::Installing { next } => json!({ "_tag": "installing", "version": version, "next": next }),
            State::Manual { next, why, page } => {
                json!({ "_tag": "manual", "version": version, "next": next, "why": why.name(), "page": page })
            }
            State::Failed { kind, why, page } => {
                let mut map = Map::new();
                map.insert("_tag".into(), json!("failed"));
                map.insert("version".into(), json!(version));
                map.insert("kind".into(), json!(kind.name()));
                map.insert("why".into(), json!(why));
                if let Some(page) = page.as_deref().filter(|p| !p.is_empty()) {
                    map.insert("page".into(), json!(page));
                }
                Value::Object(map)
            }
        }
    }

    fn busy(&self) -> bool {
        matches!(
            self,
            State::Checking | State::Downloading { .. } | State::Verifying { .. } | State::Ready { .. } | State::Installing { .. }
        )
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

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

pub(super) struct Staged {
    pub(super) version: String,
    pub(super) page: String,
    pub(super) app: PathBuf,
    pub(super) bundle: PathBuf,
}

pub(super) struct Updater {
    pub(super) version: String,
    /// The .app this process runs from.
    pub(super) bundle: Option<PathBuf>,
    /// Where downloads go, a folder a version.
    pub(super) dir: PathBuf,
    pub(super) feed: Feed,
    pub(super) state: Mutex<State>,
    pub(super) tx: watch::Sender<Value>,
    pub(super) staged: Mutex<Option<Staged>>,
    pub(super) etag_cache: EtagCache,
}

// Runs once this process has quit: if the new .app cannot be moved in, the old one goes back.
// Logs errors to `$state_dir/swap.log` and records `$state_dir/swap-failed.txt` for next-launch recovery.
pub(super) const SWAP_SCRIPT: &str = r#"#!/bin/sh
pid="$1"; current="$2"; next="$3"; old="$4"; reopen="$5"; state_dir="$6"; target_version="$7"; page="$8"
fail_file=""
if [ -n "$state_dir" ]; then
  /bin/mkdir -p "$state_dir" 2>/dev/null || true
  fail_file="$state_dir/swap-failed.txt"
  exec >>"$state_dir/swap.log" 2>&1
fi
fail() {
  reason="$1"
  printf 'swap failed (%s): %s\n' "${target_version:-unknown}" "$reason" >&2
  if [ -n "$fail_file" ]; then
    printf '%s\n%s\n%s\n' "$target_version" "$reason" "$page" >"$fail_file" 2>/dev/null || true
  fi
  exit 1
}
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
[ -d "$next" ] || fail "staged bundle is missing"
[ ! -e "$old" ] || fail "previous backup bundle already exists"
mv "$current" "$old" || fail "could not move current app aside"
if ! mv "$next" "$current"; then
  mv "$old" "$current" || true
  fail "could not move updated app into place"
fi
/bin/rm -rf "$old" >/dev/null 2>&1 || true
if [ -n "$fail_file" ]; then /bin/rm -f "$fail_file" >/dev/null 2>&1 || true; fi
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

pub(super) fn recover_swap_failure(dir: &Path, current_version: &str) -> Option<State> {
    let marker = dir.join(SWAP_FAILED_FILE);
    let content = std::fs::read_to_string(&marker).ok()?;
    let _ = std::fs::remove_file(&marker);
    let mut lines = content.lines();
    let target = lines.next().unwrap_or_default().trim();
    let reason = lines.next().unwrap_or_default().trim();
    let page = lines.next().unwrap_or_default().trim();
    if target.is_empty() || target == current_version {
        return None;
    }
    let detail = if reason.is_empty() {
        "could not replace the application bundle"
    } else {
        reason
    };
    Some(State::Failed {
        kind: FailureKind::Install,
        why: format!("Failed to install {target}: {detail}"),
        page: (!page.is_empty()).then(|| page.to_string()),
    })
}

pub(super) async fn cleanup_old_versions(updates_dir: &Path, keep_version: &str) {
    let Ok(mut entries) = tokio::fs::read_dir(updates_dir).await else { return };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let Ok(file_type) = entry.file_type().await else { continue };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name != keep_version && releases::is_version(name) {
            let _ = tokio::fs::remove_dir_all(entry.path()).await;
        }
    }
}

fn leftover_pid(name: &str) -> Option<u32> {
    let rest = name
        .strip_prefix(".VibeValley-update-")
        .or_else(|| name.strip_prefix(".VibeValley-previous-"))?;
    let digits = rest.strip_suffix(".app")?;
    digits.parse::<u32>().ok()
}

async fn process_missing(pid: u32) -> bool {
    let Ok(output) = tokio::process::Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .kill_on_drop(true)
        .output()
        .await
    else {
        return false;
    };
    if output.status.success() {
        return false;
    }
    String::from_utf8_lossy(&output.stderr).contains("No such process")
}

pub(super) async fn cleanup_stale_bundle_leftovers(bundle: &Path) {
    let Some(parent) = bundle.parent() else { return };
    let Ok(mut entries) = tokio::fs::read_dir(parent).await else { return };
    let own_pid = std::process::id();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let Ok(file_type) = entry.file_type().await else { continue };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(pid) = leftover_pid(name) else { continue };
        if pid == own_pid {
            continue;
        }
        if process_missing(pid).await {
            let _ = tokio::fs::remove_dir_all(entry.path()).await;
        }
    }
}

impl Updater {
    pub(super) fn new(version: String, bundle: Option<PathBuf>, dir: PathBuf, feed: Feed) -> Updater {
        let initial = if feed == Feed::Off {
            let _ = recover_swap_failure(&dir, &version);
            State::Disabled
        } else {
            recover_swap_failure(&dir, &version).unwrap_or(State::Idle { checked_at: None })
        };
        let (tx, _) = watch::channel(initial.json(&version));
        Updater {
            version,
            bundle,
            dir,
            feed,
            state: Mutex::new(initial),
            tx,
            staged: Mutex::new(None),
            etag_cache: EtagCache::default(),
        }
    }

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
        let feed = feed_of(asked.as_deref(), plist_feed, bundle.is_some(), &version);
        let dir = crate::hosted::server_home().join("updates");
        Updater::new(version, bundle, dir, feed)
    }

    pub(super) fn state(&self) -> Value {
        self.state.lock().json(&self.version)
    }

    pub(super) fn subscribe(&self) -> watch::Receiver<Value> {
        self.tx.subscribe()
    }

    fn set(&self, next: State) {
        let json = {
            let mut state = self.state.lock();
            if *state == next {
                return;
            }
            let json = next.json(&self.version);
            *state = next;
            json
        };
        // One line a change, for whoever drives the app from outside (scripts/release/update-check.ts).
        eprintln!("update: {json}");
        self.tx.send_replace(json);
    }

    /// Transitions into `Checking` synchronously if a check is allowed, emitting immediately.
    pub(super) fn begin_check(&self) -> bool {
        let json = {
            let mut state = self.state.lock();
            if state.busy() || self.feed == Feed::Off {
                return false;
            }
            *state = State::Checking;
            state.json(&self.version)
        };
        eprintln!("update: {json}");
        self.tx.send_replace(json);
        true
    }

    pub(super) async fn run_check(&self) {
        let settled = self.look().await.unwrap_or_else(|err| State::Failed {
            kind: err.kind,
            why: err.why,
            page: err.page,
        });
        self.set(settled);
    }

    /// The manifest of the latest release this app takes; `None` when there is none yet.
    async fn manifest(&self) -> Result<Option<String>, UpdateError> {
        match &self.feed {
            Feed::Off => Ok(None),
            Feed::Manifest(url) => Ok(Some(url.clone())),
            Feed::Stage(Stage::Stable) => Ok(Some(STABLE_FEED.to_string())),
            Feed::Stage(stage) => {
                let resp = fetch::text_cached(RELEASE_LIST, Some(&self.etag_cache)).await?;
                if resp.status == 403 || resp.status == 429 {
                    return Err(UpdateError::rate_limit(format!("releases: {}", resp.status)));
                }
                if resp.status != 200 {
                    return Err(UpdateError::network(format!("releases: {}", resp.status)));
                }
                let list: Vec<releases::ListedRelease> = serde_json::from_str(&resp.body).map_err(|e| UpdateError::integrity(format!("releases: {e}")))?;
                Ok(releases::manifest_for(&list, *stage))
            }
        }
    }

    /// Asks once; awaits while it downloads. Does nothing while a check runs or an update is ready.
    pub(super) async fn check(&self) {
        if !self.begin_check() {
            return;
        }
        self.run_check().await;
    }

    async fn look(&self) -> Result<State, UpdateError> {
        let Some(feed) = self.manifest().await? else {
            return Ok(State::Idle { checked_at: Some(now_ms()) });
        };
        let resp = fetch::text_cached(&feed, Some(&self.etag_cache)).await?;
        // No release yet.
        if resp.status == 404 {
            return Ok(State::Idle { checked_at: Some(now_ms()) });
        }
        if resp.status == 403 || resp.status == 429 {
            return Err(UpdateError::rate_limit(format!("release.json: {}", resp.status)));
        }
        if resp.status != 200 {
            return Err(UpdateError::network(format!("release.json: {}", resp.status)));
        }
        let release: Release = serde_json::from_str(&resp.body).map_err(|e| UpdateError::integrity(format!("release.json: {e}")))?;
        if !releases::is_version(&release.version) {
            return Err(UpdateError::integrity("release.json: invalid version").with_page(&release.page));
        }
        if !releases::newer(&release.version, &self.version) {
            return Ok(State::Idle { checked_at: Some(now_ms()) });
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
        let url = releases::beside(&feed, &build.file)
            .ok_or_else(|| UpdateError::integrity(format!("{}: not a file beside release.json", build.file)).with_page(&release.page))?;
        let folder = self.dir.join(&release.version);
        let next_for_progress = release.version.clone();
        let next_for_verify = release.version.clone();
        let app = fetch::staged_app(
            &url,
            build,
            &release.version,
            bundle,
            &folder,
            |progress| {
                self.set(State::Downloading {
                    next: next_for_progress.clone(),
                    percent: progress.percent,
                    downloaded_bytes: progress.downloaded_bytes,
                    total_bytes: progress.total_bytes,
                    speed_bps: progress.speed_bps,
                });
            },
            || {
                self.set(State::Verifying { next: next_for_verify });
            },
        )
        .await
        .map_err(|err| err.with_page(&release.page))?;

        cleanup_old_versions(&self.dir, &release.version).await;
        cleanup_stale_bundle_leftovers(bundle).await;

        *self.staged.lock() = Some(Staged {
            version: release.version.clone(),
            page: release.page.clone(),
            app,
            bundle: bundle.clone(),
        });
        Ok(State::Ready {
            next: release.version,
            notes: release.notes,
            page: release.page,
        })
    }

    /// Hands the staged app to the swap script, which waits for this process to go.
    pub(super) async fn swap(&self, reopen: bool) -> bool {
        let Some(staged) = self.staged.lock().take() else { return false };
        let fail = |staged: Staged, kind: FailureKind, why: String| -> bool {
            eprintln!("update: {why}");
            if reopen {
                let page = (!staged.page.is_empty()).then_some(staged.page);
                self.set(State::Failed { kind, why, page });
            } else {
                *self.staged.lock() = Some(staged);
            }
            false
        };
        let Some(parent) = staged.bundle.parent().map(Path::to_path_buf) else {
            return fail(staged, FailureKind::Install, "installed bundle has no parent directory".into());
        };
        if reopen {
            self.set(State::Installing { next: staged.version.clone() });
        }
        let next = parent.join(format!(".VibeValley-update-{}.app", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&next).await;
        let copied = tokio::process::Command::new("/usr/bin/ditto")
            .arg(&staged.app)
            .arg(&next)
            .kill_on_drop(true)
            .output()
            .await;
        match copied {
            Ok(out) if out.status.success() => {}
            Ok(out) => {
                let _ = tokio::fs::remove_dir_all(&next).await;
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                let kind = if stderr.to_ascii_lowercase().contains("permission denied") || stderr.to_ascii_lowercase().contains("read-only") {
                    FailureKind::Permission
                } else {
                    FailureKind::Install
                };
                let why = if stderr.is_empty() {
                    format!("cannot stage beside {}", staged.bundle.display())
                } else {
                    format!("cannot stage beside {}: {stderr}", staged.bundle.display())
                };
                return fail(staged, kind, why);
            }
            Err(e) => {
                let _ = tokio::fs::remove_dir_all(&next).await;
                let kind = if e.kind() == std::io::ErrorKind::PermissionDenied {
                    FailureKind::Permission
                } else {
                    FailureKind::Install
                };
                let why = format!("cannot stage beside {}: {e}", staged.bundle.display());
                return fail(staged, kind, why);
            }
        }
        if let Err(e) = tokio::fs::create_dir_all(&self.dir).await {
            let _ = tokio::fs::remove_dir_all(&next).await;
            return fail(staged, FailureKind::Install, format!("{}: {e}", self.dir.display()));
        }
        let script = self.dir.join("swap.sh");
        if let Err(e) = tokio::fs::write(&script, SWAP_SCRIPT).await {
            let _ = tokio::fs::remove_dir_all(&next).await;
            return fail(staged, FailureKind::Install, format!("{}: {e}", script.display()));
        }
        use std::os::unix::process::CommandExt as _;
        let spawned = std::process::Command::new("/bin/sh")
            .arg(&script)
            .arg(std::process::id().to_string())
            .arg(&staged.bundle)
            .arg(&next)
            .arg(parent.join(format!(".VibeValley-previous-{}.app", std::process::id())))
            .arg(if reopen { "1" } else { "0" })
            .arg(&self.dir)
            .arg(&staged.version)
            .arg(&staged.page)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            // A group of its own: it outlives this process and whatever signal ends it.
            .process_group(0)
            .spawn();
        match spawned {
            Ok(_) => true,
            Err(e) => {
                let _ = tokio::fs::remove_dir_all(&next).await;
                fail(staged, FailureKind::Install, format!("swap: {e}"))
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

pub fn state() -> Value {
    updater().state()
}

pub fn subscribe() -> watch::Receiver<Value> {
    updater().subscribe()
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
        // Non-blocking: transitions to `checking` immediately (if idle/failed/manual) and spawns in background.
        UpdateOp::Check => {
            if updater.begin_check() {
                let running = updater.clone();
                vibevalley_runtime::rt::current_or_global_handle().spawn(async move {
                    running.run_check().await;
                });
            }
            reply.send(Envelope::ok(updater.state()));
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
