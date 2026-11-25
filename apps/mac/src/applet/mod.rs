//! Host bridge and `.app` bundle installer for local artifact applets.
//!
//! Frozen NDJSON wire protocol shared byte-for-byte with `apps/shim` over
//! `$VIBEVALLEY_HOME/applet.sock`.

pub mod host;
pub mod installer;
pub mod prototype;
pub mod remote_layer;

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub use host::AppletHost;

pub const SOCKET_FILENAME: &str = "applet.sock";
pub const APPS_DIR_NAME: &str = "VibeValley Apps";

pub fn socket_path(home: &Path) -> PathBuf {
    home.join(SOCKET_FILENAME)
}

pub fn apps_dir() -> PathBuf {
    apps_dir_from(std::env::var_os("VIBEVALLEY_APPS_DIR").as_deref(), std::env::var_os("HOME").as_deref())
}

pub(crate) fn apps_dir_from(env_override: Option<&OsStr>, user_home: Option<&OsStr>) -> PathBuf {
    if let Some(dir) = env_override.filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    match user_home.filter(|v| !v.is_empty()) {
        Some(home) => PathBuf::from(home).join("Applications").join(APPS_DIR_NAME),
        None => PathBuf::from("/Applications").join(APPS_DIR_NAME),
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Modifiers {
    #[serde(default)]
    pub control: bool,
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub shift: bool,
    #[serde(default)]
    pub platform: bool,
    #[serde(default)]
    pub function: bool,
}

impl From<Modifiers> for gpui::Modifiers {
    fn from(m: Modifiers) -> Self {
        Self {
            control: m.control,
            alt: m.alt,
            shift: m.shift,
            platform: m.platform,
            function: m.function,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MouseButtonKind {
    Left,
    Right,
    Middle,
}

impl From<MouseButtonKind> for gpui::MouseButton {
    fn from(button: MouseButtonKind) -> Self {
        match button {
            MouseButtonKind::Left => Self::Left,
            MouseButtonKind::Right => Self::Right,
            MouseButtonKind::Middle => Self::Middle,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScrollPhaseKind {
    Started,
    Moved,
    Ended,
}

impl From<ScrollPhaseKind> for gpui::TouchPhase {
    fn from(phase: ScrollPhaseKind) -> Self {
        match phase {
            ScrollPhaseKind::Started => Self::Started,
            ScrollPhaseKind::Moved => Self::Moved,
            ScrollPhaseKind::Ended => Self::Ended,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ShimToHost {
    #[serde(rename_all = "camelCase")]
    Attach {
        artifact_id: String,
        width: f64,
        height: f64,
        scale: f64,
        #[serde(default)]
        display_id: Option<u32>,
    },
    #[serde(rename_all = "camelCase")]
    Resize {
        width: f64,
        height: f64,
        scale: f64,
    },
    #[serde(rename_all = "camelCase")]
    MouseDown {
        x: f64,
        y: f64,
        button: MouseButtonKind,
        click_count: usize,
        #[serde(default)]
        modifiers: Modifiers,
    },
    #[serde(rename_all = "camelCase")]
    MouseUp {
        x: f64,
        y: f64,
        button: MouseButtonKind,
        click_count: usize,
        #[serde(default)]
        modifiers: Modifiers,
    },
    #[serde(rename_all = "camelCase")]
    MouseMove {
        x: f64,
        y: f64,
        #[serde(default)]
        pressed_button: Option<MouseButtonKind>,
        #[serde(default)]
        modifiers: Modifiers,
    },
    #[serde(rename_all = "camelCase")]
    MouseExit {
        x: f64,
        y: f64,
        #[serde(default)]
        modifiers: Modifiers,
    },
    #[serde(rename_all = "camelCase")]
    Scroll {
        x: f64,
        y: f64,
        delta_x: f64,
        delta_y: f64,
        precise: bool,
        phase: ScrollPhaseKind,
        #[serde(default)]
        modifiers: Modifiers,
    },
    #[serde(rename_all = "camelCase")]
    KeyDown {
        key: String,
        #[serde(default)]
        key_char: Option<String>,
        #[serde(default)]
        is_held: bool,
        #[serde(default)]
        modifiers: Modifiers,
    },
    #[serde(rename_all = "camelCase")]
    KeyUp {
        key: String,
        #[serde(default)]
        key_char: Option<String>,
        #[serde(default)]
        modifiers: Modifiers,
    },
    #[serde(rename_all = "camelCase")]
    ModifiersChanged {
        #[serde(default)]
        modifiers: Modifiers,
    },
    #[serde(rename_all = "camelCase")]
    Focus {
        focused: bool,
    },
    OpenInHost,
    Detach,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HostToShim {
    #[serde(rename_all = "camelCase")]
    ReadyLayer {
        context_id: u32,
        title: String,
        artifact_type: String,
    },
    #[serde(rename_all = "camelCase")]
    ReadyWebview {
        html: String,
        title: String,
        artifact_type: String,
    },
    #[serde(rename_all = "camelCase")]
    UpdateWebview {
        html: String,
        title: String,
    },
    #[serde(rename_all = "camelCase")]
    SetTitle {
        title: String,
    },
    #[serde(rename_all = "camelCase")]
    SetAlwaysOnTop {
        enabled: bool,
    },
    #[serde(rename_all = "camelCase")]
    Error {
        message: String,
    },
    Closing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppletInfo {
    pub artifact_id: String,
    pub artifact_type: String,
    pub app_name: String,
    pub bundle_id: String,
    pub bundle_path: String,
    pub always_on_top: bool,
    pub installed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppletInstallRequest {
    pub artifact_id: String,
    pub artifact_type: String,
    pub app_name: String,
    #[serde(default)]
    pub always_on_top: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppletRemoveResult {
    pub removed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppletOpenResult {
    pub opened: bool,
    pub bundle_path: String,
}

impl From<AppletInfo> for vibevalley_protocol::ArtifactAppletInfo {
    fn from(info: AppletInfo) -> Self {
        Self {
            artifact_id: info.artifact_id,
            artifact_type: info.artifact_type,
            app_name: info.app_name,
            bundle_id: info.bundle_id,
            bundle_path: info.bundle_path,
            always_on_top: info.always_on_top,
            installed: info.installed,
        }
    }
}

impl From<vibevalley_protocol::HostAppletInstallPayload> for AppletInstallRequest {
    fn from(payload: vibevalley_protocol::HostAppletInstallPayload) -> Self {
        Self {
            artifact_id: payload.artifact_id,
            artifact_type: payload.artifact_type,
            app_name: payload.app_name,
            always_on_top: payload.always_on_top,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn socket_and_apps_dir_paths_resolve_overrides() {
        assert_eq!(socket_path(Path::new("/tmp/vv-home")), PathBuf::from("/tmp/vv-home/applet.sock"));
        assert_eq!(
            apps_dir_from(Some(OsStr::new("/tmp/custom-apps")), Some(OsStr::new("/Users/tester"))),
            PathBuf::from("/tmp/custom-apps")
        );
        assert_eq!(
            apps_dir_from(Some(OsStr::new("")), Some(OsStr::new("/Users/tester"))),
            PathBuf::from("/Users/tester/Applications/VibeValley Apps")
        );
        assert_eq!(
            apps_dir_from(None, Some(OsStr::new("/Users/tester"))),
            PathBuf::from("/Users/tester/Applications/VibeValley Apps")
        );
        assert_eq!(apps_dir_from(None, None), PathBuf::from("/Applications/VibeValley Apps"));
    }

    #[test]
    fn shim_to_host_wire_protocol_roundtrips_with_exact_camel_case_fields() {
        let mods = Modifiers {
            control: true,
            alt: false,
            shift: true,
            platform: true,
            function: false,
        };
        let cases = vec![
            (
                ShimToHost::Attach {
                    artifact_id: "art-1".into(),
                    width: 960.0,
                    height: 640.0,
                    scale: 2.0,
                    display_id: Some(69733248),
                },
                json!({
                    "type": "attach",
                    "artifactId": "art-1",
                    "width": 960.0,
                    "height": 640.0,
                    "scale": 2.0,
                    "displayId": 69733248,
                }),
            ),
            (
                ShimToHost::Resize {
                    width: 800.0,
                    height: 500.0,
                    scale: 1.0,
                },
                json!({ "type": "resize", "width": 800.0, "height": 500.0, "scale": 1.0 }),
            ),
            (
                ShimToHost::MouseDown {
                    x: 10.5,
                    y: 22.0,
                    button: MouseButtonKind::Left,
                    click_count: 2,
                    modifiers: mods,
                },
                json!({
                    "type": "mouseDown",
                    "x": 10.5,
                    "y": 22.0,
                    "button": "left",
                    "clickCount": 2,
                    "modifiers": { "control": true, "alt": false, "shift": true, "platform": true, "function": false },
                }),
            ),
            (
                ShimToHost::MouseUp {
                    x: 10.5,
                    y: 22.0,
                    button: MouseButtonKind::Right,
                    click_count: 1,
                    modifiers: Modifiers::default(),
                },
                json!({
                    "type": "mouseUp",
                    "x": 10.5,
                    "y": 22.0,
                    "button": "right",
                    "clickCount": 1,
                    "modifiers": { "control": false, "alt": false, "shift": false, "platform": false, "function": false },
                }),
            ),
            (
                ShimToHost::MouseMove {
                    x: 42.0,
                    y: 84.0,
                    pressed_button: Some(MouseButtonKind::Middle),
                    modifiers: Modifiers::default(),
                },
                json!({
                    "type": "mouseMove",
                    "x": 42.0,
                    "y": 84.0,
                    "pressedButton": "middle",
                    "modifiers": { "control": false, "alt": false, "shift": false, "platform": false, "function": false },
                }),
            ),
            (
                ShimToHost::MouseExit {
                    x: -1.0,
                    y: 5.0,
                    modifiers: Modifiers::default(),
                },
                json!({
                    "type": "mouseExit",
                    "x": -1.0,
                    "y": 5.0,
                    "modifiers": { "control": false, "alt": false, "shift": false, "platform": false, "function": false },
                }),
            ),
            (
                ShimToHost::Scroll {
                    x: 120.0,
                    y: 240.0,
                    delta_x: -3.5,
                    delta_y: 12.0,
                    precise: true,
                    phase: ScrollPhaseKind::Moved,
                    modifiers: mods,
                },
                json!({
                    "type": "scroll",
                    "x": 120.0,
                    "y": 240.0,
                    "deltaX": -3.5,
                    "deltaY": 12.0,
                    "precise": true,
                    "phase": "moved",
                    "modifiers": { "control": true, "alt": false, "shift": true, "platform": true, "function": false },
                }),
            ),
            (
                ShimToHost::KeyDown {
                    key: "s".into(),
                    key_char: Some("s".into()),
                    is_held: true,
                    modifiers: mods,
                },
                json!({
                    "type": "keyDown",
                    "key": "s",
                    "keyChar": "s",
                    "isHeld": true,
                    "modifiers": { "control": true, "alt": false, "shift": true, "platform": true, "function": false },
                }),
            ),
            (
                ShimToHost::KeyUp {
                    key: "s".into(),
                    key_char: None,
                    modifiers: Modifiers::default(),
                },
                json!({
                    "type": "keyUp",
                    "key": "s",
                    "keyChar": null,
                    "modifiers": { "control": false, "alt": false, "shift": false, "platform": false, "function": false },
                }),
            ),
            (
                ShimToHost::ModifiersChanged { modifiers: mods },
                json!({
                    "type": "modifiersChanged",
                    "modifiers": { "control": true, "alt": false, "shift": true, "platform": true, "function": false },
                }),
            ),
            (ShimToHost::Focus { focused: true }, json!({ "type": "focus", "focused": true })),
            (ShimToHost::OpenInHost, json!({ "type": "openInHost" })),
            (ShimToHost::Detach, json!({ "type": "detach" })),
        ];

        for (msg, expected_json) in cases {
            let encoded = serde_json::to_value(&msg).unwrap();
            assert_eq!(encoded, expected_json);
            let decoded: ShimToHost = serde_json::from_value(encoded).unwrap();
            assert_eq!(decoded, msg);
        }
    }

    #[test]
    fn host_to_shim_wire_protocol_roundtrips_with_exact_camel_case_fields() {
        let cases = vec![
            (
                HostToShim::ReadyLayer {
                    context_id: 4242,
                    title: "Spec".into(),
                    artifact_type: "docs".into(),
                },
                json!({ "type": "readyLayer", "contextId": 4242, "title": "Spec", "artifactType": "docs" }),
            ),
            (
                HostToShim::ReadyWebview {
                    html: "<html></html>".into(),
                    title: "Proto".into(),
                    artifact_type: "prototype".into(),
                },
                json!({ "type": "readyWebview", "html": "<html></html>", "title": "Proto", "artifactType": "prototype" }),
            ),
            (
                HostToShim::UpdateWebview {
                    html: "<html>v2</html>".into(),
                    title: "Proto v2".into(),
                },
                json!({ "type": "updateWebview", "html": "<html>v2</html>", "title": "Proto v2" }),
            ),
            (
                HostToShim::SetTitle { title: "Renamed".into() },
                json!({ "type": "setTitle", "title": "Renamed" }),
            ),
            (
                HostToShim::SetAlwaysOnTop { enabled: true },
                json!({ "type": "setAlwaysOnTop", "enabled": true }),
            ),
            (
                HostToShim::Error { message: "not found".into() },
                json!({ "type": "error", "message": "not found" }),
            ),
            (HostToShim::Closing, json!({ "type": "closing" })),
        ];

        for (msg, expected_json) in cases {
            let encoded = serde_json::to_value(&msg).unwrap();
            assert_eq!(encoded, expected_json);
            let decoded: HostToShim = serde_json::from_value(encoded).unwrap();
            assert_eq!(decoded, msg);
        }
    }

    #[test]
    fn applet_info_and_install_request_roundtrip() {
        let req = AppletInstallRequest {
            artifact_id: "art-123".into(),
            artifact_type: "board".into(),
            app_name: "My Board".into(),
            always_on_top: true,
        };
        let req_json = serde_json::to_value(&req).unwrap();
        assert_eq!(
            req_json,
            json!({ "artifactId": "art-123", "artifactType": "board", "appName": "My Board", "alwaysOnTop": true })
        );
        assert_eq!(serde_json::from_value::<AppletInstallRequest>(req_json).unwrap(), req);

        let info = AppletInfo {
            artifact_id: "art-123".into(),
            artifact_type: "whiteboard".into(),
            app_name: "My Board".into(),
            bundle_id: "dev.vibevalley.applet.art-123".into(),
            bundle_path: "/tmp/My Board.app".into(),
            always_on_top: true,
            installed: true,
        };
        let info_json = serde_json::to_value(&info).unwrap();
        assert_eq!(serde_json::from_value::<AppletInfo>(info_json).unwrap(), info);
    }
}
