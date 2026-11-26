use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

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

pub use vibevalley_protocol::{AppletOpenResult, AppletRemoveResult, ArtifactAppletInfo as AppletInfo, HostAppletInstallPayload as AppletInstallRequest};
