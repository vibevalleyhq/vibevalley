use std::path::{Path, PathBuf};

use serde_json::Value;

pub use vibevalley_protocol::HostLocalFile as LocalFile;
pub use vibevalley_protocol::HostLocalFolder as LocalFolder;

/// The largest file `read_file` hands a view.
const MAX_READ: u64 = 50 << 20;

pub struct Storage {
    pub database: PathBuf,
    pub views: PathBuf,
}

impl Storage {
    pub fn configured() -> Self {
        Self::for_channel(std::env::var_os("VIBEVALLEY_STORE").as_deref(), vibevalley_protocol::home::current_channel())
    }

    pub(super) fn for_channel(override_path: Option<&std::ffi::OsStr>, channel: vibevalley_protocol::home::ReleaseChannel) -> Self {
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
    percent_encoding::percent_decode_str(raw).decode_utf8_lossy().into_owned()
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
    if !path.exists() {
        return Err(format!("path does not exist: {}", path.display()));
    }
    crate::platform::objc_app::workspace_open_path(path)
}

/// Reveals `path` in Finder via `NSWorkspace` without spawning `/usr/bin/open -R`.
pub fn reveal(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("path does not exist: {}", path.display()));
    }
    crate::platform::objc_app::workspace_reveal_path(path);
    Ok(())
}
