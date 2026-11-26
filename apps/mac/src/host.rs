//! Native halves of VibeValley's host capabilities (packages/protocol/src/host.ts).

use std::ffi::{CString, c_char, c_void};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::Value;

pub struct Storage {
    pub database: PathBuf,
    pub views: PathBuf,
}

impl Storage {
    pub fn configured() -> Self {
        Self::for_channel(std::env::var_os("VIBEVALLEY_STORE").as_deref(), vibevalley_protocol::home::current_channel())
    }

    fn for_channel(override_path: Option<&std::ffi::OsStr>, channel: vibevalley_protocol::home::ReleaseChannel) -> Self {
        let database = override_path
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| vibevalley_workspace::Store::default_path_for(channel.app_support_dir_name()));
        let views = if database.file_name() == Some(std::ffi::OsStr::new("state.db")) {
            database.with_file_name("nsh")
        } else {
            database.with_added_extension("nsh")
        };
        Self { database, views }
    }
}

pub fn worktree_file(worktree: &Path, relative: &Path) -> Option<(PathBuf, PathBuf)> {
    if !worktree.is_absolute() || relative.as_os_str().is_empty() || !relative.components().all(|part| matches!(part, std::path::Component::Normal(_))) {
        return None;
    }
    let root = worktree.canonicalize().ok()?;
    let path = root.join(relative).canonicalize().ok()?;
    (path.starts_with(&root) && path.is_file()).then_some((root, path))
}

/// `%XX` escapes of a `file:` URL's path decoded (spaces, CJK names).
pub(crate) fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(hex) = raw.get(i + 1..i + 3)
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Whether this application is currently active in the macOS foreground.
pub fn is_app_active() -> bool {
    use objc2_app_kit::NSApplication;
    use objc2_foundation::MainThreadMarker;

    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    NSApplication::sharedApplication(mtm).isActive()
}

/// True when the running process has a macOS `.app` bundle identifier.
/// `UNUserNotificationCenter::currentNotificationCenter()` throws an ObjC exception
/// if called from an unpackaged binary without a bundle identifier.
fn has_bundle_identifier() -> bool {
    use objc2_foundation::NSBundle;
    NSBundle::mainBundle().bundleIdentifier().is_some()
}

/// Delivers a native macOS notification via `UNUserNotificationCenter` without shelling out.
/// When running unpackaged (no `CFBundleIdentifier`, e.g. `cargo run` / tests), logs instead
/// of invoking `UNUserNotificationCenter` which aborts outside an `.app` bundle.
pub fn notify(title: &str, body: &str) -> Result<(), String> {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest, UNNotificationSound, UNUserNotificationCenter,
    };

    if !has_bundle_identifier() {
        tracing::debug!(target: "vibevalley::host", %title, %body, "skipping UNUserNotificationCenter without bundle identifier");
        return Ok(());
    }

    let center = UNUserNotificationCenter::currentNotificationCenter();
    static AUTH_REQUESTED: OnceLock<()> = OnceLock::new();
    AUTH_REQUESTED.get_or_init(|| {
        let auth_block = RcBlock::new(|_granted: Bool, _err: *mut NSError| {});
        center.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound, &auth_block);
    });

    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    content.setSound(Some(&UNNotificationSound::defaultSound()));

    let id = NSString::from_str(&uuid::Uuid::new_v4().to_string());
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&id, &content, None);

    let (tx, rx) = flume::bounded::<Result<(), String>>(1);
    let completion = RcBlock::new(move |err: *mut NSError| {
        let result = if err.is_null() {
            Ok(())
        } else {
            // SAFETY: macOS passes a valid `NSError` pointer when non-null.
            let desc = unsafe { &*err }.localizedDescription().to_string();
            Err(desc)
        };
        let _ = tx.send(result);
    });
    center.addNotificationRequest_withCompletionHandler(&request, Some(&completion));
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(res) => res,
        Err(_) => Ok(()),
    }
}

/// The largest file `read_file` hands a view.
const MAX_READ: u64 = 50 << 20;
/// Maximum byte count `random_bytes_hex` yields in a single call.
const MAX_RANDOM_BYTES: usize = 4096;

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Lowercase hex SHA-256 digest of UTF-8 `text`.
pub fn sha256_hex(text: &str) -> String {
    use sha2::{Digest as _, Sha256};
    let digest = Sha256::digest(text.as_bytes());
    encode_hex(&digest)
}

/// Generates `length` uniformly random bytes using OS CSPRNG entropy via `uuid::Uuid::new_v4`
/// whitened with SHA-256, returned as lowercase hex.
pub fn random_bytes_hex(length: usize) -> Result<String, String> {
    use sha2::{Digest as _, Sha256};
    if length == 0 || length > MAX_RANDOM_BYTES {
        return Err(format!("randomBytes length must be between 1 and {MAX_RANDOM_BYTES}"));
    }
    let mut bytes = Vec::with_capacity(length);
    while bytes.len() < length {
        let mut hasher = Sha256::new();
        // Three v4 UUIDs carry 366 bits of OS CSPRNG entropy, whitening out the fixed version/variant bits.
        for _ in 0..3 {
            hasher.update(uuid::Uuid::new_v4().as_bytes());
        }
        let block = hasher.finalize();
        let take = (length - bytes.len()).min(block.len());
        bytes.extend_from_slice(&block[..take]);
    }
    Ok(encode_hex(&bytes))
}

/// 256-bit OS CSPRNG seed (64 lowercase hex chars) injected into each hosted view's `host.params`.
pub fn random_seed_hex() -> String {
    random_bytes_hex(32).expect("32 is within MAX_RANDOM_BYTES")
}

/// Decodes a `host.*` wire call once at the boundary into a typed [`vibevalley_protocol::HostOp`].
pub fn decode_host_op(op: &str, payload: Value) -> Result<vibevalley_protocol::HostOp, Box<vibevalley_server::gateway::bridge::Envelope>> {
    use vibevalley_protocol::HostOp;
    use vibevalley_server::gateway::bridge::{BizCode, refusal};

    HostOp::from_wire(op, payload).map_err(|msg| {
        let code = if HostOp::is_known_op(op) {
            BizCode::InvalidInput
        } else {
            BizCode::RouteNotFound
        };
        Box::new(refusal(code, msg))
    })
}

/// Handles fast, stateless host ops (`host.sha256`, `host.randomBytes`, `host.qr`)
/// on either the engine thread or the shell fallback path.
pub fn handle_stateless_op(op: &vibevalley_protocol::HostOp) -> Option<vibevalley_server::gateway::bridge::Envelope> {
    use serde_json::json;
    use vibevalley_protocol::HostOp;
    use vibevalley_server::gateway::bridge::{BizCode, Envelope, refusal};

    match op {
        HostOp::Sha256(req) => Some(Envelope::ok(json!({ "hex": sha256_hex(&req.text) }))),
        HostOp::RandomBytes(req) => Some(match random_bytes_hex(req.length as usize) {
            Ok(hex) => Envelope::ok(json!({ "hex": hex })),
            Err(e) => refusal(BizCode::InvalidInput, e),
        }),
        HostOp::Qr(req) => Some(match crate::qr::encode(&req.text, req.border.unwrap_or(2) as usize) {
            Ok(matrix) => Envelope::ok(json!(matrix)),
            Err(e) => refusal(BizCode::InvalidInput, e),
        }),
        HostOp::Info
        | HostOp::UpdateState
        | HostOp::UpdateCheck
        | HostOp::UpdateInstall
        | HostOp::CliState
        | HostOp::CliInstall
        | HostOp::CliRemove
        | HostOp::Font(_)
        | HostOp::Notify(_)
        | HostOp::Tray(_)
        | HostOp::Locale(_)
        | HostOp::Reveal(_)
        | HostOp::Theme(_)
        | HostOp::Motion(_)
        | HostOp::Opening(_)
        | HostOp::OpenTerminal(_)
        | HostOp::OpenUrl(_)
        | HostOp::OpenFile(_)
        | HostOp::PickFile
        | HostOp::PickFolder
        | HostOp::SaveFile(_)
        | HostOp::SpeechState(_)
        | HostOp::SpeechStart(_)
        | HostOp::SpeechStop(_)
        | HostOp::VoiceState(_)
        | HostOp::VoiceStart(_)
        | HostOp::VoiceStop(_)
        | HostOp::VoiceMute(_)
        | HostOp::PlayAudio(_)
        | HostOp::PlaySound(_)
        | HostOp::SeekAudio(_)
        | HostOp::AudioState
        | HostOp::PcmStart(_)
        | HostOp::PcmAppend(_)
        | HostOp::StopAudio
        | HostOp::ReadFile(_)
        | HostOp::AssetsDir
        | HostOp::AppletList
        | HostOp::AppletInstall(_)
        | HostOp::AppletUninstall(_)
        | HostOp::AppletOpen(_)
        | HostOp::CaptureWebView(_)
        | HostOp::VdpDiscover(_)
        | HostOp::VdpCall(_) => None,
    }
}

/// A regular file's bytes as base64, with its name and a type guessed from
/// its extension.
pub fn read_file(path: &Path) -> Result<Value, String> {
    use base64::Engine as _;
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    if meta.len() > MAX_READ {
        return Err(format!("{} is larger than 50 MB", path.display()));
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let info = file_info(path)?;
    Ok(serde_json::json!({ "data": base64::engine::general_purpose::STANDARD.encode(&bytes), "type": info.kind, "name": info.name }))
}

pub use vibevalley_protocol::HostLocalFile as LocalFile;
pub use vibevalley_protocol::HostLocalFolder as LocalFolder;

pub fn folder_info(path: &Path) -> Result<LocalFolder, String> {
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if !path.is_absolute() || !metadata.is_dir() {
        return Err("a local folder must be an absolute path to a directory".into());
    }
    let canon = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let name = canon.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let git = canon.join(".git").exists();
    Ok(LocalFolder {
        path: canon.to_string_lossy().into_owned(),
        name,
        git,
    })
}

pub fn file_info(path: &Path) -> Result<LocalFile, String> {
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if !path.is_absolute() || !metadata.is_file() {
        return Err("a local file must be an absolute path to a regular file".into());
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let kind = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        "ogg" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    };
    Ok(LocalFile {
        path: path.to_string_lossy().into_owned(),
        name,
        kind: kind.to_owned(),
        size: metadata.len(),
    })
}

pub fn copy_file(source: &Path, target: &Path) -> Result<(), String> {
    file_info(source)?;
    if !target.is_absolute() {
        return Err("save destination must be absolute".into());
    }
    if source == target || matches!((source.canonicalize(), target.canonicalize()), (Ok(a), Ok(b)) if a == b) {
        return Err("source and destination are the same file".into());
    }
    std::fs::copy(source, target).map_err(|e| e.to_string())?;
    Ok(())
}

/// Opens `path` in its default macOS app via `NSWorkspace` without spawning `/usr/bin/open`.
pub fn open(path: &Path) -> Result<(), String> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};

    if !path.exists() {
        return Err(format!("path does not exist: {}", path.display()));
    }
    let ns_path = NSString::from_str(&path.to_string_lossy());
    let url = NSURL::fileURLWithPath(&ns_path);
    if NSWorkspace::sharedWorkspace().openURL(&url) {
        Ok(())
    } else {
        Err(format!("NSWorkspace failed to open {}", path.display()))
    }
}

/// Reveals `path` in Finder via `NSWorkspace` without spawning `/usr/bin/open -R`.
pub fn reveal(path: &Path) -> Result<(), String> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSArray, NSString, NSURL};

    if !path.exists() {
        return Err(format!("path does not exist: {}", path.display()));
    }
    let ns_path = NSString::from_str(&path.to_string_lossy());
    let url = NSURL::fileURLWithPath(&ns_path);
    let urls = NSArray::from_retained_slice(&[url]);
    NSWorkspace::sharedWorkspace().activateFileViewerSelectingURLs(&urls);
    Ok(())
}

/// Destination for opening a workspace file from the native viewer / Markdown toolbar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditorTarget {
    Cursor { app_path: PathBuf },
    VsCode { app_path: PathBuf },
    Zed { app_path: PathBuf },
    TerminalEditor,
    DefaultApp,
}

impl EditorTarget {
    pub fn is_gui(&self) -> bool {
        matches!(self, EditorTarget::Cursor { .. } | EditorTarget::VsCode { .. } | EditorTarget::Zed { .. })
    }
}

/// Menu row shown inside the native "Open in editor" popover.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorOption {
    pub target: EditorTarget,
    pub label: String,
    pub subtitle: Option<String>,
}

static DETECTED_GUI_EDITORS: parking_lot::RwLock<Option<Vec<EditorOption>>> = parking_lot::RwLock::new(None);
static EDITOR_WARM_STARTED: AtomicBool = AtomicBool::new(false);

fn resolve_editor_basename(editor_env: Option<&str>) -> String {
    let raw = editor_env.unwrap_or_default().trim();
    let token = raw.split_whitespace().next().unwrap_or_default().trim_matches(['"', '\'']);
    let base = Path::new(token).file_name().and_then(|n| n.to_str()).unwrap_or_default().trim();
    if base.is_empty() { "vi".to_string() } else { base.to_string() }
}

fn build_editor_options(mut gui_editors: Vec<EditorOption>, editor_env: Option<&str>) -> Vec<EditorOption> {
    gui_editors.push(EditorOption {
        target: EditorTarget::TerminalEditor,
        label: "Terminal ($EDITOR)".to_string(),
        subtitle: Some(resolve_editor_basename(editor_env)),
    });
    gui_editors.push(EditorOption {
        target: EditorTarget::DefaultApp,
        label: "Default App".to_string(),
        subtitle: Some("macOS".to_string()),
    });
    gui_editors
}

fn find_app_by_bundle_id(bundle_id: &str) -> Option<PathBuf> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::NSString;

    let ns_id = NSString::from_str(bundle_id);
    let url = NSWorkspace::sharedWorkspace().URLForApplicationWithBundleIdentifier(&ns_id)?;
    let path = PathBuf::from(url.path()?.to_string());
    path.exists().then_some(path)
}

fn probe_gui_editors_with(bundle_lookup: impl Fn(&str) -> Option<PathBuf>, path_exists: impl Fn(&Path) -> bool, home: Option<&Path>) -> Vec<EditorOption> {
    let fallback_dirs = |app_name: &str| -> Vec<PathBuf> {
        let mut paths = vec![PathBuf::from("/Applications").join(app_name)];
        if let Some(h) = home {
            paths.push(h.join("Applications").join(app_name));
        }
        paths
    };

    let resolve = |bundles: &[(&str, Option<&str>)], app_names: &[(&str, Option<&str>)]| -> Option<(PathBuf, Option<String>)> {
        for &(bundle_id, tag) in bundles {
            if let Some(path) = bundle_lookup(bundle_id) {
                return Some((path, tag.map(str::to_string)));
            }
        }
        for &(app_name, tag) in app_names {
            for candidate in fallback_dirs(app_name) {
                if path_exists(&candidate) {
                    return Some((candidate, tag.map(str::to_string)));
                }
            }
        }
        None
    };

    let mut found = Vec::new();
    if let Some((app_path, subtitle)) = resolve(&[("com.todesktop.230313mzl4w4u92", None)], &[("Cursor.app", None)]) {
        found.push(EditorOption {
            target: EditorTarget::Cursor { app_path },
            label: "Cursor".to_string(),
            subtitle,
        });
    }
    if let Some((app_path, subtitle)) = resolve(
        &[("com.microsoft.VSCode", None), ("com.microsoft.VSCodeInsiders", Some("Insiders"))],
        &[("Visual Studio Code.app", None), ("Visual Studio Code - Insiders.app", Some("Insiders"))],
    ) {
        found.push(EditorOption {
            target: EditorTarget::VsCode { app_path },
            label: "VS Code".to_string(),
            subtitle,
        });
    }
    if let Some((app_path, subtitle)) = resolve(
        &[("dev.zed.Zed", None), ("dev.zed.Zed-Preview", Some("Preview"))],
        &[("Zed.app", None), ("Zed Preview.app", Some("Preview"))],
    ) {
        found.push(EditorOption {
            target: EditorTarget::Zed { app_path },
            label: "Zed".to_string(),
            subtitle,
        });
    }
    found
}

/// Returns the currently cached editor list immediately without touching LaunchServices or the filesystem.
/// Triggers a one-time background probe when the cache has not been populated yet.
/// Safe to call on the GPUI UI thread.
pub fn cached_editor_options() -> Vec<EditorOption> {
    let cached = DETECTED_GUI_EDITORS.read().clone();
    if cached.is_none() {
        warm_editor_cache();
    }
    build_editor_options(cached.unwrap_or_default(), std::env::var("EDITOR").ok().as_deref())
}

/// Probes installed macOS GUI editors (Cursor, VS Code, Zed) via LaunchServices + standard
/// `/Applications` fallbacks, updates the process cache, and returns the full ordered option list.
/// Blocking: must be called off the GPUI UI thread.
pub fn detect_editors_blocking() -> Vec<EditorOption> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let gui = probe_gui_editors_with(find_app_by_bundle_id, Path::exists, home.as_deref());
    *DETECTED_GUI_EDITORS.write() = Some(gui.clone());
    build_editor_options(gui, std::env::var("EDITOR").ok().as_deref())
}

/// Kicks off a one-time background probe on the shared Tokio blocking pool so the editor cache is warm.
pub fn warm_editor_cache() {
    if DETECTED_GUI_EDITORS.read().is_some() || EDITOR_WARM_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    vibevalley_runtime::rt::current_or_global_handle().spawn_blocking(|| {
        let _ = detect_editors_blocking();
    });
}

/// Launches `path` inside a specific macOS `.app` bundle via `/usr/bin/open -a <app_path> <path>`.
/// Blocking: must be called off the GPUI UI thread.
pub fn open_with_app(app_path: &Path, path: &Path) -> Result<(), String> {
    if !app_path.exists() {
        return Err(format!("editor application does not exist: {}", app_path.display()));
    }
    if !path.exists() {
        return Err(format!("path does not exist: {}", path.display()));
    }
    let status = std::process::Command::new("/usr/bin/open")
        .arg("-a")
        .arg(app_path)
        .arg(path)
        .status()
        .map_err(|e| format!("failed to launch {}: {e}", app_path.display()))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("/usr/bin/open exited with {status} for {}", app_path.display()))
    }
}

/// System lifecycle events observed natively via `NSWorkspace` and `Network.framework`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SystemEvent {
    /// macOS woke from sleep (`NSWorkspaceDidWakeNotification`).
    Wake,
    /// Network interface or path status changed (`nw_path_monitor`).
    NetworkChanged { reachable: bool },
}

#[link(name = "Network", kind = "framework")]
unsafe extern "C" {
    fn nw_path_monitor_create() -> *mut c_void;
    fn nw_path_monitor_set_update_handler(monitor: *mut c_void, handler: &block2::DynBlock<dyn Fn(*mut c_void)>);
    fn nw_path_monitor_set_queue(monitor: *mut c_void, queue: *mut c_void);
    fn nw_path_monitor_start(monitor: *mut c_void);
    fn nw_path_monitor_cancel(monitor: *mut c_void);
    fn nw_path_get_status(path: *mut c_void) -> i32;
    fn nw_release(obj: *mut c_void);
}

unsafe extern "C" {
    fn dispatch_queue_create(label: *const c_char, attr: *const c_void) -> *mut c_void;
    fn dispatch_release(obj: *mut c_void);
}

const NW_PATH_STATUS_SATISFIED: i32 = 1;

/// RAII handle that keeps native macOS sleep/wake (`NSWorkspaceDidWakeNotification`)
/// and network-change (`nw_path_monitor`) observers registered until dropped.
pub struct SystemObserver {
    wake_token: *mut objc2::runtime::AnyObject,
    monitor: *mut c_void,
    queue: *mut c_void,
    _wake_block: block2::RcBlock<dyn Fn(NonNull<objc2_foundation::NSNotification>)>,
    _net_block: block2::RcBlock<dyn Fn(*mut c_void)>,
}

// SAFETY: `NSNotificationCenter::removeObserver`, `nw_path_monitor_cancel`, `nw_release`,
// and `dispatch_release` are thread-safe Apple APIs, and the observer pointers are never
// dereferenced concurrently outside `Drop`.
unsafe impl Send for SystemObserver {}

impl Drop for SystemObserver {
    fn drop(&mut self) {
        use objc2::rc::Retained;
        use objc2_app_kit::NSWorkspace;

        if !self.wake_token.is_null() {
            // SAFETY: `wake_token` is a retained observer token returned by `addObserverForName`.
            unsafe {
                let token = Retained::from_raw(self.wake_token);
                if let Some(token) = token {
                    NSWorkspace::sharedWorkspace().notificationCenter().removeObserver(&token);
                }
            }
            self.wake_token = std::ptr::null_mut();
        }
        if !self.monitor.is_null() {
            // SAFETY: `monitor` was created by `nw_path_monitor_create` and owned exclusively here.
            unsafe {
                nw_path_monitor_cancel(self.monitor);
                nw_release(self.monitor);
            }
            self.monitor = std::ptr::null_mut();
        }
        if !self.queue.is_null() {
            // SAFETY: `queue` was created by `dispatch_queue_create` and owned exclusively here.
            unsafe {
                dispatch_release(self.queue);
            }
            self.queue = std::ptr::null_mut();
        }
    }
}

/// Registers native macOS sleep/wake (`NSWorkspaceDidWakeNotification`) and
/// network-path (`nw_path_monitor`) observers, invoking `on_event` on each event.
fn observe_system_events(on_event: impl Fn(SystemEvent) + Send + Sync + 'static) -> SystemObserver {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification};
    use objc2_foundation::NSNotification;

    let callback: Arc<dyn Fn(SystemEvent) + Send + Sync> = Arc::new(on_event);
    let wake_cb = callback.clone();
    let wake_block = RcBlock::new(move |_notif: NonNull<NSNotification>| {
        wake_cb(SystemEvent::Wake);
    });

    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    // SAFETY: `wake_block` is a valid sendable Objective-C block and `NSWorkspaceDidWakeNotification`
    // is a static notification name from AppKit.
    let token = unsafe { center.addObserverForName_object_queue_usingBlock(Some(NSWorkspaceDidWakeNotification), None, None, &wake_block) };
    let wake_token = Retained::into_raw(token).cast::<objc2::runtime::AnyObject>();

    let initial_seen = Arc::new(AtomicBool::new(false));
    let net_cb = callback;
    let net_block = RcBlock::new(move |path: *mut c_void| {
        let status = if path.is_null() {
            0
        } else {
            // SAFETY: `nw_path_monitor` passes a valid `nw_path_t` for the duration of the callback.
            unsafe { nw_path_get_status(path) }
        };
        // Skip the immediate baseline snapshot delivered right after `nw_path_monitor_start`.
        if !initial_seen.swap(true, Ordering::SeqCst) {
            return;
        }
        net_cb(SystemEvent::NetworkChanged {
            reachable: status == NW_PATH_STATUS_SATISFIED,
        });
    });

    // SAFETY: `nw_path_monitor_create` and `dispatch_queue_create` return retained OS objects
    // released in `SystemObserver::drop`.
    let (monitor, queue) = unsafe {
        let monitor = nw_path_monitor_create();
        let queue = dispatch_queue_create(c"dev.vibevalley.app.net-monitor".as_ptr(), std::ptr::null());
        if !monitor.is_null() && !queue.is_null() {
            nw_path_monitor_set_update_handler(monitor, &net_block);
            nw_path_monitor_set_queue(monitor, queue);
            nw_path_monitor_start(monitor);
        }
        (monitor, queue)
    };

    SystemObserver {
        wake_token,
        monitor,
        queue,
        _wake_block: wake_block,
        _net_block: net_block,
    }
}

/// Convenience hook for wiring macOS wake and network-recovery events directly into
/// `Hub::on_system_wake()`.
pub fn observe_system_wake(on_wake: impl Fn() + Send + Sync + 'static) -> SystemObserver {
    observe_system_events(move |event| match event {
        SystemEvent::Wake | SystemEvent::NetworkChanged { reachable: true } => on_wake(),
        SystemEvent::NetworkChanged { reachable: false } => {}
    })
}

// ---- macOS Unified Logging (`os_log`) tracing layer -------------------------

const OS_LOG_TYPE_DEFAULT: u8 = 0x00;
const OS_LOG_TYPE_INFO: u8 = 0x01;
const OS_LOG_TYPE_DEBUG: u8 = 0x02;
const OS_LOG_TYPE_ERROR: u8 = 0x10;

unsafe extern "C" {
    static __dso_handle: u8;
    fn os_log_create(subsystem: *const c_char, category: *const c_char) -> *mut c_void;
    fn os_log_type_enabled(log: *mut c_void, log_type: u8) -> bool;
    fn _os_log_internal(dso: *const c_void, log: *mut c_void, log_type: u8, format: *const c_char, ...);
}

#[derive(Clone, Copy)]
struct OsLogHandle(*mut c_void);

// SAFETY: `os_log_t` objects returned by `os_log_create` are global, immutable, immortal,
// and documented by Apple to be safe for concurrent use across threads.
unsafe impl Send for OsLogHandle {}
unsafe impl Sync for OsLogHandle {}

const OSLOG_CATEGORIES: [&std::ffi::CStr; 8] = [c"mac", c"server", c"runtime", c"core", c"git", c"files", c"rich", c"app"];

fn oslog_category_index(target: &str) -> usize {
    if target.starts_with("vibevalley_mac") || target.starts_with("vibevalley::host") {
        0
    } else if target.starts_with("vibevalley_server") {
        1
    } else if target.starts_with("vibevalley_runtime") {
        2
    } else if target.starts_with("vibevalley_core") {
        3
    } else if target.starts_with("vibevalley_git") {
        4
    } else if target.starts_with("vibevalley_files") {
        5
    } else if target.starts_with("vibevalley_rich") {
        6
    } else {
        7
    }
}

fn oslog_handles() -> &'static [OsLogHandle; 8] {
    static HANDLES: OnceLock<[OsLogHandle; 8]> = OnceLock::new();
    HANDLES.get_or_init(|| {
        // Bounded static set of categories: Apple's `os_log_create` objects are never freed.
        OSLOG_CATEGORIES.map(|cat| {
            // SAFETY: both subsystem and category are static NUL-terminated C strings.
            OsLogHandle(unsafe { os_log_create(c"dev.vibevalley.app".as_ptr(), cat.as_ptr()) })
        })
    })
}

fn oslog_type_for(level: &tracing::Level) -> u8 {
    match *level {
        tracing::Level::ERROR => OS_LOG_TYPE_ERROR,
        tracing::Level::WARN => OS_LOG_TYPE_DEFAULT,
        tracing::Level::INFO => OS_LOG_TYPE_INFO,
        tracing::Level::DEBUG | tracing::Level::TRACE => OS_LOG_TYPE_DEBUG,
    }
}

struct OsLogVisitor {
    message: String,
    fields: String,
}

impl OsLogVisitor {
    fn new() -> Self {
        Self {
            message: String::new(),
            fields: String::new(),
        }
    }

    fn finish(self, target: &str) -> String {
        let mut out = String::with_capacity(target.len() + self.message.len() + self.fields.len() + 4);
        out.push_str(target);
        if !self.message.is_empty() {
            out.push_str(": ");
            out.push_str(&self.message);
        }
        if !self.fields.is_empty() {
            out.push(' ');
            out.push_str(&self.fields);
        }
        out
    }
}

impl tracing::field::Visit for OsLogVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.message, "{value:?}");
        } else {
            if !self.fields.is_empty() {
                self.fields.push(' ');
            }
            let _ = write!(self.fields, "{}={value:?}", field.name());
        }
    }

    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" {
            self.message.push_str(value);
        } else {
            if !self.fields.is_empty() {
                self.fields.push(' ');
            }
            let _ = write!(self.fields, "{}={value}", field.name());
        }
    }
}

/// Lightweight `tracing_subscriber::Layer` routing events to macOS Unified Logging
/// (`Console.app` / `log stream --predicate 'subsystem == "dev.vibevalley.app"'`).
pub struct OsLogLayer;

impl OsLogLayer {
    pub fn new() -> Self {
        let _ = oslog_handles();
        Self
    }
}

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for OsLogLayer {
    fn on_event(&self, event: &tracing::Event<'_>, _ctx: tracing_subscriber::layer::Context<'_, S>) {
        let meta = event.metadata();
        let log_type = oslog_type_for(meta.level());
        let handle = oslog_handles()[oslog_category_index(meta.target())].0;
        if handle.is_null() {
            return;
        }
        // SAFETY: `handle` is a valid immortal `os_log_t` created by `os_log_create`.
        if !unsafe { os_log_type_enabled(handle, log_type) } {
            return;
        }
        let mut visitor = OsLogVisitor::new();
        event.record(&mut visitor);
        let formatted = visitor.finish(meta.target()).replace('\0', " ");
        let Ok(c_msg) = CString::new(formatted) else {
            return;
        };
        // SAFETY: `__dso_handle`, `handle`, format string, and `c_msg` are all valid pointers for this call.
        unsafe {
            _os_log_internal(
                (&raw const __dso_handle).cast::<c_void>(),
                handle,
                log_type,
                c"%{public}s".as_ptr(),
                c_msg.as_ptr(),
            );
        }
    }
}

fn channel_icon_names(channel: vibevalley_protocol::home::ReleaseChannel) -> (&'static str, &'static str) {
    use vibevalley_protocol::home::ReleaseChannel;
    match channel {
        ReleaseChannel::Release => ("icon.icns", "appicon-release.png"),
        ReleaseChannel::Beta => ("icon-beta.icns", "appicon-beta.png"),
        ReleaseChannel::Alpha => ("icon-alpha.icns", "appicon-alpha.png"),
        ReleaseChannel::Dev => ("icon-dev.icns", "appicon-dev.png"),
    }
}

fn bundled_resources_icon(exe: Option<&Path>) -> Option<PathBuf> {
    let macos = exe?.parent()?;
    if macos.file_name() != Some(std::ffi::OsStr::new("MacOS")) {
        return None;
    }
    let contents = macos.parent()?;
    if contents.file_name() != Some(std::ffi::OsStr::new("Contents")) {
        return None;
    }
    let bundle = contents.parent()?;
    let is_app = bundle.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("app"));
    is_app.then(|| contents.join("Resources/icon.icns"))
}

fn app_icon_candidates(channel: vibevalley_protocol::home::ReleaseChannel, exe: Option<&Path>, manifest_dir: &Path, assets_dir: &Path) -> Vec<PathBuf> {
    let (icns, appicon_png) = channel_icon_names(channel);
    let mut candidates = Vec::with_capacity(5);
    if let Some(bundled) = bundled_resources_icon(exe) {
        candidates.push(bundled);
    }
    candidates.push(manifest_dir.join("resources").join(icns));
    candidates.push(manifest_dir.join("resources").join(appicon_png));
    if icns != "icon.icns" {
        candidates.push(manifest_dir.join("resources/icon.icns"));
    }
    candidates.push(assets_dir.join("icons/app-256.png"));
    candidates
}

/// Sets the macOS Dock / Command-Tab icon for the active release channel so
/// launching unpackaged binaries or `.app` bundles shows the matching logo.
pub fn set_app_icon() {
    use objc2::AnyThread as _;
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy, NSImage};
    use objc2_foundation::{MainThreadMarker, NSString};

    let Some(mtm) = MainThreadMarker::new() else { return };
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    let exe = std::env::current_exe().ok();
    let dir = crate::assets::assets_dir();
    let candidate = app_icon_candidates(
        vibevalley_protocol::home::current_channel(),
        exe.as_deref(),
        Path::new(env!("CARGO_MANIFEST_DIR")),
        &dir,
    )
    .into_iter()
    .find(|p| p.is_file());
    if let Some(path) = candidate {
        let file = NSString::from_str(&path.to_string_lossy());
        if let Some(image) = NSImage::initWithContentsOfFile(NSImage::alloc(), &file) {
            unsafe {
                app.setApplicationIconImage(Some(&image));
            }
        }
    }
    #[allow(deprecated)]
    app.activateIgnoringOtherApps(true);
}

/// Returns macOS keyboard focus from an embedded native child view (such as a
/// `WKWebView`) back to GPUI's `contentView` when the user clicks a GPUI surface.
pub fn restore_window_first_responder() {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::NSApplication;
    use objc2_foundation::MainThreadMarker;

    let Some(mtm) = MainThreadMarker::new() else { return };
    let app = NSApplication::sharedApplication(mtm);
    unsafe {
        let win: *mut AnyObject = msg_send![&*app, keyWindow];
        if win.is_null() {
            return;
        }
        let content: *mut AnyObject = msg_send![win, contentView];
        let first: *mut AnyObject = msg_send![win, firstResponder];
        if !content.is_null() && first != content {
            let _: bool = msg_send![win, makeFirstResponder: content];
        }
    }
}

const APPLE_FONT_SMOOTHING_KEY: &str = "AppleFontSmoothing";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CfPrefValue {
    Unset,
    Int(i64),
    Other,
}

/// Reads a preference via the exact `CFPreferencesCopyAppValue` lookup
/// `gpui-fast-apple` uses for `AppleFontSmoothing`.
fn cf_app_pref(key: &str) -> CfPrefValue {
    use objc2_foundation::NSString;

    const K_CF_NUMBER_SINT64_TYPE: isize = 4;

    unsafe extern "C" {
        static kCFPreferencesCurrentApplication: *const c_void;
        fn CFPreferencesCopyAppValue(key: *const c_void, application_id: *const c_void) -> *const c_void;
        fn CFGetTypeID(cf: *const c_void) -> usize;
        fn CFNumberGetTypeID() -> usize;
        fn CFNumberGetValue(number: *const c_void, the_type: isize, value_ptr: *mut c_void) -> bool;
        fn CFRelease(cf: *const c_void);
    }

    let ns_key = NSString::from_str(key);
    // SAFETY: `NSString` is toll-free bridged to `CFStringRef` and `value` is released before returning.
    unsafe {
        let value = CFPreferencesCopyAppValue((&*ns_key as *const NSString).cast::<c_void>(), kCFPreferencesCurrentApplication);
        if value.is_null() {
            return CfPrefValue::Unset;
        }
        let result = if CFGetTypeID(value) == CFNumberGetTypeID() {
            let mut out = 0i64;
            if CFNumberGetValue(value, K_CF_NUMBER_SINT64_TYPE, (&raw mut out).cast::<c_void>()) {
                CfPrefValue::Int(out)
            } else {
                CfPrefValue::Other
            }
        } else {
            CfPrefValue::Other
        };
        CFRelease(value);
        result
    }
}

fn disable_default_font_smoothing_for(key: &str) {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    if cf_app_pref(key) != CfPrefValue::Unset {
        return;
    }
    let ns_key = NSString::from_str(key);
    // Register in-memory only (`NSRegistrationDomain`) so nothing is written to the user's plist
    // while `CFPreferencesCopyAppValue` observes `0` unless explicitly overridden.
    unsafe {
        let defaults: *mut AnyObject = msg_send![class!(NSUserDefaults), standardUserDefaults];
        let zero: *mut AnyObject = msg_send![class!(NSNumber), numberWithLongLong: 0i64];
        let dict: *mut AnyObject = msg_send![class!(NSDictionary), dictionaryWithObject: zero, forKey: &*ns_key];
        let _: () = msg_send![defaults, registerDefaults: dict];
    }
}

/// Disables CoreGraphics' default font-smoothing stroke dilation (10–22% heavier ink)
/// in-memory before GPUI initializes its text system, while preserving any explicit
/// CLI `-AppleFontSmoothing` or `defaults` preference.
pub fn disable_default_font_smoothing() {
    disable_default_font_smoothing_for(APPLE_FONT_SMOOTHING_KEY);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regression_conflict_files_open_only_inside_the_issue_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("issue");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("file.ts"), "branch").unwrap();
        std::fs::write(dir.path().join("file.ts"), "main").unwrap();
        assert_eq!(
            worktree_file(&root, Path::new("file.ts")).unwrap().1,
            root.join("file.ts").canonicalize().unwrap()
        );
        assert!(worktree_file(&root, Path::new("../file.ts")).is_none());
        assert!(worktree_file(&root, &dir.path().join("file.ts")).is_none());
        assert!(worktree_file(&root, Path::new("deleted.ts")).is_none());
        std::os::unix::fs::symlink(dir.path().join("file.ts"), root.join("link")).unwrap();
        assert!(worktree_file(&root, Path::new("link")).is_none());
    }

    #[test]
    fn regression_hosted_views_use_the_same_directory_as_the_host_store() {
        use std::ffi::OsStr;
        use vibevalley_protocol::home::ReleaseChannel;

        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("host.db");
        let paths = Storage::for_channel(Some(state.as_os_str()), ReleaseChannel::Release);
        assert_eq!(paths.database, state);
        assert_eq!(paths.views, root.path().join("host.db.nsh"));
        let sibling = Storage::for_channel(Some(root.path().join("other.db").as_os_str()), ReleaseChannel::Alpha);
        assert_eq!(sibling.views, root.path().join("other.db.nsh"));
        let isolated = Storage::for_channel(Some(root.path().join("state.db").as_os_str()), ReleaseChannel::Dev);
        assert_eq!(isolated.views, root.path().join("nsh"));
        let empty_override = Storage::for_channel(Some(OsStr::new("")), ReleaseChannel::Alpha);
        assert!(empty_override.database.ends_with("Library/Application Support/VibeValley-alpha/state.db"));
        assert!(empty_override.views.ends_with("Library/Application Support/VibeValley-alpha/nsh"));

        for (channel, dir_name) in [
            (ReleaseChannel::Release, "VibeValley"),
            (ReleaseChannel::Beta, "VibeValley-beta"),
            (ReleaseChannel::Alpha, "VibeValley-alpha"),
            (ReleaseChannel::Dev, "VibeValley-dev"),
        ] {
            let storage = Storage::for_channel(None, channel);
            assert!(
                storage.database.ends_with(format!("Library/Application Support/{dir_name}/state.db")),
                "unexpected db path for {channel:?}: {}",
                storage.database.display()
            );
            assert!(
                storage.views.ends_with(format!("Library/Application Support/{dir_name}/nsh")),
                "unexpected views path for {channel:?}: {}",
                storage.views.display()
            );
        }
    }

    #[test]
    fn app_icon_candidates_prefer_bundle_then_channel_then_fallback() {
        use vibevalley_protocol::home::ReleaseChannel;

        let manifest = Path::new("/repo/apps/mac");
        let assets = Path::new("/repo/assets");

        let bundled = app_icon_candidates(
            ReleaseChannel::Alpha,
            Some(Path::new("/Applications/VibeValley.app/Contents/MacOS/vibevalley-mac")),
            manifest,
            assets,
        );
        assert_eq!(
            bundled,
            vec![
                PathBuf::from("/Applications/VibeValley.app/Contents/Resources/icon.icns"),
                PathBuf::from("/repo/apps/mac/resources/icon-alpha.icns"),
                PathBuf::from("/repo/apps/mac/resources/appicon-alpha.png"),
                PathBuf::from("/repo/apps/mac/resources/icon.icns"),
                PathBuf::from("/repo/assets/icons/app-256.png"),
            ]
        );

        let dev = app_icon_candidates(ReleaseChannel::Dev, Some(Path::new("/repo/target/debug/vibevalley-mac")), manifest, assets);
        assert_eq!(
            dev,
            vec![
                PathBuf::from("/repo/apps/mac/resources/icon-dev.icns"),
                PathBuf::from("/repo/apps/mac/resources/appicon-dev.png"),
                PathBuf::from("/repo/apps/mac/resources/icon.icns"),
                PathBuf::from("/repo/assets/icons/app-256.png"),
            ]
        );

        let beta = app_icon_candidates(ReleaseChannel::Beta, None, manifest, assets);
        assert_eq!(beta[0], PathBuf::from("/repo/apps/mac/resources/icon-beta.icns"));
        assert_eq!(beta[1], PathBuf::from("/repo/apps/mac/resources/appicon-beta.png"));

        let release = app_icon_candidates(ReleaseChannel::Release, None, manifest, assets);
        assert_eq!(
            release,
            vec![
                PathBuf::from("/repo/apps/mac/resources/icon.icns"),
                PathBuf::from("/repo/apps/mac/resources/appicon-release.png"),
                PathBuf::from("/repo/assets/icons/app-256.png"),
            ]
        );
    }

    #[test]
    fn native_notify_open_and_reveal_validate_safely_without_shell_outs() {
        // Test binaries have no `.app` bundle identifier, so `notify` must not crash on
        // `UNUserNotificationCenter::currentNotificationCenter()`.
        assert!(!has_bundle_identifier());
        assert!(notify("VibeValley", "Task completed").is_ok());

        let missing = Path::new("/nonexistent/vibevalley-missing-file");
        assert!(open(missing).is_err());
        assert!(reveal(missing).is_err());
    }

    #[test]
    fn system_observer_receives_wake_notifications_and_unregisters_on_drop() {
        use std::sync::atomic::AtomicUsize;

        use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification};

        let wakes = Arc::new(AtomicUsize::new(0));
        let wakes_cb = wakes.clone();
        let observer = observe_system_wake(move || {
            wakes_cb.fetch_add(1, Ordering::SeqCst);
        });

        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        // SAFETY: posting a synthetic `NSWorkspaceDidWakeNotification` exercises our real observer block.
        unsafe {
            center.postNotificationName_object(NSWorkspaceDidWakeNotification, None);
        }
        assert_eq!(wakes.load(Ordering::SeqCst), 1);

        drop(observer);
        unsafe {
            center.postNotificationName_object(NSWorkspaceDidWakeNotification, None);
        }
        assert_eq!(wakes.load(Ordering::SeqCst), 1, "observer must unregister on drop");
    }

    #[test]
    fn oslog_layer_maps_categories_levels_and_emits_events() {
        use tracing_subscriber::layer::SubscriberExt as _;

        assert_eq!(oslog_category_index("vibevalley_mac::shell"), 0);
        assert_eq!(oslog_category_index("vibevalley_server::hub"), 1);
        assert_eq!(oslog_category_index("vibevalley_runtime::oar"), 2);
        assert_eq!(oslog_category_index("other::crate"), 7);
        assert_eq!(oslog_type_for(&tracing::Level::ERROR), OS_LOG_TYPE_ERROR);
        assert_eq!(oslog_type_for(&tracing::Level::WARN), OS_LOG_TYPE_DEFAULT);
        assert_eq!(oslog_type_for(&tracing::Level::INFO), OS_LOG_TYPE_INFO);
        assert_eq!(oslog_type_for(&tracing::Level::DEBUG), OS_LOG_TYPE_DEBUG);

        let subscriber = tracing_subscriber::registry().with(OsLogLayer::new());
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(target: "vibevalley_mac::test", count = 3, "unified logging smoke test");
        });
    }

    #[test]
    fn read_file_gives_bytes_name_and_type_and_refuses_folders() {
        use base64::Engine as _;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("截图 1.png");
        std::fs::write(&file, b"\x89PNG").unwrap();
        let v = read_file(&file).unwrap();
        assert_eq!(v["type"], "image/png");
        assert_eq!(v["name"], "截图 1.png");
        assert_eq!(
            base64::engine::general_purpose::STANDARD.decode(v["data"].as_str().unwrap()).unwrap(),
            b"\x89PNG"
        );
        assert!(read_file(dir.path()).is_err());
        assert!(read_file(&dir.path().join("nope")).is_err());
    }

    #[test]
    fn sha256_and_random_bytes_and_stateless_host_ops() {
        assert_eq!(sha256_hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let a = random_bytes_hex(16).unwrap();
        let b = random_bytes_hex(16).unwrap();
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
        assert_eq!(random_seed_hex().len(), 64);
        assert!(random_bytes_hex(0).is_err());
        assert!(random_bytes_hex(MAX_RANDOM_BYTES + 1).is_err());

        let sha_op = decode_host_op("host.sha256", serde_json::json!({ "text": "abc" })).unwrap();
        let sha_env = handle_stateless_op(&sha_op).unwrap();
        assert_eq!(sha_env.biz_code, 0);
        assert_eq!(sha_env.data.unwrap()["hex"], "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

        let qr_op = decode_host_op("host.qr", serde_json::json!({ "text": "hello", "border": 2 })).unwrap();
        let qr_env = handle_stateless_op(&qr_op).unwrap();
        assert_eq!(qr_env.biz_code, 0);
        assert_eq!(qr_env.data.unwrap()["size"], 25);

        let unknown = decode_host_op("host.doesNotExist", serde_json::json!({})).unwrap_err();
        assert_eq!(unknown.biz_code, vibevalley_server::gateway::bridge::BizCode::RouteNotFound.code());
        let malformed = decode_host_op("host.sha256", serde_json::json!({})).unwrap_err();
        assert_eq!(malformed.biz_code, vibevalley_server::gateway::bridge::BizCode::InvalidInput.code());

        let assets_op = decode_host_op("host.assetsDir", serde_json::json!({})).unwrap();
        assert_eq!(assets_op, vibevalley_protocol::HostOp::AssetsDir);
        assert!(handle_stateless_op(&assets_op).is_none());
    }

    #[test]
    fn disable_default_font_smoothing_sets_zero_without_overriding_explicit_value() {
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        use objc2_foundation::NSString;

        unsafe extern "C" {
            static NSArgumentDomain: *const c_void;
        }

        // Unset key becomes 0 via `CFPreferencesCopyAppValue` (same lookup as `gpui-fast-apple`).
        let unset_key = "VibeValleyTestFontSmoothingUnset";
        assert_eq!(cf_app_pref(unset_key), CfPrefValue::Unset);
        disable_default_font_smoothing_for(unset_key);
        assert_eq!(cf_app_pref(unset_key), CfPrefValue::Int(0));

        // Explicit non-zero value in `NSArgumentDomain` (e.g. CLI `-AppleFontSmoothing 2`) is preserved.
        let override_key = "VibeValleyTestFontSmoothingOverride";
        let ns_override = NSString::from_str(override_key);
        unsafe {
            let defaults: *mut AnyObject = msg_send![class!(NSUserDefaults), standardUserDefaults];
            let prev: *mut AnyObject = msg_send![defaults, volatileDomainForName: NSArgumentDomain];
            let next: *mut AnyObject = if prev.is_null() {
                msg_send![class!(NSMutableDictionary), dictionary]
            } else {
                msg_send![class!(NSMutableDictionary), dictionaryWithDictionary: prev]
            };
            let two: *mut AnyObject = msg_send![class!(NSNumber), numberWithLongLong: 2i64];
            let _: () = msg_send![next, setObject: two, forKey: &*ns_override];
            let _: () = msg_send![defaults, setVolatileDomain: next, forName: NSArgumentDomain];

            disable_default_font_smoothing_for(override_key);
            assert_eq!(cf_app_pref(override_key), CfPrefValue::Int(2));

            let restore: *mut AnyObject = if prev.is_null() { msg_send![class!(NSDictionary), dictionary] } else { prev };
            let _: () = msg_send![defaults, setVolatileDomain: restore, forName: NSArgumentDomain];
        }

        // Exercise the production entry point on `AppleFontSmoothing`.
        let before = cf_app_pref(APPLE_FONT_SMOOTHING_KEY);
        disable_default_font_smoothing();
        match before {
            CfPrefValue::Unset => assert_eq!(cf_app_pref(APPLE_FONT_SMOOTHING_KEY), CfPrefValue::Int(0)),
            explicit => assert_eq!(cf_app_pref(APPLE_FONT_SMOOTHING_KEY), explicit),
        }
    }

    #[test]
    fn editor_detection_orders_gui_apps_before_terminal_and_default_app() {
        let home = Path::new("/Users/tester");
        let gui = probe_gui_editors_with(
            |bundle_id| match bundle_id {
                "com.todesktop.230313mzl4w4u92" => Some(PathBuf::from("/Applications/Cursor.app")),
                "com.microsoft.VSCodeInsiders" => Some(PathBuf::from("/Applications/Visual Studio Code - Insiders.app")),
                _ => None,
            },
            |path| path == Path::new("/Users/tester/Applications/Zed.app"),
            Some(home),
        );
        let options = build_editor_options(gui, Some("/opt/homebrew/bin/nvim --clean"));

        assert_eq!(options.len(), 5);
        assert_eq!(options[0].label, "Cursor");
        assert_eq!(options[0].subtitle, None);
        assert_eq!(
            options[0].target,
            EditorTarget::Cursor {
                app_path: PathBuf::from("/Applications/Cursor.app")
            }
        );
        assert!(options[0].target.is_gui());

        assert_eq!(options[1].label, "VS Code");
        assert_eq!(options[1].subtitle.as_deref(), Some("Insiders"));
        assert_eq!(
            options[1].target,
            EditorTarget::VsCode {
                app_path: PathBuf::from("/Applications/Visual Studio Code - Insiders.app")
            }
        );
        assert!(options[1].target.is_gui());

        assert_eq!(options[2].label, "Zed");
        assert_eq!(options[2].subtitle, None);
        assert_eq!(
            options[2].target,
            EditorTarget::Zed {
                app_path: PathBuf::from("/Users/tester/Applications/Zed.app")
            }
        );
        assert!(options[2].target.is_gui());

        assert_eq!(options[3].label, "Terminal ($EDITOR)");
        assert_eq!(options[3].subtitle.as_deref(), Some("nvim"));
        assert_eq!(options[3].target, EditorTarget::TerminalEditor);
        assert!(!options[3].target.is_gui());

        assert_eq!(options[4].label, "Default App");
        assert_eq!(options[4].subtitle.as_deref(), Some("macOS"));
        assert_eq!(options[4].target, EditorTarget::DefaultApp);
        assert!(!options[4].target.is_gui());
    }

    #[test]
    fn editor_detection_falls_back_cleanly_when_no_gui_editors_installed() {
        let gui = probe_gui_editors_with(|_| None, |_| false, None);
        assert!(gui.is_empty());

        let options = build_editor_options(gui, None);
        assert_eq!(options.len(), 2);
        assert_eq!(options[0].target, EditorTarget::TerminalEditor);
        assert_eq!(options[0].subtitle.as_deref(), Some("vi"));
        assert_eq!(options[1].target, EditorTarget::DefaultApp);

        assert_eq!(resolve_editor_basename(Some("")), "vi");
        assert_eq!(resolve_editor_basename(Some("   ")), "vi");
        assert_eq!(resolve_editor_basename(Some("\"/usr/local/bin/hx\" -c foo")), "hx");
        assert_eq!(resolve_editor_basename(Some("code --wait")), "code");
    }

    #[test]
    fn open_with_app_rejects_missing_app_or_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("README.md");
        std::fs::write(&file, "# hi").unwrap();

        assert!(open_with_app(Path::new("/nonexistent/NoEditor.app"), &file).is_err());
        assert!(open_with_app(dir.path(), &dir.path().join("missing.md")).is_err());
    }
}
