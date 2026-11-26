#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
#[cfg(feature = "ts-gen")]
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum HostPanel {
    Files,
    Git,
}

impl HostPanel {
    pub const ALL: [HostPanel; 2] = [HostPanel::Files, HostPanel::Git];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            HostPanel::Files => "files",
            HostPanel::Git => "git",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub enum HostRailRunningState {
    Working,
    Ready,
    Idle,
}

impl HostRailRunningState {
    pub const ALL: [HostRailRunningState; 3] = [HostRailRunningState::Working, HostRailRunningState::Ready, HostRailRunningState::Idle];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            HostRailRunningState::Working => "working",
            HostRailRunningState::Ready => "ready",
            HostRailRunningState::Idle => "idle",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostRailWorktree {
    pub path: String,
    pub branch: Option<String>,
    pub main: bool,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostRailTab {
    pub id: u64,
    pub title: String,
    pub active: bool,
    pub kind: String,
    pub running: Option<bool>,
    pub running_state: Option<HostRailRunningState>,
    pub running_agent: Option<String>,
    pub running_label: Option<String>,
    pub attention: Option<bool>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostRailProject {
    pub id: i64,
    pub name: String,
    pub path: String,
    pub initials: String,
    pub active: bool,
    pub attention: bool,
    pub terminals: u32,
    pub shortcut: Option<String>,
    pub branch: Option<String>,
    pub main_root: Option<String>,
    pub worktrees: Option<Vec<HostRailWorktree>>,
    pub tabs: Option<Vec<HostRailTab>>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostRailFrame {
    pub projects: Vec<HostRailProject>,
    pub panel: HostPanel,
    pub inspector_open: Option<bool>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostTreeItem {
    pub id: String,
    pub label: String,
    pub tone: String,
    pub hidden: Option<bool>,
    pub loading: Option<bool>,
    pub disabled: Option<bool>,
    pub children: Option<Vec<HostTreeItem>>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostFileTreeFrame {
    pub root: Option<String>,
    pub name: Option<String>,
    pub items: Vec<HostTreeItem>,
    pub expanded: Option<Vec<String>>,
    pub selected: Option<String>,
    pub loading: Option<bool>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostGitFileRow {
    pub path: String,
    pub code: String,
    pub tone: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostGitBranch {
    pub name: String,
    pub head: bool,
    pub upstream: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostGitWorktree {
    pub path: String,
    pub branch: Option<String>,
    pub main: bool,
    pub locked: bool,
    pub current: bool,
    pub changed: u32,
    pub conflicts: u32,
    pub ahead: u32,
    pub behind: u32,
    pub summary: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostGitCommit {
    pub id: String,
    pub short: String,
    pub summary: String,
    pub author: String,
    pub time: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostGitPanelFrame {
    pub repo: bool,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub staged: Option<Vec<HostGitFileRow>>,
    pub changes: Option<Vec<HostGitFileRow>>,
    pub conflicts: Option<Vec<HostGitFileRow>>,
    pub branches: Option<Vec<HostGitBranch>>,
    pub worktrees: Option<Vec<HostGitWorktree>>,
    pub log: Option<Vec<HostGitCommit>>,
    pub error: Option<String>,
    pub busy: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum HostPaletteMode {
    Commands,
    Files,
    Search,
}

impl HostPaletteMode {
    pub const ALL: [HostPaletteMode; 3] = [HostPaletteMode::Commands, HostPaletteMode::Files, HostPaletteMode::Search];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            HostPaletteMode::Commands => "commands",
            HostPaletteMode::Files => "files",
            HostPaletteMode::Search => "search",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostPaletteCommand {
    pub id: String,
    pub label: String,
    pub detail: Option<String>,
    pub group: String,
    pub shortcut: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostPaletteFileMatch {
    pub id: String,
    pub label: String,
    pub detail: String,
    pub indices: Vec<u32>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostPaletteSearchHit {
    pub id: String,
    pub label: String,
    pub detail: String,
    pub ranges: Vec<[u32; 2]>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(untagged)]
pub enum HostPaletteItem {
    Command(HostPaletteCommand),
    FileMatch(HostPaletteFileMatch),
    SearchHit(HostPaletteSearchHit),
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostPaletteFrame {
    pub mode: HostPaletteMode,
    pub query: String,
    pub items: Vec<HostPaletteItem>,
    pub loading: bool,
    pub note: Option<String>,
}

/// Told apart by `type`.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostAction {
    DismissFarmForm,
    FarmHandset {
        unfolded: bool,
        large: bool,
        game: bool,
        active_call: bool,
    },
    FarmCall {
        id: String,
        answered: bool,
    },
    SilenceFarmPhone,
    /// The single application router selects a native content surface.
    GlobalRoute {
        path: String,
    },
    /// Another hosted surface (such as the workspace sidebar) asks the workbench router to navigate.
    OpenRoute {
        path: String,
    },
    GlobalRail {
        rail_width: f32,
    },
    /// Whether a workbench modal overlay (`Dialog`, `Lightbox`, etc.) is currently open,
    /// raising the workbench above native workspace/diorama layers.
    GlobalModal {
        active: bool,
    },
    /// The view applied frame `rev` of `topic` (debug bookkeeping).
    Applied {
        topic: String,
        rev: u64,
    },
    /// The view's script started and listens.
    Ready,
    /// A bridge call the shell answers (`host.*` ops; the rest go to the server).
    Call {
        id: String,
        op: String,
        #[serde(default)]
        #[cfg_attr(feature = "ts-gen", ts(optional, type = "unknown"))]
        payload: serde_json::Value,
    },
    /// The bridge self-test's results (`apps/mac/ui/workspace/BridgeProbe.tsx`).
    Probe {
        #[cfg_attr(feature = "ts-gen", ts(type = "unknown"))]
        results: serde_json::Value,
    },
    /// VibeValley's /farm and /farm/<repo>: the farm pane, "" for the whole farm.
    #[serde(rename = "openFarm")]
    OpenFarm {
        #[serde(default, skip_serializing_if = "String::is_empty")]
        #[cfg_attr(feature = "ts-gen", ts(as = "Option<String>", optional))]
        repo: String,
    },
    #[serde(rename = "openRepoMap")]
    OpenRepoMap,
    /// VibeValley's /tree: the memory tree pane.
    #[serde(rename = "openTree")]
    OpenTree,
    /// A terminal pane at `cwd` (any worktree, repo, session or issue).
    OpenTerminal {
        cwd: String,
        title: Option<String>,
        command: Option<String>,
    },

    ActivateProject {
        id: i64,
    },
    ActivatePath {
        path: String,
    },
    ActivateTab {
        path: String,
        tab_id: u64,
    },
    CloseTabAt {
        path: String,
        tab_id: u64,
    },
    NewTerminalAt {
        path: String,
    },
    NewChatAt {
        path: String,
        #[serde(default)]
        runtime: Option<String>,
    },
    OpenFileAdjacent {
        path: String,
        #[serde(default)]
        line: Option<u32>,
    },
    OpenDiffAdjacent {
        path: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        #[cfg_attr(feature = "ts-gen", ts(as = "Option<bool>", optional))]
        staged: bool,
    },
    BindChatSession {
        tab_id: u64,
        session_id: String,
        #[serde(default)]
        runtime: Option<String>,
    },
    AddProject,
    CloseProject {
        id: i64,
    },
    ShowPanel {
        panel: HostPanel,
    },

    ExpandDir {
        path: String,
    },
    CollapseDir {
        path: String,
    },
    OpenFile {
        path: String,
    },
    RevealInTerminal {
        path: String,
    },

    OpenDiff {
        path: Option<String>,
        staged: bool,
    },
    Stage {
        paths: Vec<String>,
    },
    Unstage {
        paths: Vec<String>,
    },
    Discard {
        paths: Vec<String>,
    },
    Commit {
        message: String,
    },
    Checkout {
        branch: String,
    },
    AddWorktree {
        branch: String,
    },
    RemoveWorktree {
        path: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        #[cfg_attr(feature = "ts-gen", ts(as = "Option<bool>", optional))]
        force: bool,
    },
    OpenCommit {
        id: String,
    },
    RefreshGit,

    PaletteQuery {
        query: String,
    },
    PaletteSelect {
        id: String,
    },
    PaletteClose,

    Search {
        query: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        #[cfg_attr(feature = "ts-gen", ts(as = "Option<bool>", optional))]
        regex: bool,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        #[cfg_attr(feature = "ts-gen", ts(as = "Option<bool>", optional))]
        case_sensitive: bool,
    },
    OpenHit {
        path: String,
        line: u32,
    },

    ToggleDevtools,
    DetachDevtools,
    CloseDevtools,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub enum HostThemeChoice {
    Light,
    Dark,
    System,
}

impl HostThemeChoice {
    pub const ALL: [HostThemeChoice; 3] = [HostThemeChoice::Light, HostThemeChoice::Dark, HostThemeChoice::System];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            HostThemeChoice::Light => "light",
            HostThemeChoice::Dark => "dark",
            HostThemeChoice::System => "system",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub enum HostMotionChoice {
    Off,
    On,
    System,
}

impl HostMotionChoice {
    pub const ALL: [HostMotionChoice; 3] = [HostMotionChoice::Off, HostMotionChoice::On, HostMotionChoice::System];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            HostMotionChoice::Off => "off",
            HostMotionChoice::On => "on",
            HostMotionChoice::System => "system",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub enum HostOpeningPhase {
    Connecting,
    Reading,
    Loading,
    Ready,
    Waiting,
    Failed,
}

impl HostOpeningPhase {
    pub const ALL: [HostOpeningPhase; 6] = [
        HostOpeningPhase::Connecting,
        HostOpeningPhase::Reading,
        HostOpeningPhase::Loading,
        HostOpeningPhase::Ready,
        HostOpeningPhase::Waiting,
        HostOpeningPhase::Failed,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            HostOpeningPhase::Connecting => "connecting",
            HostOpeningPhase::Reading => "reading",
            HostOpeningPhase::Loading => "loading",
            HostOpeningPhase::Ready => "ready",
            HostOpeningPhase::Waiting => "waiting",
            HostOpeningPhase::Failed => "failed",
        }
    }
}

/// Active or configured Control Plane connection mode for the macOS desktop app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub enum DesktopConnectionMode {
    Embedded,
    Remote,
}

impl DesktopConnectionMode {
    pub const ALL: [DesktopConnectionMode; 2] = [DesktopConnectionMode::Embedded, DesktopConnectionMode::Remote];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            DesktopConnectionMode::Embedded => "embedded",
            DesktopConnectionMode::Remote => "remote",
        }
    }
}

/// Where the desktop app's configured Control Plane connection came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub enum DesktopConnectionSource {
    Env,
    File,
    Default,
}

impl DesktopConnectionSource {
    pub const ALL: [DesktopConnectionSource; 3] = [DesktopConnectionSource::Env, DesktopConnectionSource::File, DesktopConnectionSource::Default];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            DesktopConnectionSource::Env => "env",
            DesktopConnectionSource::File => "file",
            DesktopConnectionSource::Default => "default",
        }
    }
}

/// Safe UI-facing snapshot of active vs configured desktop Control Plane connection mode.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DesktopConnectionSnapshot {
    pub active_mode: DesktopConnectionMode,
    pub active_url: Option<String>,
    pub active_label: Option<String>,
    pub configured_mode: DesktopConnectionMode,
    pub configured_url: Option<String>,
    pub configured_label: Option<String>,
    pub token_hint: Option<String>,
    pub source: DesktopConnectionSource,
    pub restart_required: bool,
}

/// Request payload for `host.connectionSave`.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSaveRequest {
    pub url: String,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub pair_code: Option<String>,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub enum HostSoundName {
    Tap,
    Nope,
    Pick,
    Open,
    Close,
    Water,
    Spray,
    Weed,
    Harvest,
    Shovel,
    Plant,
    Ripe,
    Bug,
    Coin,
    LevelUp,
    Achievement,
    Arrive,
    Rustle,
    Splash,
    Thud,
    Woof,
    Yip,
    Pant,
    Meow,
    Mew,
    Purr,
    VoiceOn,
    Ring,
    VoiceOff,
}

impl HostSoundName {
    pub const ALL: [HostSoundName; 29] = [
        HostSoundName::Tap,
        HostSoundName::Nope,
        HostSoundName::Pick,
        HostSoundName::Open,
        HostSoundName::Close,
        HostSoundName::Water,
        HostSoundName::Spray,
        HostSoundName::Weed,
        HostSoundName::Harvest,
        HostSoundName::Shovel,
        HostSoundName::Plant,
        HostSoundName::Ripe,
        HostSoundName::Bug,
        HostSoundName::Coin,
        HostSoundName::LevelUp,
        HostSoundName::Achievement,
        HostSoundName::Arrive,
        HostSoundName::Rustle,
        HostSoundName::Splash,
        HostSoundName::Thud,
        HostSoundName::Woof,
        HostSoundName::Yip,
        HostSoundName::Pant,
        HostSoundName::Meow,
        HostSoundName::Mew,
        HostSoundName::Purr,
        HostSoundName::VoiceOn,
        HostSoundName::Ring,
        HostSoundName::VoiceOff,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            HostSoundName::Tap => "tap",
            HostSoundName::Nope => "nope",
            HostSoundName::Pick => "pick",
            HostSoundName::Open => "open",
            HostSoundName::Close => "close",
            HostSoundName::Water => "water",
            HostSoundName::Spray => "spray",
            HostSoundName::Weed => "weed",
            HostSoundName::Harvest => "harvest",
            HostSoundName::Shovel => "shovel",
            HostSoundName::Plant => "plant",
            HostSoundName::Ripe => "ripe",
            HostSoundName::Bug => "bug",
            HostSoundName::Coin => "coin",
            HostSoundName::LevelUp => "levelUp",
            HostSoundName::Achievement => "achievement",
            HostSoundName::Arrive => "arrive",
            HostSoundName::Rustle => "rustle",
            HostSoundName::Splash => "splash",
            HostSoundName::Thud => "thud",
            HostSoundName::Woof => "woof",
            HostSoundName::Yip => "yip",
            HostSoundName::Pant => "pant",
            HostSoundName::Meow => "meow",
            HostSoundName::Mew => "mew",
            HostSoundName::Purr => "purr",
            HostSoundName::VoiceOn => "voiceOn",
            HostSoundName::Ring => "ring",
            HostSoundName::VoiceOff => "voiceOff",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostFontPayload {
    pub mono_font: Option<String>,
    pub terminal_font_size: Option<f64>,
    pub ui_font_size: Option<f64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostNotifyPayload {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostTrayPayload {
    pub title: String,
    pub lines: Vec<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostOpeningPayload {
    pub phase: HostOpeningPhase,
    pub progress: f64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostOpenTerminalPayload {
    pub cwd: String,
    pub title: Option<String>,
    pub command: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostOpenUrlPayload {
    pub url: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostOpenFilePayload {
    pub path: String,
    pub worktree: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostSaveFilePayload {
    pub path: String,
    pub name: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostIdPayload {
    pub id: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostVoiceMutePayload {
    pub id: Option<String>,
    pub muted: bool,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostPlayAudioPayload {
    pub path: String,
    pub position: Option<f64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostPlaySoundPayload {
    pub name: HostSoundName,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostSeekAudioPayload {
    pub position: f64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostPcmStartPayload {
    pub sample_rate: u32,
    pub channels: u32,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostPcmAppendPayload {
    pub data: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HostReadFilePayload {
    pub path: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostSha256Payload {
    pub text: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostRandomBytesPayload {
    pub length: u32,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostQrPayload {
    pub text: String,
    pub border: Option<u32>,
}

/// Installed or queried metadata for a local macOS artifact applet `.app` bundle.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactAppletInfo {
    pub artifact_id: String,
    pub artifact_type: String,
    pub app_name: String,
    pub bundle_id: String,
    pub bundle_path: String,
    pub always_on_top: bool,
    pub installed: bool,
}

/// Request payload for `host.appletInstall`.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostAppletInstallPayload {
    pub artifact_id: String,
    pub artifact_type: String,
    pub app_name: String,
    #[serde(default)]
    pub always_on_top: bool,
}

/// Request payload for `host.appletUninstall` and `host.appletOpen`.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostAppletIdPayload {
    pub artifact_id: String,
}

/// Result payload returned by `host.appletUninstall`.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct AppletRemoveResult {
    pub removed: bool,
    #[serde(default)]
    pub bundle_path: Option<String>,
}

/// Result payload returned by `host.appletOpen`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct AppletOpenResult {
    pub opened: bool,
    pub bundle_path: String,
}

/// Request payload for `host.captureWebView`.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostCaptureWebViewPayload {
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// Request payload for `host.vdpDiscover`.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostVdpDiscoverPayload {
    #[serde(default)]
    pub extra_homes: Option<Vec<String>>,
}

/// Request payload for `host.vdpCall`.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostVdpCallPayload {
    #[serde(default)]
    pub ws_url: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub token: Option<String>,
    pub method: String,
    #[serde(default)]
    #[cfg_attr(feature = "ts-gen", ts(optional, type = "unknown"))]
    pub params: Option<serde_json::Value>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// Captured raster image returned by `host.captureWebView`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct HostCapturedImage {
    pub mime: String,
    pub data: String,
    pub width: u32,
    pub height: u32,
}

/// Status snapshot for the bundled CLI symlink (`host.cliState` / `cliInstall` / `cliRemove`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct HostCommandLineState {
    pub command: String,
    pub link: String,
    pub installed: bool,
    pub on_path: bool,
    pub taken: bool,
}

/// Encoded QR code grid including its quiet zone (`'1'` = dark, `'0'` = light).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct QrMatrix {
    pub size: usize,
    pub rows: Vec<String>,
}

/// Local regular file metadata returned by `host.pickFile`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct HostLocalFile {
    pub path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub size: u64,
}

/// Native live-voice playback/call phase (`host.voice*`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub enum HostLiveVoicePhase {
    #[default]
    Idle,
    Connecting,
    Live,
    Stopping,
}

/// Snapshot returned by `host.voice*` bridge operations.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct HostLiveVoiceState {
    pub phase: HostLiveVoicePhase,
    pub muted: bool,
    pub problem: Option<String>,
    pub heard: String,
    pub said: String,
}

/// Native speech-stream playback phase (`host.speech*`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub enum HostSpeechAudioPhase {
    #[default]
    Idle,
    Playing,
    Draining,
    Stopping,
}

/// Snapshot returned by `host.speech*` bridge operations.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct HostSpeechAudioState {
    pub phase: HostSpeechAudioPhase,
    pub problem: Option<String>,
}

/// Farm phone call history entry tracked by the diorama shell.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct HostPhoneCallLog {
    pub call: super::inbox::InboxItem,
    pub answered: bool,
}

/// Every `host.*` bridge call answered by the native shell, decoded once at the boundary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(tag = "op", content = "payload")]
pub enum HostOp {
    #[serde(rename = "host.info")]
    Info,
    #[serde(rename = "host.updateState")]
    UpdateState,
    #[serde(rename = "host.updateCheck")]
    UpdateCheck,
    #[serde(rename = "host.updateInstall")]
    UpdateInstall,
    #[serde(rename = "host.cliState")]
    CliState,
    #[serde(rename = "host.cliInstall")]
    CliInstall,
    #[serde(rename = "host.cliRemove")]
    CliRemove,
    #[serde(rename = "host.font")]
    Font(HostFontPayload),
    #[serde(rename = "host.notify")]
    Notify(HostNotifyPayload),
    #[serde(rename = "host.tray")]
    Tray(HostTrayPayload),
    #[serde(rename = "host.locale")]
    Locale(super::Locale),
    #[serde(rename = "host.reveal")]
    Reveal(String),
    #[serde(rename = "host.theme")]
    Theme(HostThemeChoice),
    #[serde(rename = "host.motion")]
    Motion(HostMotionChoice),
    #[serde(rename = "host.opening")]
    Opening(HostOpeningPayload),
    #[serde(rename = "host.openTerminal")]
    OpenTerminal(HostOpenTerminalPayload),
    #[serde(rename = "host.openUrl")]
    OpenUrl(HostOpenUrlPayload),
    #[serde(rename = "host.openFile")]
    OpenFile(HostOpenFilePayload),
    #[serde(rename = "host.pickFile")]
    PickFile,
    #[serde(rename = "host.saveFile")]
    SaveFile(HostSaveFilePayload),
    #[serde(rename = "host.speechState")]
    SpeechState(HostIdPayload),
    #[serde(rename = "host.speechStart")]
    SpeechStart(HostIdPayload),
    #[serde(rename = "host.speechStop")]
    SpeechStop(HostIdPayload),
    #[serde(rename = "host.voiceState")]
    VoiceState(HostIdPayload),
    #[serde(rename = "host.voiceStart")]
    VoiceStart(HostIdPayload),
    #[serde(rename = "host.voiceStop")]
    VoiceStop(HostIdPayload),
    #[serde(rename = "host.voiceMute")]
    VoiceMute(HostVoiceMutePayload),
    #[serde(rename = "host.playAudio")]
    PlayAudio(HostPlayAudioPayload),
    #[serde(rename = "host.playSound")]
    PlaySound(HostPlaySoundPayload),
    #[serde(rename = "host.seekAudio")]
    SeekAudio(HostSeekAudioPayload),
    #[serde(rename = "host.audioState")]
    AudioState,
    #[serde(rename = "host.pcmStart")]
    PcmStart(HostPcmStartPayload),
    #[serde(rename = "host.pcmAppend")]
    PcmAppend(HostPcmAppendPayload),
    #[serde(rename = "host.stopAudio")]
    StopAudio,
    #[serde(rename = "host.readFile")]
    ReadFile(HostReadFilePayload),
    #[serde(rename = "host.assetsDir")]
    AssetsDir,
    #[serde(rename = "host.sha256")]
    Sha256(HostSha256Payload),
    #[serde(rename = "host.randomBytes")]
    RandomBytes(HostRandomBytesPayload),
    #[serde(rename = "host.qr")]
    Qr(HostQrPayload),
    #[serde(rename = "host.appletList")]
    AppletList,
    #[serde(rename = "host.appletInstall")]
    AppletInstall(HostAppletInstallPayload),
    #[serde(rename = "host.appletUninstall")]
    AppletUninstall(HostAppletIdPayload),
    #[serde(rename = "host.appletOpen")]
    AppletOpen(HostAppletIdPayload),
    #[serde(rename = "host.captureWebView")]
    CaptureWebView(HostCaptureWebViewPayload),
    #[serde(rename = "host.vdpDiscover")]
    VdpDiscover(HostVdpDiscoverPayload),
    #[serde(rename = "host.vdpCall")]
    VdpCall(HostVdpCallPayload),
}

impl HostOp {
    pub const OP_NAMES: &'static [&'static str] = &[
        "host.info",
        "host.updateState",
        "host.updateCheck",
        "host.updateInstall",
        "host.cliState",
        "host.cliInstall",
        "host.cliRemove",
        "host.font",
        "host.notify",
        "host.tray",
        "host.locale",
        "host.reveal",
        "host.theme",
        "host.motion",
        "host.opening",
        "host.openTerminal",
        "host.openUrl",
        "host.openFile",
        "host.pickFile",
        "host.saveFile",
        "host.speechState",
        "host.speechStart",
        "host.speechStop",
        "host.voiceState",
        "host.voiceStart",
        "host.voiceStop",
        "host.voiceMute",
        "host.playAudio",
        "host.playSound",
        "host.seekAudio",
        "host.audioState",
        "host.pcmStart",
        "host.pcmAppend",
        "host.stopAudio",
        "host.readFile",
        "host.assetsDir",
        "host.sha256",
        "host.randomBytes",
        "host.qr",
        "host.appletList",
        "host.appletInstall",
        "host.appletUninstall",
        "host.appletOpen",
        "host.captureWebView",
        "host.vdpDiscover",
        "host.vdpCall",
    ];

    pub fn is_known_op(op: &str) -> bool {
        Self::OP_NAMES.contains(&op)
    }

    pub fn op_name(&self) -> &'static str {
        match self {
            HostOp::Info => "host.info",
            HostOp::UpdateState => "host.updateState",
            HostOp::UpdateCheck => "host.updateCheck",
            HostOp::UpdateInstall => "host.updateInstall",
            HostOp::CliState => "host.cliState",
            HostOp::CliInstall => "host.cliInstall",
            HostOp::CliRemove => "host.cliRemove",
            HostOp::Font(_) => "host.font",
            HostOp::Notify(_) => "host.notify",
            HostOp::Tray(_) => "host.tray",
            HostOp::Locale(_) => "host.locale",
            HostOp::Reveal(_) => "host.reveal",
            HostOp::Theme(_) => "host.theme",
            HostOp::Motion(_) => "host.motion",
            HostOp::Opening(_) => "host.opening",
            HostOp::OpenTerminal(_) => "host.openTerminal",
            HostOp::OpenUrl(_) => "host.openUrl",
            HostOp::OpenFile(_) => "host.openFile",
            HostOp::PickFile => "host.pickFile",
            HostOp::SaveFile(_) => "host.saveFile",
            HostOp::SpeechState(_) => "host.speechState",
            HostOp::SpeechStart(_) => "host.speechStart",
            HostOp::SpeechStop(_) => "host.speechStop",
            HostOp::VoiceState(_) => "host.voiceState",
            HostOp::VoiceStart(_) => "host.voiceStart",
            HostOp::VoiceStop(_) => "host.voiceStop",
            HostOp::VoiceMute(_) => "host.voiceMute",
            HostOp::PlayAudio(_) => "host.playAudio",
            HostOp::PlaySound(_) => "host.playSound",
            HostOp::SeekAudio(_) => "host.seekAudio",
            HostOp::AudioState => "host.audioState",
            HostOp::PcmStart(_) => "host.pcmStart",
            HostOp::PcmAppend(_) => "host.pcmAppend",
            HostOp::StopAudio => "host.stopAudio",
            HostOp::ReadFile(_) => "host.readFile",
            HostOp::AssetsDir => "host.assetsDir",
            HostOp::Sha256(_) => "host.sha256",
            HostOp::RandomBytes(_) => "host.randomBytes",
            HostOp::Qr(_) => "host.qr",
            HostOp::AppletList => "host.appletList",
            HostOp::AppletInstall(_) => "host.appletInstall",
            HostOp::AppletUninstall(_) => "host.appletUninstall",
            HostOp::AppletOpen(_) => "host.appletOpen",
            HostOp::CaptureWebView(_) => "host.captureWebView",
            HostOp::VdpDiscover(_) => "host.vdpDiscover",
            HostOp::VdpCall(_) => "host.vdpCall",
        }
    }

    pub fn from_wire(op: &str, payload: serde_json::Value) -> Result<Self, String> {
        let expect_empty = |v: &serde_json::Value| match v {
            serde_json::Value::Null => Ok(()),
            serde_json::Value::Object(map) if map.is_empty() => Ok(()),
            _ => Err(format!("{op} takes no payload")),
        };
        let optional_object = |v: serde_json::Value| {
            if v.is_null() { serde_json::Value::Object(serde_json::Map::new()) } else { v }
        };
        match op {
            "host.info" => expect_empty(&payload).map(|()| HostOp::Info),
            "host.updateState" => expect_empty(&payload).map(|()| HostOp::UpdateState),
            "host.updateCheck" => expect_empty(&payload).map(|()| HostOp::UpdateCheck),
            "host.updateInstall" => expect_empty(&payload).map(|()| HostOp::UpdateInstall),
            "host.cliState" => expect_empty(&payload).map(|()| HostOp::CliState),
            "host.cliInstall" => expect_empty(&payload).map(|()| HostOp::CliInstall),
            "host.cliRemove" => expect_empty(&payload).map(|()| HostOp::CliRemove),
            "host.font" => serde_json::from_value(optional_object(payload))
                .map(HostOp::Font)
                .map_err(|e| format!("font: {e}")),
            "host.notify" => serde_json::from_value(optional_object(payload))
                .map(HostOp::Notify)
                .map_err(|e| format!("notify: {e}")),
            "host.tray" => serde_json::from_value(payload).map(HostOp::Tray).map_err(|e| e.to_string()),
            "host.locale" => serde_json::from_value(payload)
                .map(HostOp::Locale)
                .map_err(|_| "locale is zh or en".to_string()),
            "host.reveal" => serde_json::from_value(payload)
                .map(HostOp::Reveal)
                .map_err(|_| "reveal takes an absolute path".to_string()),
            "host.theme" => serde_json::from_value(payload)
                .map(HostOp::Theme)
                .map_err(|_| "theme is light, dark or system".to_string()),
            "host.motion" => serde_json::from_value(payload)
                .map(HostOp::Motion)
                .map_err(|_| "motion is off, on or system".to_string()),
            "host.opening" => serde_json::from_value(payload).map(HostOp::Opening).map_err(|e| e.to_string()),
            "host.openTerminal" => serde_json::from_value(payload)
                .map(HostOp::OpenTerminal)
                .map_err(|e| format!("openTerminal: {e}")),
            "host.openUrl" => serde_json::from_value(payload).map(HostOp::OpenUrl).map_err(|e| format!("openUrl: {e}")),
            "host.openFile" => serde_json::from_value(payload).map(HostOp::OpenFile).map_err(|e| format!("openFile: {e}")),
            "host.pickFile" => expect_empty(&payload).map(|()| HostOp::PickFile),
            "host.saveFile" => serde_json::from_value(payload).map(HostOp::SaveFile).map_err(|e| format!("saveFile: {e}")),
            "host.speechState" => serde_json::from_value(optional_object(payload))
                .map(HostOp::SpeechState)
                .map_err(|e| format!("speechState: {e}")),
            "host.speechStart" => serde_json::from_value(optional_object(payload))
                .map(HostOp::SpeechStart)
                .map_err(|e| format!("speechStart: {e}")),
            "host.speechStop" => serde_json::from_value(optional_object(payload))
                .map(HostOp::SpeechStop)
                .map_err(|e| format!("speechStop: {e}")),
            "host.voiceState" => serde_json::from_value(optional_object(payload))
                .map(HostOp::VoiceState)
                .map_err(|e| format!("voiceState: {e}")),
            "host.voiceStart" => serde_json::from_value(optional_object(payload))
                .map(HostOp::VoiceStart)
                .map_err(|e| format!("voiceStart: {e}")),
            "host.voiceStop" => serde_json::from_value(optional_object(payload))
                .map(HostOp::VoiceStop)
                .map_err(|e| format!("voiceStop: {e}")),
            "host.voiceMute" => serde_json::from_value(payload)
                .map(HostOp::VoiceMute)
                .map_err(|_| "voiceMute requires a boolean muted value".to_string()),
            "host.playAudio" => serde_json::from_value(payload)
                .map(HostOp::PlayAudio)
                .map_err(|_| "playAudio requires a file path".to_string()),
            "host.playSound" => serde_json::from_value(payload).map(HostOp::PlaySound).map_err(|e| format!("playSound: {e}")),
            "host.seekAudio" => serde_json::from_value(payload).map(HostOp::SeekAudio).map_err(|e| format!("seekAudio: {e}")),
            "host.audioState" => expect_empty(&payload).map(|()| HostOp::AudioState),
            "host.pcmStart" => serde_json::from_value(payload).map(HostOp::PcmStart).map_err(|e| e.to_string()),
            "host.pcmAppend" => serde_json::from_value(payload).map(HostOp::PcmAppend).map_err(|e| format!("pcmAppend: {e}")),
            "host.stopAudio" => expect_empty(&payload).map(|()| HostOp::StopAudio),
            "host.readFile" => serde_json::from_value(payload).map(HostOp::ReadFile).map_err(|e| format!("readFile: {e}")),
            "host.assetsDir" => expect_empty(&payload).map(|()| HostOp::AssetsDir),
            "host.sha256" => serde_json::from_value(payload).map(HostOp::Sha256).map_err(|e| format!("sha256: {e}")),
            "host.randomBytes" => serde_json::from_value(payload)
                .map(HostOp::RandomBytes)
                .map_err(|e| format!("randomBytes: {e}")),
            "host.qr" => serde_json::from_value(payload).map(HostOp::Qr).map_err(|e| format!("qr: {e}")),
            "host.appletList" => expect_empty(&payload).map(|()| HostOp::AppletList),
            "host.appletInstall" => serde_json::from_value(payload)
                .map(HostOp::AppletInstall)
                .map_err(|e| format!("appletInstall: {e}")),
            "host.appletUninstall" => serde_json::from_value(payload)
                .map(HostOp::AppletUninstall)
                .map_err(|e| format!("appletUninstall: {e}")),
            "host.appletOpen" => serde_json::from_value(payload).map(HostOp::AppletOpen).map_err(|e| format!("appletOpen: {e}")),
            "host.captureWebView" => serde_json::from_value(optional_object(payload))
                .map(HostOp::CaptureWebView)
                .map_err(|e| format!("captureWebView: {e}")),
            "host.vdpDiscover" => serde_json::from_value(optional_object(payload))
                .map(HostOp::VdpDiscover)
                .map_err(|e| format!("vdpDiscover: {e}")),
            "host.vdpCall" => serde_json::from_value(payload).map(HostOp::VdpCall).map_err(|e| format!("vdpCall: {e}")),
            other => Err(format!("the host has no op {other}")),
        }
    }
}

#[cfg(feature = "ts-gen")]
crate::typescript::module! {
    "host";
    types: [HostPanel,
    HostRailRunningState,
    HostRailWorktree,
    HostRailTab,
    HostRailProject,
    HostRailFrame,
    HostTreeItem,
    HostFileTreeFrame,
    HostGitFileRow,
    HostGitBranch,
    HostGitWorktree,
    HostGitCommit,
    HostGitPanelFrame,
    HostPaletteMode,
    HostPaletteCommand,
    HostPaletteFileMatch,
    HostPaletteSearchHit,
    HostPaletteItem,
    HostPaletteFrame,
    HostAction,
    HostThemeChoice,
    HostMotionChoice,
    HostOpeningPhase,
    DesktopConnectionMode,
    DesktopConnectionSource,
    DesktopConnectionSnapshot,
    ConnectionSaveRequest,
    HostSoundName,
    HostFontPayload,
    HostNotifyPayload,
    HostTrayPayload,
    HostOpeningPayload,
    HostOpenTerminalPayload,
    HostOpenUrlPayload,
    HostOpenFilePayload,
    HostSaveFilePayload,
    HostIdPayload,
    HostVoiceMutePayload,
    HostPlayAudioPayload,
    HostPlaySoundPayload,
    HostSeekAudioPayload,
    HostPcmStartPayload,
    HostPcmAppendPayload,
    HostReadFilePayload,
    HostSha256Payload,
    HostRandomBytesPayload,
    HostQrPayload,
    ArtifactAppletInfo,
    HostAppletInstallPayload,
    HostAppletIdPayload,
    AppletRemoveResult,
    AppletOpenResult,
    HostCaptureWebViewPayload,
    HostVdpDiscoverPayload,
    HostVdpCallPayload,
    HostCapturedImage,
    HostCommandLineState,
    QrMatrix,
    HostLocalFile,
    HostLiveVoicePhase,
    HostLiveVoiceState,
    HostSpeechAudioPhase,
    HostSpeechAudioState,
    HostPhoneCallLog,
    HostOp];
    aliases: [];
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn host_op_from_wire_decodes_every_known_op_and_round_trips_op_name() {
        let cases: Vec<(&str, serde_json::Value, HostOp)> = vec![
            ("host.info", json!(null), HostOp::Info),
            ("host.info", json!({}), HostOp::Info),
            ("host.updateState", json!(null), HostOp::UpdateState),
            ("host.updateCheck", json!(null), HostOp::UpdateCheck),
            ("host.updateInstall", json!(null), HostOp::UpdateInstall),
            ("host.cliState", json!(null), HostOp::CliState),
            ("host.cliInstall", json!({}), HostOp::CliInstall),
            ("host.cliRemove", json!({}), HostOp::CliRemove),
            (
                "host.font",
                json!({ "monoFont": "Menlo", "terminalFontSize": 13.5, "uiFontSize": 14.0 }),
                HostOp::Font(HostFontPayload {
                    mono_font: Some("Menlo".into()),
                    terminal_font_size: Some(13.5),
                    ui_font_size: Some(14.0),
                }),
            ),
            ("host.font", json!(null), HostOp::Font(HostFontPayload::default())),
            (
                "host.notify",
                json!({ "title": "Done", "body": "Build green" }),
                HostOp::Notify(HostNotifyPayload {
                    title: "Done".into(),
                    body: "Build green".into(),
                }),
            ),
            (
                "host.tray",
                json!({ "title": "2 working", "lines": ["Ticket #1"] }),
                HostOp::Tray(HostTrayPayload {
                    title: "2 working".into(),
                    lines: vec!["Ticket #1".into()],
                }),
            ),
            ("host.locale", json!("zh"), HostOp::Locale(super::super::Locale::Zh)),
            ("host.locale", json!("en"), HostOp::Locale(super::super::Locale::En)),
            ("host.reveal", json!("/tmp/file.txt"), HostOp::Reveal("/tmp/file.txt".into())),
            ("host.theme", json!("dark"), HostOp::Theme(HostThemeChoice::Dark)),
            ("host.motion", json!("off"), HostOp::Motion(HostMotionChoice::Off)),
            (
                "host.opening",
                json!({ "phase": "ready", "progress": 100.0 }),
                HostOp::Opening(HostOpeningPayload {
                    phase: HostOpeningPhase::Ready,
                    progress: 100.0,
                }),
            ),
            (
                "host.openTerminal",
                json!({ "cwd": "/tmp/repo", "title": "dev", "command": "cargo test" }),
                HostOp::OpenTerminal(HostOpenTerminalPayload {
                    cwd: "/tmp/repo".into(),
                    title: Some("dev".into()),
                    command: Some("cargo test".into()),
                }),
            ),
            (
                "host.openUrl",
                json!({ "url": "https://vibevalley.dev" }),
                HostOp::OpenUrl(HostOpenUrlPayload {
                    url: "https://vibevalley.dev".into(),
                }),
            ),
            (
                "host.openFile",
                json!({ "path": "/tmp/a.png" }),
                HostOp::OpenFile(HostOpenFilePayload {
                    path: "/tmp/a.png".into(),
                    worktree: None,
                }),
            ),
            (
                "host.openFile",
                json!({ "path": "src/lib.rs", "worktree": "/tmp/wt" }),
                HostOp::OpenFile(HostOpenFilePayload {
                    path: "src/lib.rs".into(),
                    worktree: Some("/tmp/wt".into()),
                }),
            ),
            ("host.pickFile", json!({}), HostOp::PickFile),
            (
                "host.saveFile",
                json!({ "path": "/tmp/a.png", "name": "export.png" }),
                HostOp::SaveFile(HostSaveFilePayload {
                    path: "/tmp/a.png".into(),
                    name: Some("export.png".into()),
                }),
            ),
            ("host.speechState", json!({}), HostOp::SpeechState(HostIdPayload { id: None })),
            (
                "host.speechStart",
                json!({ "id": "s1" }),
                HostOp::SpeechStart(HostIdPayload { id: Some("s1".into()) }),
            ),
            ("host.speechStop", json!(null), HostOp::SpeechStop(HostIdPayload { id: None })),
            (
                "host.voiceState",
                json!({ "id": "v1" }),
                HostOp::VoiceState(HostIdPayload { id: Some("v1".into()) }),
            ),
            (
                "host.voiceStart",
                json!({ "id": "v1" }),
                HostOp::VoiceStart(HostIdPayload { id: Some("v1".into()) }),
            ),
            (
                "host.voiceStop",
                json!({ "id": "v1" }),
                HostOp::VoiceStop(HostIdPayload { id: Some("v1".into()) }),
            ),
            (
                "host.voiceMute",
                json!({ "id": "v1", "muted": true }),
                HostOp::VoiceMute(HostVoiceMutePayload {
                    id: Some("v1".into()),
                    muted: true,
                }),
            ),
            (
                "host.playAudio",
                json!({ "path": "/tmp/a.wav", "position": 1.5 }),
                HostOp::PlayAudio(HostPlayAudioPayload {
                    path: "/tmp/a.wav".into(),
                    position: Some(1.5),
                }),
            ),
            (
                "host.playSound",
                json!({ "name": "levelUp" }),
                HostOp::PlaySound(HostPlaySoundPayload { name: HostSoundName::LevelUp }),
            ),
            (
                "host.seekAudio",
                json!({ "position": 4.25 }),
                HostOp::SeekAudio(HostSeekAudioPayload { position: 4.25 }),
            ),
            ("host.audioState", json!(null), HostOp::AudioState),
            (
                "host.pcmStart",
                json!({ "sampleRate": 24000, "channels": 1 }),
                HostOp::PcmStart(HostPcmStartPayload {
                    sample_rate: 24000,
                    channels: 1,
                }),
            ),
            (
                "host.pcmAppend",
                json!({ "data": "AAAA" }),
                HostOp::PcmAppend(HostPcmAppendPayload { data: "AAAA".into() }),
            ),
            ("host.stopAudio", json!({}), HostOp::StopAudio),
            (
                "host.readFile",
                json!({ "path": "/tmp/note.txt" }),
                HostOp::ReadFile(HostReadFilePayload { path: "/tmp/note.txt".into() }),
            ),
            ("host.assetsDir", json!({}), HostOp::AssetsDir),
            (
                "host.sha256",
                json!({ "text": "abc" }),
                HostOp::Sha256(HostSha256Payload { text: "abc".into() }),
            ),
            (
                "host.randomBytes",
                json!({ "length": 32 }),
                HostOp::RandomBytes(HostRandomBytesPayload { length: 32 }),
            ),
            (
                "host.qr",
                json!({ "text": "https://vibevalley.dev", "border": 2 }),
                HostOp::Qr(HostQrPayload {
                    text: "https://vibevalley.dev".into(),
                    border: Some(2),
                }),
            ),
            ("host.appletList", json!(null), HostOp::AppletList),
            (
                "host.appletInstall",
                json!({
                    "artifactId": "art-1",
                    "artifactType": "dashboard",
                    "appName": "Metrics",
                    "alwaysOnTop": true
                }),
                HostOp::AppletInstall(HostAppletInstallPayload {
                    artifact_id: "art-1".into(),
                    artifact_type: "dashboard".into(),
                    app_name: "Metrics".into(),
                    always_on_top: true,
                }),
            ),
            (
                "host.appletUninstall",
                json!({ "artifactId": "art-1" }),
                HostOp::AppletUninstall(HostAppletIdPayload { artifact_id: "art-1".into() }),
            ),
            (
                "host.appletOpen",
                json!({ "artifactId": "art-1" }),
                HostOp::AppletOpen(HostAppletIdPayload { artifact_id: "art-1".into() }),
            ),
            ("host.captureWebView", json!(null), HostOp::CaptureWebView(HostCaptureWebViewPayload::default())),
            (
                "host.captureWebView",
                json!({ "width": 640, "height": 400 }),
                HostOp::CaptureWebView(HostCaptureWebViewPayload {
                    width: Some(640),
                    height: Some(400),
                }),
            ),
            ("host.vdpDiscover", json!(null), HostOp::VdpDiscover(HostVdpDiscoverPayload::default())),
            (
                "host.vdpDiscover",
                json!({ "extraHomes": ["/tmp/sandbox-home"] }),
                HostOp::VdpDiscover(HostVdpDiscoverPayload {
                    extra_homes: Some(vec!["/tmp/sandbox-home".into()]),
                }),
            ),
            (
                "host.vdpCall",
                json!({
                    "wsUrl": "ws://127.0.0.1:9222/devtools",
                    "port": 9222,
                    "token": "abc",
                    "method": "Target.list",
                    "params": {},
                    "sessionId": "s1",
                    "timeoutMs": 5000
                }),
                HostOp::VdpCall(HostVdpCallPayload {
                    ws_url: Some("ws://127.0.0.1:9222/devtools".into()),
                    port: Some(9222),
                    token: Some("abc".into()),
                    method: "Target.list".into(),
                    params: Some(json!({})),
                    session_id: Some("s1".into()),
                    timeout_ms: Some(5000),
                }),
            ),
        ];

        let mut seen = std::collections::BTreeSet::new();
        for (op, payload, want) in cases {
            let decoded = HostOp::from_wire(op, payload).unwrap_or_else(|e| panic!("{op}: {e}"));
            assert_eq!(decoded, want, "{op}");
            assert_eq!(decoded.op_name(), op);
            assert!(HostOp::is_known_op(op));
            seen.insert(op);
        }
        assert_eq!(seen.len(), HostOp::OP_NAMES.len(), "every HostOp variant must be tested");
    }

    #[test]
    fn host_op_from_wire_rejects_unknown_ops_and_malformed_payloads() {
        assert!(!HostOp::is_known_op("host.unknown"));
        assert!(!HostOp::is_known_op("host.pixelDir"));
        assert!(!HostOp::is_known_op("host.pixelManifest"));
        assert_eq!(HostOp::from_wire("host.unknown", json!({})).unwrap_err(), "the host has no op host.unknown");
        assert!(HostOp::from_wire("host.assetsDir", json!({ "extra": 1 })).is_err());
        assert!(HostOp::from_wire("host.info", json!({ "extra": 1 })).is_err());
        assert!(HostOp::from_wire("host.locale", json!("fr")).is_err());
        assert!(HostOp::from_wire("host.theme", json!("sepia")).is_err());
        assert!(HostOp::from_wire("host.motion", json!("reduced")).is_err());
        assert!(HostOp::from_wire("host.reveal", json!(42)).is_err());
        assert!(HostOp::from_wire("host.voiceMute", json!({ "id": "v1" })).is_err());
        assert!(HostOp::from_wire("host.playSound", json!({ "name": "tap", "extra": true })).is_err());
        assert!(HostOp::from_wire("host.pcmStart", json!({ "sampleRate": 24000, "channels": 1, "extra": 1 })).is_err());
        assert!(HostOp::from_wire("host.sha256", json!({ "text": "a", "extra": 1 })).is_err());
        assert!(HostOp::from_wire("host.randomBytes", json!({ "length": -1 })).is_err());
        assert!(HostOp::from_wire("host.qr", json!({ "text": "hi", "extra": 1 })).is_err());
        assert!(HostOp::from_wire("host.appletList", json!({ "extra": 1 })).is_err());
        assert!(HostOp::from_wire("host.appletInstall", json!({ "artifactId": "art-1" })).is_err());
        assert!(
            HostOp::from_wire(
                "host.appletInstall",
                json!({ "artifactId": "art-1", "artifactType": "docs", "appName": "Docs", "alwaysOnTop": false, "extra": 1 })
            )
            .is_err()
        );
        assert!(HostOp::from_wire("host.appletUninstall", json!({})).is_err());
        assert!(HostOp::from_wire("host.appletOpen", json!({ "artifactId": "art-1", "extra": 1 })).is_err());
        assert!(HostOp::from_wire("host.captureWebView", json!({ "width": 640, "extra": true })).is_err());
        assert!(HostOp::from_wire("host.vdpDiscover", json!({ "extra": true })).is_err());
        assert!(HostOp::from_wire("host.vdpCall", json!({})).is_err());
        assert!(HostOp::from_wire("host.vdpCall", json!({ "method": "Target.list", "extra": 1 })).is_err());
    }

    #[test]
    fn artifact_applet_info_round_trips_wire_json() {
        let info = ArtifactAppletInfo {
            artifact_id: "art-1".into(),
            artifact_type: "dashboard".into(),
            app_name: "Metrics".into(),
            bundle_id: "dev.vibevalley.applet.art-1".into(),
            bundle_path: "/Users/demo/Applications/VibeValley Apps/Metrics.app".into(),
            always_on_top: true,
            installed: true,
        };
        let encoded = serde_json::to_value(&info).unwrap();
        assert_eq!(
            encoded,
            json!({
                "artifactId": "art-1",
                "artifactType": "dashboard",
                "appName": "Metrics",
                "bundleId": "dev.vibevalley.applet.art-1",
                "bundlePath": "/Users/demo/Applications/VibeValley Apps/Metrics.app",
                "alwaysOnTop": true,
                "installed": true,
            })
        );
        assert_eq!(serde_json::from_value::<ArtifactAppletInfo>(encoded).unwrap(), info);
    }

    #[test]
    fn desktop_connection_snapshot_and_save_request_round_trip_wire_json() {
        let snapshot = DesktopConnectionSnapshot {
            active_mode: DesktopConnectionMode::Embedded,
            active_url: None,
            active_label: None,
            configured_mode: DesktopConnectionMode::Remote,
            configured_url: Some("https://hub.ts.net:8791".into()),
            configured_label: Some("Studio".into()),
            token_hint: Some("…abcd".into()),
            source: DesktopConnectionSource::File,
            restart_required: true,
        };
        let encoded = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(
            encoded,
            json!({
                "activeMode": "embedded",
                "configuredMode": "remote",
                "configuredUrl": "https://hub.ts.net:8791",
                "configuredLabel": "Studio",
                "tokenHint": "…abcd",
                "source": "file",
                "restartRequired": true,
            })
        );
        assert_eq!(serde_json::from_value::<DesktopConnectionSnapshot>(encoded).unwrap(), snapshot);

        let save: ConnectionSaveRequest = serde_json::from_value(json!({
            "url": "https://hub.ts.net:8791",
            "pairCode": "AB34CD",
            "label": "Studio",
        }))
        .unwrap();
        assert_eq!(
            save,
            ConnectionSaveRequest {
                url: "https://hub.ts.net:8791".into(),
                token: None,
                pair_code: Some("AB34CD".into()),
                device_name: None,
                label: Some("Studio".into()),
            }
        );
    }
}
