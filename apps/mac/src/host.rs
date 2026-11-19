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
        Self::from_override(std::env::var_os("VIBEVALLEY_STORE").map(PathBuf::from))
    }

    fn from_override(path: Option<PathBuf>) -> Self {
        let database = path.unwrap_or_else(vibevalley_workspace::Store::default_path);
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
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
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
pub fn handle_stateless_op(op: &str, payload: &Value) -> Option<vibevalley_bridge::Envelope> {
    use serde_json::json;
    use vibevalley_bridge::{BizCode, Envelope, refusal};
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

/// Sets the macOS Dock / Command-Tab icon from `resources/icon.icns` so
/// launching the binary directly does not show the generic `exec` icon.
pub fn set_app_icon() {
    use objc2::AnyThread as _;
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy, NSImage};
    use objc2_foundation::{MainThreadMarker, NSString};

    let Some(mtm) = MainThreadMarker::new() else { return };
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    let dir = crate::pixel::assets_dir();
    let candidate = [
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/icon.icns"),
        dir.join("pixel/app-sprout.png"),
    ]
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
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("host.db");
        let paths = Storage::from_override(Some(state.clone()));
        assert_eq!(paths.database, state);
        assert_eq!(paths.views, root.path().join("host.db.nsh"));
        let sibling = Storage::from_override(Some(root.path().join("other.db")));
        assert_eq!(sibling.views, root.path().join("other.db.nsh"));
        let isolated = Storage::from_override(Some(root.path().join("state.db")));
        assert_eq!(isolated.views, root.path().join("nsh"));

        let installed = Storage::from_override(None);
        assert!(installed.database.ends_with("Library/Application Support/VibeValley/state.db"));
        assert!(installed.views.ends_with("Library/Application Support/VibeValley/nsh"));
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
}
