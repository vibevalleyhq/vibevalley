use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

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

pub(super) fn resolve_editor_basename(editor_env: Option<&str>) -> String {
    let raw = editor_env.unwrap_or_default().trim();
    let token = raw.split_whitespace().next().unwrap_or_default().trim_matches(['"', '\'']);
    let base = Path::new(token).file_name().and_then(|n| n.to_str()).unwrap_or_default().trim();
    if base.is_empty() { "vi".to_string() } else { base.to_string() }
}

pub(super) fn build_editor_options(mut gui_editors: Vec<EditorOption>, editor_env: Option<&str>) -> Vec<EditorOption> {
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

pub(super) fn probe_gui_editors_with(
    bundle_lookup: impl Fn(&str) -> Option<PathBuf>,
    path_exists: impl Fn(&Path) -> bool,
    home: Option<&Path>,
) -> Vec<EditorOption> {
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
    let gui = probe_gui_editors_with(crate::platform::objc_app::find_app_by_bundle_id, Path::exists, home.as_deref());
    *DETECTED_GUI_EDITORS.write() = Some(gui.clone());
    build_editor_options(gui, std::env::var("EDITOR").ok().as_deref())
}

/// Kicks off a one-time background probe on the shared Tokio blocking pool so the editor cache is warm.
pub fn warm_editor_cache() {
    if DETECTED_GUI_EDITORS.read().is_some() || EDITOR_WARM_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    vibevalley_kit::rt::current_or_global_handle().spawn_blocking(|| {
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
