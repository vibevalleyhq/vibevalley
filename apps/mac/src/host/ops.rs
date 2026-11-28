use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::Value;

use crate::platform::objc_app::{self, CfPrefValue};

/// Maximum byte count `random_bytes_hex` yields in a single call.
pub(super) const MAX_RANDOM_BYTES: usize = 4096;
pub(super) const APPLE_FONT_SMOOTHING_KEY: &str = "AppleFontSmoothing";

static MONO_FONTS: OnceLock<Vec<String>> = OnceLock::new();

/// Filters, sorts, and deduplicates system font family names down to monospace/coding fonts.
pub fn filter_mono_fonts(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut fonts: Vec<String> = names
        .into_iter()
        .filter(|name| {
            let lower = name.to_lowercase();
            lower.contains("nerd")
                || lower.contains(" nf")
                || lower.contains("-nf")
                || lower.contains("mono")
                || lower.contains("menlo")
                || lower.contains("monaco")
                || lower.contains("consolas")
                || lower.contains("courier")
                || lower.contains("fira code")
                || lower.contains("sarasa")
                || lower.contains("maple")
        })
        .collect();
    fonts.sort();
    fonts.dedup();
    fonts
}

/// Returns cached monospace fonts if background prewarming has completed without blocking.
pub fn cached_mono_fonts() -> Option<&'static [String]> {
    MONO_FONTS.get().map(Vec::as_slice)
}

/// Enumerates and caches installed monospace fonts. Call only on a background thread.
pub fn mono_fonts() -> Vec<String> {
    MONO_FONTS.get_or_init(|| filter_mono_fonts(objc_app::system_font_family_names())).clone()
}

/// Lowercase hex SHA-256 digest of UTF-8 `text`.
pub fn sha256_hex(text: &str) -> String {
    use sha2::{Digest as _, Sha256};
    let digest = Sha256::digest(text.as_bytes());
    hex::encode(digest)
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
        for _ in 0..3 {
            hasher.update(uuid::Uuid::new_v4().as_bytes());
        }
        let block = hasher.finalize();
        let take = (length - bytes.len()).min(block.len());
        bytes.extend_from_slice(&block[..take]);
    }
    Ok(hex::encode(&bytes))
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
        | HostOp::AsrState(_)
        | HostOp::AsrStart(_)
        | HostOp::AsrStop(_)
        | HostOp::PlayAudio(_)
        | HostOp::PlaySound(_)
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

pub(super) fn app_icon_candidates(
    channel: vibevalley_protocol::home::ReleaseChannel,
    exe: Option<&Path>,
    manifest_dir: &Path,
    assets_dir: &Path,
) -> Vec<PathBuf> {
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
    objc_app::set_app_icon_and_activate(candidate.as_deref());
}

pub(super) fn disable_default_font_smoothing_for(key: &str) {
    if objc_app::cf_app_pref(key) != CfPrefValue::Unset {
        return;
    }
    objc_app::register_default_int(key, 0);
}

/// Disables CoreGraphics' default font-smoothing stroke dilation (10–22% heavier ink)
/// in-memory before GPUI initializes its text system, while preserving any explicit
/// CLI `-AppleFontSmoothing` or `defaults` preference.
pub fn disable_default_font_smoothing() {
    disable_default_font_smoothing_for(APPLE_FONT_SMOOTHING_KEY);
}
