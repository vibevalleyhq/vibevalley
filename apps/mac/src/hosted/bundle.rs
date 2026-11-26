use std::sync::OnceLock;

use nsh_platform_gpui::Bundle;
use serde_json::{Value, json};

use super::hub::server_home;

/// The bundle's capabilities with the folders the views show files from
/// added to `fs.read`: VibeValley's assets and the farm (attachments).
/// Added here because they are only known at run time.
pub(super) fn capabilities_from(raw: &str) -> String {
    let mut caps: Value = serde_json::from_str(raw).unwrap_or_else(|_| json!({}));
    let assets = crate::assets::assets_dir();
    let home = server_home();
    let work_root = crate::serving::work_root();
    let _ = std::fs::create_dir_all(&home);
    let roots = [assets, home, work_root];
    if !caps["fs"].is_object() {
        caps["fs"] = json!({ "read": [], "write": [] });
    }
    if !caps["fs"]["read"].is_array() {
        caps["fs"]["read"] = json!([]);
    }
    if let Some(read) = caps["fs"]["read"].as_array_mut() {
        // nsh checks local file:// media lexically against declared roots before canonicalizing,
        // so include both the existing raw root (e.g. `/var/folders/...`, `/tmp/...` symlinks on
        // macOS) and its canonical path (e.g. `/private/var/folders/...`).
        for r in &roots {
            if let Ok(canon) = std::fs::canonicalize(r) {
                if r.is_absolute() && r != &canon {
                    read.push(json!(r));
                }
                read.push(json!(canon));
            }
        }
    }
    caps.to_string()
}

#[cfg(not(debug_assertions))]
const BUNDLE_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/ui/bundle.js"));
#[cfg(not(debug_assertions))]
const BUNDLE_NSHC: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/ui/bundle.nshc"));
#[cfg(debug_assertions)]
const BUNDLE_JS: &str = "throw new Error('VibeValley UI bundle missing on disk: run vp run mac:check.');\n";
#[cfg(debug_assertions)]
const BUNDLE_NSHC: &[u8] = &[];
const CAPABILITIES: &str = include_str!(concat!(env!("OUT_DIR"), "/ui/capabilities.json"));

#[cfg(not(debug_assertions))]
const SHELL_BUNDLE_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/ui-shell/bundle.js"));
#[cfg(not(debug_assertions))]
const SHELL_BUNDLE_NSHC: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/ui-shell/bundle.nshc"));
#[cfg(debug_assertions)]
const SHELL_BUNDLE_JS: &str = "throw new Error('VibeValley shell UI bundle missing on disk: run vp run mac:check.');\n";
#[cfg(debug_assertions)]
const SHELL_BUNDLE_NSHC: &[u8] = &[];
const SHELL_CAPABILITIES: &str = include_str!(concat!(env!("OUT_DIR"), "/ui-shell/capabilities.json"));

static WORKBENCH_BUNDLE_MODE: OnceLock<&'static str> = OnceLock::new();

pub fn workbench_bundle_mode() -> &'static str {
    WORKBENCH_BUNDLE_MODE
        .get()
        .copied()
        .unwrap_or(if !BUNDLE_NSHC.is_empty() { "nshc" } else { "js" })
}

pub(super) fn is_workbench_view(view: &str) -> bool {
    matches!(view, "vv" | "vibevalley" | "farm-form" | "farm-phone")
}

fn dir_has_bundle(dir: &std::path::Path) -> bool {
    dir.join("bundle.nshc").is_file() || dir.join("bundle.js").is_file()
}

pub(super) fn resolve_bundle_dir_from(override_dir: Option<&std::path::Path>, ui_root: &std::path::Path, workbench: bool) -> Option<std::path::PathBuf> {
    if let Some(dir) = override_dir {
        if !workbench {
            let nested = dir.join("build-shell");
            if dir_has_bundle(&nested) {
                return Some(nested);
            }
            if dir.file_name().is_some_and(|n| n == "build") {
                let sibling = dir.with_file_name("build-shell");
                if dir_has_bundle(&sibling) {
                    return Some(sibling);
                }
            }
        }
        return Some(dir.to_path_buf());
    }
    if cfg!(debug_assertions) {
        if !workbench {
            let shell = ui_root.join("build-shell");
            if dir_has_bundle(&shell) {
                return Some(shell);
            }
        }
        let full = ui_root.join("build");
        if dir_has_bundle(&full) {
            return Some(full);
        }
    }
    None
}

pub(super) fn build_embedded_bundle(bytecode: &[u8], js: &str, caps_json: &str) -> (Bundle, &'static str) {
    if !bytecode.is_empty() {
        // SAFETY: bytecode emitted by `nsh build` in `build.rs` during this build.
        let b = unsafe { Bundle::bytecode(bytecode.to_vec()) };
        if let Ok(b) = b.with_app_id(Some("dev.vibevalley.ui")).with_capabilities_json(Some(caps_json)) {
            return (b, "nshc");
        }
    }
    let b = Bundle::source(js.to_string())
        .with_app_id(Some("dev.vibevalley.ui"))
        .with_capabilities_json(Some(caps_json))
        .expect("capabilities.json written by nsh build");
    (b, "js")
}

fn load_bundle_slot(workbench: bool, bytecode: &[u8], js: &str, fallback_caps: &str) -> (Bundle, &'static str) {
    let override_dir = std::env::var_os("VIBEVALLEY_UI_BUNDLE").map(std::path::PathBuf::from);
    let ui_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("ui");
    if let Some(dir) = resolve_bundle_dir_from(override_dir.as_deref(), &ui_root, workbench) {
        let raw_caps = std::fs::read_to_string(dir.join("capabilities.json")).unwrap_or_else(|_| fallback_caps.to_string());
        let caps_json = capabilities_from(&raw_caps);
        let nshc = dir.join("bundle.nshc");
        if nshc.is_file()
            && let Ok(bytes) = std::fs::read(&nshc)
            && !bytes.is_empty()
        {
            // SAFETY: local `nsh build` output under the workspace's own `ui/build*`.
            let b = unsafe { Bundle::bytecode(bytes) };
            if let Ok(b) = b.with_app_id(Some("dev.vibevalley.ui")).with_capabilities_json(Some(&caps_json)) {
                return (b, "nshc");
            }
        }
        match std::fs::read_to_string(dir.join("bundle.js")) {
            Ok(source) if !source.is_empty() => {
                if let Ok(b) = Bundle::source(source)
                    .with_app_id(Some("dev.vibevalley.ui"))
                    .with_capabilities_json(Some(&caps_json))
                {
                    return (b, "js");
                }
            }
            Ok(_) => {}
            Err(e) => eprintln!("ui bundle at {}: {e}; using the embedded bundle", dir.display()),
        }
    }
    let caps_json = capabilities_from(fallback_caps);
    build_embedded_bundle(bytecode, js, &caps_json)
}

/// Full workbench bundle for `"vv"`/`"vibevalley"` and diorama overlays, lightweight shell
/// bundle for all other hosted surfaces (including `"devtools"`), cached process-wide so views
/// share one load.
pub(super) fn bundle_for(view: &str) -> Bundle {
    if is_workbench_view(view) {
        static WORKBENCH: OnceLock<Bundle> = OnceLock::new();
        WORKBENCH
            .get_or_init(|| {
                let (bundle, mode) = load_bundle_slot(true, BUNDLE_NSHC, BUNDLE_JS, CAPABILITIES);
                let _ = WORKBENCH_BUNDLE_MODE.set(mode);
                bundle
            })
            .clone()
    } else {
        static SHELL: OnceLock<Bundle> = OnceLock::new();
        SHELL
            .get_or_init(|| load_bundle_slot(false, SHELL_BUNDLE_NSHC, SHELL_BUNDLE_JS, SHELL_CAPABILITIES).0)
            .clone()
    }
}
