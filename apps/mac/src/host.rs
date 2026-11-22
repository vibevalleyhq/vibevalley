//! Native halves of VibeValley's host capabilities (packages/protocol/src/host.ts).

use std::path::{Path, PathBuf};
use std::process::Command;

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

/// AppleScript string literal for `text`.
fn applescript_string(text: &str) -> String {
    let single_line = text.replace(['\r', '\n'], " ");
    format!("\"{}\"", single_line.replace('\\', "\\\\").replace('"', "\\\""))
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

/// A system notification. Blocking (runs `osascript`).
pub fn notify(title: &str, body: &str) -> Result<(), String> {
    let script = format!("display notification {} with title {}", applescript_string(body), applescript_string(title));
    let out = Command::new("/usr/bin/osascript").arg("-e").arg(script).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// The largest file `read_file` hands a view.
const MAX_READ: u64 = 50 << 20;
/// Maximum byte count `random_bytes_hex` yields in a single call.
const MAX_RANDOM_BYTES: usize = 4096;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpriteManifestEntry {
    pub w: f64,
    pub h: f64,
    pub ax: f64,
    pub ay: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hx: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hy: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rail_size: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yard: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheet: Option<String>,
}

pub type PixelManifest = std::collections::BTreeMap<String, SpriteManifestEntry>;

fn load_pixel_manifest(path: &Path) -> Result<PixelManifest, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("{}: {e}", path.display()))
}

/// Reads and caches `assets/pixel/sprites.json` once per process so the UI bundle
/// does not inline the 105 KB manifest.
pub fn pixel_manifest() -> Result<&'static PixelManifest, String> {
    static CACHED: std::sync::OnceLock<PixelManifest> = std::sync::OnceLock::new();
    if let Some(manifest) = CACHED.get() {
        return Ok(manifest);
    }
    let path = crate::pixel::assets_dir().join("pixel/sprites.json");
    let parsed = load_pixel_manifest(&path)?;
    Ok(CACHED.get_or_init(|| parsed))
}

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

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Sha256Request {
    text: String,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RandomBytesRequest {
    length: usize,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct QrRequest {
    text: String,
    #[serde(default = "default_qr_border")]
    border: usize,
}

fn default_qr_border() -> usize {
    2
}

/// Handles fast, stateless host ops (`host.sha256`, `host.randomBytes`, `host.qr`,
/// `host.pixelManifest`) on either the engine thread or the shell fallback path.
pub fn handle_stateless_op(op: &str, payload: &Value) -> Option<vibevalley_server::transport::bridge::Envelope> {
    use serde_json::json;
    use vibevalley_server::transport::bridge::{BizCode, Envelope, refusal};
    match op {
        "host.sha256" => Some(match serde_json::from_value::<Sha256Request>(payload.clone()) {
            Ok(req) => Envelope::ok(json!({ "hex": sha256_hex(&req.text) })),
            Err(e) => refusal(BizCode::InvalidInput, format!("sha256: {e}")),
        }),
        "host.randomBytes" => Some(match serde_json::from_value::<RandomBytesRequest>(payload.clone()) {
            Ok(req) => match random_bytes_hex(req.length) {
                Ok(hex) => Envelope::ok(json!({ "hex": hex })),
                Err(e) => refusal(BizCode::InvalidInput, e),
            },
            Err(e) => refusal(BizCode::InvalidInput, format!("randomBytes: {e}")),
        }),
        "host.qr" => Some(match serde_json::from_value::<QrRequest>(payload.clone()) {
            Ok(req) => match crate::qr::encode(&req.text, req.border) {
                Ok(matrix) => Envelope::ok(json!(matrix)),
                Err(e) => refusal(BizCode::InvalidInput, e),
            },
            Err(e) => refusal(BizCode::InvalidInput, format!("qr: {e}")),
        }),
        "host.pixelManifest" => Some(match pixel_manifest() {
            Ok(manifest) => Envelope::ok(json!(manifest)),
            Err(e) => refusal(BizCode::NotFound, e),
        }),
        _ => None,
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

#[derive(serde::Serialize)]
pub struct LocalFile {
    path: std::path::PathBuf,
    name: String,
    #[serde(rename = "type")]
    kind: &'static str,
    size: u64,
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
        path: path.to_path_buf(),
        name,
        kind,
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

/// Opens `path` in its default app.
pub fn open(path: &Path) -> Result<(), String> {
    let status = Command::new("/usr/bin/open").arg("--").arg(path).status().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("open exited with {status}"))
    }
}

pub fn reveal(path: &Path) -> Result<(), String> {
    let status = Command::new("/usr/bin/open").arg("-R").arg(path).status().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("open -R exited with {status}"))
    }
}

fn channel_icon_names(channel: vibevalley_protocol::home::ReleaseChannel) -> (&'static str, &'static str) {
    use vibevalley_protocol::home::ReleaseChannel;
    match channel {
        ReleaseChannel::Release => ("icon.icns", "pixel/app-sprout.png"),
        ReleaseChannel::Beta => ("icon-beta.icns", "pixel/app-sprout-beta.png"),
        ReleaseChannel::Alpha => ("icon-alpha.icns", "pixel/app-sprout-alpha.png"),
        ReleaseChannel::Dev => ("icon-dev.icns", "pixel/app-sprout-dev.png"),
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
    let (icns, png) = channel_icon_names(channel);
    let mut candidates = Vec::with_capacity(5);
    if let Some(bundled) = bundled_resources_icon(exe) {
        candidates.push(bundled);
    }
    candidates.push(manifest_dir.join("resources").join(icns));
    candidates.push(assets_dir.join(png));
    if icns != "icon.icns" {
        candidates.push(manifest_dir.join("resources/icon.icns"));
    }
    if png != "pixel/app-sprout.png" {
        candidates.push(assets_dir.join("pixel/app-sprout.png"));
    }
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
    let dir = crate::pixel::assets_dir();
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
    use std::ffi::c_void;

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
                PathBuf::from("/repo/assets/pixel/app-sprout-alpha.png"),
                PathBuf::from("/repo/apps/mac/resources/icon.icns"),
                PathBuf::from("/repo/assets/pixel/app-sprout.png"),
            ]
        );

        let dev = app_icon_candidates(ReleaseChannel::Dev, Some(Path::new("/repo/target/debug/vibevalley-mac")), manifest, assets);
        assert_eq!(
            dev,
            vec![
                PathBuf::from("/repo/apps/mac/resources/icon-dev.icns"),
                PathBuf::from("/repo/assets/pixel/app-sprout-dev.png"),
                PathBuf::from("/repo/apps/mac/resources/icon.icns"),
                PathBuf::from("/repo/assets/pixel/app-sprout.png"),
            ]
        );

        let beta = app_icon_candidates(ReleaseChannel::Beta, None, manifest, assets);
        assert_eq!(beta[0], PathBuf::from("/repo/apps/mac/resources/icon-beta.icns"));
        assert_eq!(beta[1], PathBuf::from("/repo/assets/pixel/app-sprout-beta.png"));

        let release = app_icon_candidates(ReleaseChannel::Release, None, manifest, assets);
        assert_eq!(
            release,
            vec![
                PathBuf::from("/repo/apps/mac/resources/icon.icns"),
                PathBuf::from("/repo/assets/pixel/app-sprout.png"),
            ]
        );
    }

    #[test]
    fn applescript_strings_are_escaped() {
        assert_eq!(applescript_string(r#"say "hi" \ bye"#), r#""say \"hi\" \\ bye""#);
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

        let sha_env = handle_stateless_op("host.sha256", &serde_json::json!({ "text": "abc" })).unwrap();
        assert_eq!(sha_env.biz_code, 0);
        assert_eq!(sha_env.data.unwrap()["hex"], "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

        let qr_env = handle_stateless_op("host.qr", &serde_json::json!({ "text": "hello", "border": 2 })).unwrap();
        assert_eq!(qr_env.biz_code, 0);
        assert_eq!(qr_env.data.unwrap()["size"], 25);

        let manifest = pixel_manifest().unwrap();
        assert!(manifest.len() > 700);
        assert!(manifest.contains_key("bear-farmer-down"));
    }

    #[test]
    fn disable_default_font_smoothing_sets_zero_without_overriding_explicit_value() {
        use std::ffi::c_void;

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
}
