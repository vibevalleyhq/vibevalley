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
    HostAction];
    aliases: [];
}
