//! Pure-Rust macOS `.app` bundle and `.icns` icon generator for artifact applets.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::process::Command;

use image::{ImageEncoder as _, Rgba, RgbaImage};
use vibevalley_protocol::ArtifactType;

use super::{AppletInfo, AppletInstallRequest, AppletOpenResult, AppletRemoveResult, apps_dir};

pub const BUNDLE_ID_PREFIX: &str = "dev.vibevalley.applet.";
const SHIM_EXECUTABLE_NAME: &str = "VibeValleyShim";
const ICON_FILE_NAME: &str = "AppIcon.icns";
const LSREGISTER_PATH: &str = "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister";
const ICON_SIZE: u32 = 512;

pub fn bundle_id_for(artifact_id: &str) -> String {
    let mut sanitized = String::with_capacity(artifact_id.len());
    let mut prev_dash = false;
    for ch in artifact_id.chars() {
        if ch.is_ascii_alphanumeric() {
            sanitized.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !sanitized.is_empty() {
            sanitized.push('-');
            prev_dash = true;
        }
    }
    while sanitized.ends_with('-') {
        sanitized.pop();
    }
    if sanitized.is_empty() {
        sanitized.push_str("applet");
    }
    format!("{BUNDLE_ID_PREFIX}{sanitized}")
}

pub fn sanitize_app_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.trim().chars() {
        if matches!(ch, '/' | '\\' | ':' | '\0') || ch.is_control() {
            out.push('-');
        } else {
            out.push(ch);
        }
    }
    let trimmed = out.trim().trim_start_matches('.').trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        "VibeValley Applet".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn resolve_shim_binary() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().ok();
    resolve_shim_binary_from(
        std::env::var_os("VIBEVALLEY_SHIM_BIN").as_deref(),
        exe.as_deref(),
        Path::new(env!("CARGO_MANIFEST_DIR")),
    )
}

pub(crate) fn resolve_shim_binary_from(env_bin: Option<&OsStr>, current_exe: Option<&Path>, manifest_dir: &Path) -> Result<PathBuf, String> {
    let apps_root = manifest_dir.parent();
    let candidates = [
        env_bin.filter(|v| !v.is_empty()).map(PathBuf::from),
        current_exe.and_then(Path::parent).map(|dir| dir.join(SHIM_EXECUTABLE_NAME)),
        apps_root.map(|apps| apps.join("shim/.build/release").join(SHIM_EXECUTABLE_NAME)),
        apps_root.map(|apps| apps.join("shim/.build/debug").join(SHIM_EXECUTABLE_NAME)),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|p| p.is_file())
        .ok_or_else(|| "VibeValleyShim binary not found (checked VIBEVALLEY_SHIM_BIN, app bundle sibling, and apps/shim/.build)".to_string())
}

pub fn host_app_path() -> PathBuf {
    let Ok(exe) = std::env::current_exe() else {
        return PathBuf::new();
    };
    host_app_path_from(&exe)
}

pub(crate) fn host_app_path_from(exe: &Path) -> PathBuf {
    let text = exe.to_string_lossy();
    if let Some(idx) = text.rfind(".app/Contents/MacOS/") {
        PathBuf::from(&text[..idx + ".app".len()])
    } else {
        exe.to_path_buf()
    }
}

#[derive(Clone, Copy)]
struct TilePalette {
    top: [u8; 3],
    bottom: [u8; 3],
    emblem: [u8; 3],
}

fn palette_for(artifact_type: &str) -> TilePalette {
    match ArtifactType::parse(artifact_type) {
        Some(ArtifactType::Docs) => TilePalette {
            top: [76, 132, 232],
            bottom: [45, 92, 188],
            emblem: [255, 255, 255],
        },
        Some(ArtifactType::Outline) => TilePalette {
            top: [100, 146, 212],
            bottom: [62, 102, 168],
            emblem: [255, 255, 255],
        },
        Some(ArtifactType::Slides) => TilePalette {
            top: [232, 118, 66],
            bottom: [188, 76, 36],
            emblem: [255, 255, 255],
        },
        Some(ArtifactType::Dashboard) => TilePalette {
            top: [44, 168, 134],
            bottom: [24, 124, 96],
            emblem: [255, 255, 255],
        },
        Some(ArtifactType::Motion) => TilePalette {
            top: [168, 92, 224],
            bottom: [118, 52, 178],
            emblem: [255, 255, 255],
        },
        Some(ArtifactType::Whiteboard) => TilePalette {
            top: [234, 168, 52],
            bottom: [188, 122, 24],
            emblem: [255, 255, 255],
        },
        Some(ArtifactType::Design) => TilePalette {
            top: [224, 78, 134],
            bottom: [176, 42, 94],
            emblem: [255, 255, 255],
        },
        Some(ArtifactType::DesignSystem) => TilePalette {
            top: [124, 106, 228],
            bottom: [82, 66, 184],
            emblem: [255, 255, 255],
        },
        Some(ArtifactType::Sheet) => TilePalette {
            top: [54, 162, 86],
            bottom: [32, 118, 58],
            emblem: [255, 255, 255],
        },
        Some(ArtifactType::Prototype) => TilePalette {
            top: [52, 174, 214],
            bottom: [26, 128, 168],
            emblem: [255, 255, 255],
        },
        Some(ArtifactType::Diagram) => TilePalette {
            top: [72, 152, 184],
            bottom: [42, 108, 140],
            emblem: [255, 255, 255],
        },
        Some(ArtifactType::Storyboard) => TilePalette {
            top: [212, 98, 92],
            bottom: [164, 58, 54],
            emblem: [255, 255, 255],
        },
        None => TilePalette {
            top: [92, 142, 98],
            bottom: [58, 102, 64],
            emblem: [255, 255, 255],
        },
    }
}

fn rounded_rect_sdf(px: f32, py: f32, half_extent: f32, radius: f32) -> f32 {
    let qx = px.abs() - (half_extent - radius);
    let qy = py.abs() - (half_extent - radius);
    let out_dist = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt();
    let in_dist = qx.max(qy).min(0.0);
    out_dist + in_dist - radius
}

fn blend(dst: &mut [u8; 4], src: [u8; 3], alpha: f32) {
    let a = alpha.clamp(0.0, 1.0);
    if a <= 0.0 {
        return;
    }
    let inv = 1.0 - a;
    dst[0] = (dst[0] as f32 * inv + src[0] as f32 * a).round() as u8;
    dst[1] = (dst[1] as f32 * inv + src[1] as f32 * a).round() as u8;
    dst[2] = (dst[2] as f32 * inv + src[2] as f32 * a).round() as u8;
}

fn emblem_coverage(artifact_type: &str, nx: f32, ny: f32) -> f32 {
    let in_rect = |x0: f32, y0: f32, x1: f32, y1: f32, r: f32| -> bool {
        let cx = (x0 + x1) * 0.5;
        let cy = (y0 + y1) * 0.5;
        let hx = (x1 - x0) * 0.5;
        let hy = (y1 - y0) * 0.5;
        let qx = (nx - cx).abs() - (hx - r);
        let qy = (ny - cy).abs() - (hy - r);
        (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt() + qx.max(qy).min(0.0) - r <= 0.0
    };
    let in_circle = |cx: f32, cy: f32, r: f32| -> bool { ((nx - cx).powi(2) + (ny - cy).powi(2)).sqrt() <= r };

    let hit = match ArtifactType::parse(artifact_type) {
        Some(ArtifactType::Docs) => {
            in_rect(-0.34, -0.34, 0.34, -0.22, 0.05) || in_rect(-0.34, -0.06, 0.34, 0.06, 0.05) || in_rect(-0.34, 0.22, 0.14, 0.34, 0.05)
        }
        Some(ArtifactType::Outline) => {
            in_circle(-0.32, -0.26, 0.07)
                || in_rect(-0.16, -0.31, 0.36, -0.21, 0.04)
                || in_circle(-0.20, 0.0, 0.07)
                || in_rect(-0.04, -0.05, 0.36, 0.05, 0.04)
                || in_circle(-0.20, 0.26, 0.07)
                || in_rect(-0.04, 0.21, 0.30, 0.31, 0.04)
        }
        Some(ArtifactType::Slides) => {
            (in_rect(-0.40, -0.28, 0.40, 0.28, 0.06) && !in_rect(-0.31, -0.19, 0.31, 0.19, 0.02)) || in_rect(-0.16, -0.06, 0.16, 0.06, 0.02)
        }
        Some(ArtifactType::Dashboard) => {
            in_rect(-0.36, 0.04, -0.16, 0.34, 0.04) || in_rect(-0.10, -0.22, 0.10, 0.34, 0.04) || in_rect(0.16, -0.36, 0.36, 0.34, 0.04)
        }
        Some(ArtifactType::Motion) => {
            // Right-pointing play triangle centered inside tile.
            (-0.24..=0.34).contains(&nx) && ny.abs() <= (0.34 - nx) * 0.62
        }
        Some(ArtifactType::Whiteboard) => in_rect(-0.36, -0.32, 0.06, 0.06, 0.05) || in_rect(-0.04, -0.04, 0.36, 0.34, 0.05),
        Some(ArtifactType::Design) => in_circle(0.0, 0.0, 0.36) && !in_circle(0.0, 0.0, 0.18) || in_circle(0.0, 0.0, 0.09),
        Some(ArtifactType::DesignSystem) => {
            in_rect(-0.34, -0.34, -0.04, -0.04, 0.06)
                || in_rect(0.04, -0.34, 0.34, -0.04, 0.06)
                || in_rect(-0.34, 0.04, -0.04, 0.34, 0.06)
                || in_circle(0.19, 0.19, 0.15)
        }
        Some(ArtifactType::Sheet) => {
            in_rect(-0.36, -0.34, 0.36, -0.16, 0.04)
                || in_rect(-0.36, -0.08, -0.04, 0.10, 0.03)
                || in_rect(0.04, -0.08, 0.36, 0.10, 0.03)
                || in_rect(-0.36, 0.18, -0.04, 0.34, 0.03)
                || in_rect(0.04, 0.18, 0.36, 0.34, 0.03)
        }
        Some(ArtifactType::Prototype) => {
            // Code/preview diamond + window bar.
            in_rect(-0.36, -0.32, 0.36, -0.18, 0.04) || (nx.abs() + (ny - 0.10).abs() <= 0.24)
        }
        Some(ArtifactType::Diagram) => {
            in_rect(-0.18, -0.36, 0.18, -0.12, 0.05)
                || in_rect(-0.03, -0.12, 0.03, 0.12, 0.0)
                || in_rect(-0.38, 0.12, -0.06, 0.36, 0.05)
                || in_rect(0.06, 0.12, 0.38, 0.36, 0.05)
        }
        Some(ArtifactType::Storyboard) => in_rect(-0.38, -0.26, -0.06, 0.26, 0.04) || in_rect(0.06, -0.26, 0.38, 0.26, 0.04),
        None => in_circle(0.0, 0.0, 0.28),
    };
    if hit { 1.0 } else { 0.0 }
}

pub fn render_tile_rgba(artifact_type: &str) -> RgbaImage {
    let size = ICON_SIZE;
    let palette = palette_for(artifact_type);
    let mut img = RgbaImage::new(size, size);
    let half = size as f32 * 0.5;
    let tile_half = 224.0;
    let corner_radius = 96.0;
    let emblem_scale = 180.0;

    for y in 0..size {
        let py = y as f32 + 0.5 - half;
        let t = ((py + tile_half) / (2.0 * tile_half)).clamp(0.0, 1.0);
        let bg = [
            (palette.top[0] as f32 * (1.0 - t) + palette.bottom[0] as f32 * t).round() as u8,
            (palette.top[1] as f32 * (1.0 - t) + palette.bottom[1] as f32 * t).round() as u8,
            (palette.top[2] as f32 * (1.0 - t) + palette.bottom[2] as f32 * t).round() as u8,
        ];
        for x in 0..size {
            let px = x as f32 + 0.5 - half;
            let sdf = rounded_rect_sdf(px, py, tile_half, corner_radius);
            let coverage = (0.5 - sdf).clamp(0.0, 1.0);
            if coverage <= 0.0 {
                img.put_pixel(x, y, Rgba([0, 0, 0, 0]));
                continue;
            }
            let mut rgb = [bg[0], bg[1], bg[2], (coverage * 255.0).round() as u8];
            // Subtle inner top/edge sheen for macOS icon depth.
            if sdf > -4.0 {
                let rim = ((sdf + 4.0) / 4.0).clamp(0.0, 1.0);
                blend(&mut rgb, [255, 255, 255], rim * 0.22);
            }
            // 2x2 subpixel sample for crisp anti-aliased emblem.
            let mut cov = 0.0;
            for sy in [-0.25f32, 0.25] {
                for sx in [-0.25f32, 0.25] {
                    cov += emblem_coverage(artifact_type, (px + sx) / emblem_scale, (py + sy) / emblem_scale);
                }
            }
            cov *= 0.25;
            if cov > 0.0 {
                blend(&mut rgb, palette.emblem, cov * 0.96);
            }
            img.put_pixel(x, y, Rgba(rgb));
        }
    }
    img
}

pub fn encode_icns(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut png = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut png);
    encoder
        .write_image(image.as_raw(), image.width(), image.height(), image::ExtendedColorType::Rgba8)
        .map_err(|e| format!("encode applet icon png: {e}"))?;

    let chunk_len = u32::try_from(8 + png.len()).map_err(|_| "icon PNG exceeds u32 chunk limit")?;
    let total_len = u32::try_from(8 + 8 + png.len()).map_err(|_| "icon ICNS exceeds u32 total limit")?;
    let mut out = Vec::with_capacity(total_len as usize);
    out.extend_from_slice(b"icns");
    out.extend_from_slice(&total_len.to_be_bytes());
    out.extend_from_slice(b"ic09");
    out.extend_from_slice(&chunk_len.to_be_bytes());
    out.extend_from_slice(&png);
    Ok(out)
}

pub fn build_icns(artifact_type: &str) -> Result<Vec<u8>, String> {
    let img = render_tile_rgba(artifact_type);
    encode_icns(&img)
}

fn xml_escape(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

fn xml_unescape(raw: &str) -> String {
    raw.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

pub struct InfoPlistParams<'a> {
    pub bundle_id: &'a str,
    pub app_name: &'a str,
    pub artifact_id: &'a str,
    pub artifact_type: &'a str,
    pub server_home: &'a Path,
    pub channel: &'a str,
    pub host_app_path: &'a Path,
    pub always_on_top: bool,
}

pub fn build_info_plist(params: &InfoPlistParams<'_>) -> String {
    let bundle_id = xml_escape(params.bundle_id);
    let app_name = xml_escape(params.app_name);
    let artifact_id = xml_escape(params.artifact_id);
    let artifact_type = xml_escape(params.artifact_type);
    let server_home = xml_escape(&params.server_home.to_string_lossy());
    let channel = xml_escape(params.channel);
    let host_app_path = xml_escape(&params.host_app_path.to_string_lossy());
    let on_top_tag = if params.always_on_top { "<true/>" } else { "<false/>" };

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>{bundle_id}</string>
  <key>CFBundleName</key>
  <string>{app_name}</string>
  <key>CFBundleDisplayName</key>
  <string>{app_name}</string>
  <key>CFBundleExecutable</key>
  <string>{SHIM_EXECUTABLE_NAME}</string>
  <key>CFBundleIconFile</key>
  <string>{ICON_FILE_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>VVArtifactId</key>
  <string>{artifact_id}</string>
  <key>VVArtifactType</key>
  <string>{artifact_type}</string>
  <key>VVServerHome</key>
  <string>{server_home}</string>
  <key>VVChannel</key>
  <string>{channel}</string>
  <key>VVHostAppPath</key>
  <string>{host_app_path}</string>
  <key>VVAlwaysOnTop</key>
  {on_top_tag}
</dict>
</plist>
"#
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PlistValue {
    String(String),
    Bool(bool),
}

fn parse_plist_fields(xml: &str) -> HashMap<String, PlistValue> {
    let mut fields = HashMap::new();
    let mut rest = xml;
    while let Some(key_start) = rest.find("<key>") {
        let after_key_open = &rest[key_start + "<key>".len()..];
        let Some(key_end) = after_key_open.find("</key>") else {
            break;
        };
        let key = xml_unescape(after_key_open[..key_end].trim());
        let after_key = after_key_open[key_end + "</key>".len()..].trim_start();
        if let Some(str_body) = after_key.strip_prefix("<string>")
            && let Some(str_end) = str_body.find("</string>")
        {
            fields.insert(key, PlistValue::String(xml_unescape(&str_body[..str_end])));
            rest = &str_body[str_end + "</string>".len()..];
        } else if let Some(after_true) = after_key.strip_prefix("<true/>") {
            fields.insert(key, PlistValue::Bool(true));
            rest = after_true;
        } else if let Some(after_false) = after_key.strip_prefix("<false/>") {
            fields.insert(key, PlistValue::Bool(false));
            rest = after_false;
        } else {
            rest = after_key;
        }
    }
    fields
}

fn plist_string(fields: &HashMap<String, PlistValue>, key: &str) -> Option<String> {
    match fields.get(key) {
        Some(PlistValue::String(v)) => Some(v.clone()),
        _ => None,
    }
}

fn plist_bool(fields: &HashMap<String, PlistValue>, key: &str) -> bool {
    matches!(fields.get(key), Some(PlistValue::Bool(true)))
}

fn read_bundle_info(bundle_path: &Path) -> Option<AppletInfo> {
    let plist_path = bundle_path.join("Contents/Info.plist");
    let raw = std::fs::read_to_string(&plist_path).ok()?;
    let fields = parse_plist_fields(&raw);
    let bundle_id = plist_string(&fields, "CFBundleIdentifier")?;
    if !bundle_id.starts_with(BUNDLE_ID_PREFIX) {
        return None;
    }
    let artifact_id = plist_string(&fields, "VVArtifactId")?;
    let artifact_type = plist_string(&fields, "VVArtifactType").unwrap_or_default();
    let app_name = plist_string(&fields, "CFBundleDisplayName")
        .or_else(|| plist_string(&fields, "CFBundleName"))
        .unwrap_or_else(|| bundle_path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default());
    Some(AppletInfo {
        artifact_id,
        artifact_type,
        app_name,
        bundle_id,
        bundle_path: bundle_path.to_string_lossy().into_owned(),
        always_on_top: plist_bool(&fields, "VVAlwaysOnTop"),
        installed: true,
    })
}

fn verify_safe_applet_bundle(apps_root: &Path, bundle_path: &Path) -> Result<(), String> {
    if bundle_path.parent() != Some(apps_root) {
        return Err(format!("refusing to delete bundle outside {}: {}", apps_root.display(), bundle_path.display()));
    }
    let is_app = bundle_path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("app"));
    if !is_app {
        return Err(format!("refusing to delete non-.app path: {}", bundle_path.display()));
    }
    let plist_path = bundle_path.join("Contents/Info.plist");
    let raw = std::fs::read_to_string(&plist_path).map_err(|e| format!("read {}: {e}", plist_path.display()))?;
    let fields = parse_plist_fields(&raw);
    let bundle_id = plist_string(&fields, "CFBundleIdentifier").unwrap_or_default();
    if !bundle_id.starts_with(BUNDLE_ID_PREFIX) {
        return Err(format!("refusing to uninstall bundle without {BUNDLE_ID_PREFIX} identifier: {bundle_id:?}"));
    }
    Ok(())
}

pub fn list_installed() -> Result<Vec<AppletInfo>, String> {
    list_installed_in(&apps_dir())
}

pub(crate) fn list_installed_in(apps_root: &Path) -> Result<Vec<AppletInfo>, String> {
    if !apps_root.exists() {
        return Ok(Vec::new());
    }
    let entries = std::fs::read_dir(apps_root).map_err(|e| format!("read {}: {e}", apps_root.display()))?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir()
            && path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
            && let Some(info) = read_bundle_info(&path)
        {
            out.push(info);
        }
    }
    out.sort_by(|a, b| a.app_name.cmp(&b.app_name).then_with(|| a.artifact_id.cmp(&b.artifact_id)));
    Ok(out)
}

pub fn install(req: &AppletInstallRequest) -> Result<AppletInfo, String> {
    let shim_bin = resolve_shim_binary()?;
    let apps_root = apps_dir();
    let server_home = crate::hosted::server_home();
    let channel = vibevalley_protocol::home::current_channel().as_str();
    let host_app = host_app_path();
    install_in(&apps_root, &shim_bin, &server_home, channel, &host_app, req, true)
}

pub(crate) fn install_in(
    apps_root: &Path,
    shim_bin: &Path,
    server_home: &Path,
    channel: &str,
    host_app: &Path,
    req: &AppletInstallRequest,
    register_launch_services: bool,
) -> Result<AppletInfo, String> {
    if req.artifact_id.trim().is_empty() {
        return Err("artifactId cannot be empty".to_string());
    }
    if !shim_bin.is_file() {
        return Err(format!("VibeValleyShim binary missing: {}", shim_bin.display()));
    }
    std::fs::create_dir_all(apps_root).map_err(|e| format!("create {}: {e}", apps_root.display()))?;

    let app_name = sanitize_app_name(&req.app_name);
    let bundle_id = bundle_id_for(&req.artifact_id);
    let bundle_path = apps_root.join(format!("{app_name}.app"));

    // Remove any previously installed bundle for the same artifact (e.g. after rename) once verified.
    for existing in list_installed_in(apps_root)? {
        if existing.artifact_id == req.artifact_id {
            let old_path = PathBuf::from(&existing.bundle_path);
            if old_path != bundle_path {
                verify_safe_applet_bundle(apps_root, &old_path)?;
                std::fs::remove_dir_all(&old_path).map_err(|e| format!("remove old bundle {}: {e}", old_path.display()))?;
            }
        }
    }

    if bundle_path.exists() {
        // Never overwrite an unrelated .app bundle that happens to share the display name.
        verify_safe_applet_bundle(apps_root, &bundle_path)?;
        std::fs::remove_dir_all(&bundle_path).map_err(|e| format!("replace {}: {e}", bundle_path.display()))?;
    }

    let macos_dir = bundle_path.join("Contents/MacOS");
    let resources_dir = bundle_path.join("Contents/Resources");
    std::fs::create_dir_all(&macos_dir).map_err(|e| format!("create {}: {e}", macos_dir.display()))?;
    std::fs::create_dir_all(&resources_dir).map_err(|e| format!("create {}: {e}", resources_dir.display()))?;

    let dst_shim = macos_dir.join(SHIM_EXECUTABLE_NAME);
    std::fs::copy(shim_bin, &dst_shim).map_err(|e| format!("copy shim to {}: {e}", dst_shim.display()))?;
    let mut perms = std::fs::metadata(&dst_shim).map_err(|e| e.to_string())?.permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&dst_shim, perms).map_err(|e| format!("chmod {}: {e}", dst_shim.display()))?;

    let icns = build_icns(&req.artifact_type)?;
    std::fs::write(resources_dir.join(ICON_FILE_NAME), icns).map_err(|e| format!("write icon: {e}"))?;

    let plist = build_info_plist(&InfoPlistParams {
        bundle_id: &bundle_id,
        app_name: &app_name,
        artifact_id: &req.artifact_id,
        artifact_type: &req.artifact_type,
        server_home,
        channel,
        host_app_path: host_app,
        always_on_top: req.always_on_top,
    });
    std::fs::write(bundle_path.join("Contents/Info.plist"), plist).map_err(|e| format!("write Info.plist: {e}"))?;

    let codesign_out = Command::new("codesign")
        .args(["--force", "--sign", "-"])
        .arg(&bundle_path)
        .output()
        .map_err(|e| format!("codesign {}: {e}", bundle_path.display()))?;
    if !codesign_out.status.success() {
        let stderr = String::from_utf8_lossy(&codesign_out.stderr);
        return Err(format!("codesign {} failed: {}", bundle_path.display(), stderr.trim()));
    }

    if register_launch_services && Path::new(LSREGISTER_PATH).is_file() {
        let _ = Command::new(LSREGISTER_PATH).arg("-f").arg(&bundle_path).output();
    }

    Ok(AppletInfo {
        artifact_id: req.artifact_id.clone(),
        artifact_type: req.artifact_type.clone(),
        app_name,
        bundle_id,
        bundle_path: bundle_path.to_string_lossy().into_owned(),
        always_on_top: req.always_on_top,
        installed: true,
    })
}

pub fn uninstall(artifact_id: &str) -> Result<AppletRemoveResult, String> {
    uninstall_in(&apps_dir(), artifact_id)
}

pub(crate) fn uninstall_in(apps_root: &Path, artifact_id: &str) -> Result<AppletRemoveResult, String> {
    if !apps_root.exists() {
        return Ok(AppletRemoveResult {
            removed: false,
            bundle_path: None,
        });
    }
    let entries = std::fs::read_dir(apps_root).map_err(|e| format!("read {}: {e}", apps_root.display()))?;
    let mut removed_path = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("app")) {
            continue;
        }
        let plist_path = path.join("Contents/Info.plist");
        let Ok(raw) = std::fs::read_to_string(&plist_path) else {
            continue;
        };
        let fields = parse_plist_fields(&raw);
        if plist_string(&fields, "VVArtifactId").as_deref() == Some(artifact_id) {
            verify_safe_applet_bundle(apps_root, &path)?;
            std::fs::remove_dir_all(&path).map_err(|e| format!("remove {}: {e}", path.display()))?;
            removed_path = Some(path.to_string_lossy().into_owned());
        }
    }
    Ok(AppletRemoveResult {
        removed: removed_path.is_some(),
        bundle_path: removed_path,
    })
}

pub fn open_installed(artifact_id: &str) -> Result<AppletOpenResult, String> {
    open_installed_in(&apps_dir(), artifact_id)
}

pub(crate) fn open_installed_in(apps_root: &Path, artifact_id: &str) -> Result<AppletOpenResult, String> {
    let found = list_installed_in(apps_root)?
        .into_iter()
        .find(|info| info.artifact_id == artifact_id)
        .ok_or_else(|| format!("applet for artifact {artifact_id} is not installed"))?;
    crate::host::open(Path::new(&found.bundle_path))?;
    Ok(AppletOpenResult {
        opened: true,
        bundle_path: found.bundle_path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_shim_binary(dir: &Path) -> PathBuf {
        // Minimal valid Mach-O or shell script so `codesign --force --sign -` succeeds on macOS.
        let path = dir.join(SHIM_EXECUTABLE_NAME);
        std::fs::write(&path, b"#!/bin/sh\nexit 0\n").unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path
    }

    #[test]
    fn bundle_id_and_app_name_sanitize_cleanly() {
        assert_eq!(bundle_id_for("Art_123/Foo"), "dev.vibevalley.applet.art-123-foo");
        assert_eq!(bundle_id_for("..."), "dev.vibevalley.applet.applet");
        assert_eq!(sanitize_app_name("  ..Design / Spec: v2  "), "Design - Spec- v2");
        assert_eq!(sanitize_app_name("..."), "VibeValley Applet");
    }

    #[test]
    fn icns_encoder_produces_valid_ic09_container_for_every_artifact_type() {
        for kind in ArtifactType::ALL {
            let icns = build_icns(kind.as_str()).unwrap();
            assert_eq!(&icns[0..4], b"icns");
            let total_len = u32::from_be_bytes(icns[4..8].try_into().unwrap()) as usize;
            assert_eq!(total_len, icns.len());
            assert_eq!(&icns[8..12], b"ic09");
            let chunk_len = u32::from_be_bytes(icns[12..16].try_into().unwrap()) as usize;
            assert_eq!(chunk_len, icns.len() - 8);
            let decoded = image::load_from_memory_with_format(&icns[16..], image::ImageFormat::Png).unwrap();
            assert_eq!(decoded.width(), 512);
            assert_eq!(decoded.height(), 512);
        }
    }

    #[test]
    fn info_plist_escapes_xml_and_roundtrips_all_custom_keys() {
        let xml = build_info_plist(&InfoPlistParams {
            bundle_id: "dev.vibevalley.applet.art-1",
            app_name: "R&D <Spec> \"v1\"",
            artifact_id: "art-1",
            artifact_type: "docs",
            server_home: Path::new("/tmp/vv home/.vibevalley-dev"),
            channel: "dev",
            host_app_path: Path::new("/Applications/VibeValley.app"),
            always_on_top: true,
        });
        assert!(xml.contains("<string>R&amp;D &lt;Spec&gt; &quot;v1&quot;</string>"));
        let fields = parse_plist_fields(&xml);
        assert_eq!(plist_string(&fields, "CFBundleIdentifier").as_deref(), Some("dev.vibevalley.applet.art-1"));
        assert_eq!(plist_string(&fields, "CFBundleDisplayName").as_deref(), Some("R&D <Spec> \"v1\""));
        assert_eq!(plist_string(&fields, "CFBundleExecutable").as_deref(), Some("VibeValleyShim"));
        assert_eq!(plist_string(&fields, "CFBundleIconFile").as_deref(), Some("AppIcon.icns"));
        assert_eq!(plist_string(&fields, "VVArtifactId").as_deref(), Some("art-1"));
        assert_eq!(plist_string(&fields, "VVArtifactType").as_deref(), Some("docs"));
        assert_eq!(plist_string(&fields, "VVServerHome").as_deref(), Some("/tmp/vv home/.vibevalley-dev"));
        assert_eq!(plist_string(&fields, "VVChannel").as_deref(), Some("dev"));
        assert_eq!(plist_string(&fields, "VVHostAppPath").as_deref(), Some("/Applications/VibeValley.app"));
        assert!(plist_bool(&fields, "VVAlwaysOnTop"));
    }

    #[test]
    fn resolve_shim_binary_respects_precedence() {
        let tmp = tempfile::tempdir().unwrap();
        let env_bin = tmp.path().join("env/VibeValleyShim");
        let sibling_dir = tmp.path().join("exe");
        let sibling_bin = sibling_dir.join("VibeValleyShim");
        let exe_path = sibling_dir.join("vibevalley-mac");
        let manifest_dir = tmp.path().join("repo/apps/mac");
        let release_bin = tmp.path().join("repo/apps/shim/.build/release/VibeValleyShim");
        let debug_bin = tmp.path().join("repo/apps/shim/.build/debug/VibeValleyShim");

        for p in [&env_bin, &sibling_bin, &release_bin, &debug_bin] {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"shim").unwrap();
        }
        std::fs::create_dir_all(&manifest_dir).unwrap();

        assert_eq!(
            resolve_shim_binary_from(Some(env_bin.as_os_str()), Some(&exe_path), &manifest_dir).unwrap(),
            env_bin
        );
        assert_eq!(resolve_shim_binary_from(None, Some(&exe_path), &manifest_dir).unwrap(), sibling_bin);
        std::fs::remove_file(&sibling_bin).unwrap();
        assert_eq!(resolve_shim_binary_from(None, Some(&exe_path), &manifest_dir).unwrap(), release_bin);
        std::fs::remove_file(&release_bin).unwrap();
        assert_eq!(resolve_shim_binary_from(None, Some(&exe_path), &manifest_dir).unwrap(), debug_bin);
        std::fs::remove_file(&debug_bin).unwrap();
        assert!(resolve_shim_binary_from(None, Some(&exe_path), &manifest_dir).is_err());
    }

    #[test]
    fn install_list_rename_and_uninstall_work_in_temp_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let shim_dir = tmp.path().join("shim");
        std::fs::create_dir_all(&shim_dir).unwrap();
        let shim_bin = fake_shim_binary(&shim_dir);
        let apps_root = tmp.path().join("apps");
        let server_home = tmp.path().join("home");
        let host_app = Path::new("/Applications/VibeValley.app");

        let first = install_in(
            &apps_root,
            &shim_bin,
            &server_home,
            "dev",
            host_app,
            &AppletInstallRequest {
                artifact_id: "art-42".into(),
                artifact_type: "whiteboard".into(),
                app_name: "System Canvas".into(),
                always_on_top: false,
            },
            false,
        )
        .unwrap();
        assert!(Path::new(&first.bundle_path).join("Contents/MacOS/VibeValleyShim").is_file());
        assert!(Path::new(&first.bundle_path).join("Contents/Resources/AppIcon.icns").is_file());
        assert_eq!(list_installed_in(&apps_root).unwrap(), vec![first.clone()]);

        // Reinstall with new display name removes old bundle.
        let renamed = install_in(
            &apps_root,
            &shim_bin,
            &server_home,
            "dev",
            host_app,
            &AppletInstallRequest {
                artifact_id: "art-42".into(),
                artifact_type: "whiteboard".into(),
                app_name: "Renamed Canvas".into(),
                always_on_top: true,
            },
            false,
        )
        .unwrap();
        assert!(!Path::new(&first.bundle_path).exists());
        assert!(Path::new(&renamed.bundle_path).exists());
        assert_eq!(list_installed_in(&apps_root).unwrap(), vec![renamed.clone()]);

        let removed = uninstall_in(&apps_root, "art-42").unwrap();
        assert!(removed.removed);
        assert_eq!(removed.bundle_path.as_deref(), Some(renamed.bundle_path.as_str()));
        assert!(list_installed_in(&apps_root).unwrap().is_empty());
    }

    #[test]
    fn uninstall_refuses_foreign_bundle_without_applet_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        let apps_root = tmp.path().join("apps");
        let foreign_app = apps_root.join("Foreign.app");
        std::fs::create_dir_all(foreign_app.join("Contents")).unwrap();
        let foreign_plist = build_info_plist(&InfoPlistParams {
            bundle_id: "com.example.other",
            app_name: "Foreign",
            artifact_id: "art-foreign",
            artifact_type: "docs",
            server_home: tmp.path(),
            channel: "dev",
            host_app_path: Path::new("/Applications/VibeValley.app"),
            always_on_top: false,
        });
        std::fs::write(foreign_app.join("Contents/Info.plist"), foreign_plist).unwrap();

        let err = uninstall_in(&apps_root, "art-foreign").unwrap_err();
        assert!(err.contains("refusing to uninstall"), "unexpected error: {err}");
        assert!(foreign_app.exists(), "foreign app bundle must never be deleted");
    }
}
