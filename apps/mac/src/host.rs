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

/// The largest base64 sound `play_audio_data` takes (2 MB).
pub const MAX_SOUND_BASE64: usize = 2 << 20;
/// The largest file `read_file` hands a view.
const MAX_READ: u64 = 50 << 20;

/// Plays a sound given as base64 (a WAV the view synthesised): written to a
/// file of its own in the temp dir, then played as a file.
pub fn play_audio_data(data: &str, kind: &str) -> Result<(), String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|e| e.to_string())?;
    let ext = match kind {
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/aac" | "audio/mp4" | "audio/x-m4a" => "m4a",
        "audio/aiff" | "audio/x-aiff" => "aiff",
        _ => "wav",
    };
    let dir = std::env::temp_dir().join("vibevalley-sounds");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut hasher = std::hash::DefaultHasher::new();
    std::hash::Hash::hash(&bytes, &mut hasher);
    let path = dir.join(format!("{:016x}.{ext}", std::hash::Hasher::finish(&hasher)));
    if !path.is_file() {
        std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    }
    play_audio(&path)
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

pub fn play_audio(path: &Path) -> Result<(), String> {
    crate::audio::play(path, 0.0)
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
}
