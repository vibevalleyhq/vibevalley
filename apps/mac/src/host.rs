//! Native halves of VibeValley's host capabilities (packages/protocol/src/host.ts).

use std::path::Path;
use std::process::Command;

use gpui_kit::Window;
use serde_json::Value;

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

/// Shows `path` in Finder. Blocking.
fn player() -> &'static std::sync::Mutex<Option<std::process::Child>> {
    static PLAYER: std::sync::OnceLock<std::sync::Mutex<Option<std::process::Child>>> = std::sync::OnceLock::new();
    PLAYER.get_or_init(Default::default)
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
        "wav" => "audio/wav",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    };
    Ok(serde_json::json!({ "data": base64::engine::general_purpose::STANDARD.encode(&bytes), "type": kind, "name": name }))
}

/// Plays a local sound file with the system's `afplay`, stopping what was
/// playing: nsh's GPUI platform has no audio backend (`AudioPlayer` is
/// silent in the app).
pub fn play_audio(path: &Path) -> Result<(), String> {
    stop_audio();
    let child = Command::new("/usr/bin/afplay").arg(path).spawn().map_err(|e| e.to_string())?;
    *player().lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
    Ok(())
}

pub fn stop_audio() {
    if let Some(mut child) = player().lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = child.kill();
        let _ = child.wait();
    }
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

/// GPUI has no status-bar item: the tray summary's title goes into the
/// window title instead.
pub fn set_tray(summary: &Value, window: &mut Window) {
    let title = summary["title"].as_str().unwrap_or_default();
    window.set_window_title(&if title.is_empty() {
        "VibeValley".to_string()
    } else {
        format!("VibeValley — {title}")
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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
