#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
#[cfg(feature = "ts-gen")]
use ts_rs::TS;

use super::*;
use crate::wire::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum ArtifactBody {
    #[serde(rename = "blocks")]
    Blocks,
    #[serde(rename = "html")]
    Html,
    #[serde(rename = "store")]
    Store,
}

impl ArtifactBody {
    pub const ALL: [ArtifactBody; 3] = [ArtifactBody::Blocks, ArtifactBody::Html, ArtifactBody::Store];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            ArtifactBody::Blocks => "blocks",
            ArtifactBody::Html => "html",
            ArtifactBody::Store => "store",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum ArtifactType {
    #[serde(rename = "docs")]
    Docs,
    #[serde(rename = "outline")]
    Outline,
    #[serde(rename = "slides")]
    Slides,
    #[serde(rename = "dashboard")]
    Dashboard,
    #[serde(rename = "motion")]
    Motion,
    #[serde(rename = "whiteboard")]
    Whiteboard,
    #[serde(rename = "design")]
    Design,
    #[serde(rename = "design-system")]
    DesignSystem,
}

impl ArtifactType {
    pub const ALL: [ArtifactType; 8] = [
        ArtifactType::Docs,
        ArtifactType::Outline,
        ArtifactType::Slides,
        ArtifactType::Dashboard,
        ArtifactType::Motion,
        ArtifactType::Whiteboard,
        ArtifactType::Design,
        ArtifactType::DesignSystem,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            ArtifactType::Docs => "docs",
            ArtifactType::Outline => "outline",
            ArtifactType::Slides => "slides",
            ArtifactType::Dashboard => "dashboard",
            ArtifactType::Motion => "motion",
            ArtifactType::Whiteboard => "whiteboard",
            ArtifactType::Design => "design",
            ArtifactType::DesignSystem => "design-system",
        }
    }

    /// Which storage body backs this structured artifact type.
    pub fn body(self) -> ArtifactBody {
        match self {
            ArtifactType::Docs | ArtifactType::Outline => ArtifactBody::Blocks,
            ArtifactType::Slides
            | ArtifactType::Dashboard
            | ArtifactType::Motion
            | ArtifactType::Whiteboard
            | ArtifactType::Design
            | ArtifactType::DesignSystem => ArtifactBody::Store,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum ArtifactEntryKind {
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "json")]
    Json,
    #[serde(rename = "asset")]
    Asset,
}

impl ArtifactEntryKind {
    pub const ALL: [ArtifactEntryKind; 3] = [ArtifactEntryKind::Text, ArtifactEntryKind::Json, ArtifactEntryKind::Asset];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            ArtifactEntryKind::Text => "text",
            ArtifactEntryKind::Json => "json",
            ArtifactEntryKind::Asset => "asset",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum ArtifactEntryOp {
    #[serde(rename = "set")]
    Set,
    #[serde(rename = "patch")]
    Patch,
    #[serde(rename = "delete")]
    Delete,
    #[serde(rename = "copy")]
    Copy,
}

impl ArtifactEntryOp {
    pub const ALL: [ArtifactEntryOp; 4] = [ArtifactEntryOp::Set, ArtifactEntryOp::Patch, ArtifactEntryOp::Delete, ArtifactEntryOp::Copy];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            ArtifactEntryOp::Set => "set",
            ArtifactEntryOp::Patch => "patch",
            ArtifactEntryOp::Delete => "delete",
            ArtifactEntryOp::Copy => "copy",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum ArtifactDisplay {
    #[serde(rename = "page")]
    Page,
    #[serde(rename = "slides")]
    Slides,
    #[serde(rename = "motion")]
    Motion,
}

impl ArtifactDisplay {
    pub const ALL: [ArtifactDisplay; 3] = [ArtifactDisplay::Page, ArtifactDisplay::Slides, ArtifactDisplay::Motion];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            ArtifactDisplay::Page => "page",
            ArtifactDisplay::Slides => "slides",
            ArtifactDisplay::Motion => "motion",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactCard {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    pub title: String,
    pub body: ArtifactBody,
    /// Announced version for html; seq for store; 0 for blocks.
    pub version: i64,
    pub note: String,
    /// Omit defaults to "page" for cards created before display modes existed.
    pub display: Option<ArtifactDisplay>,
    pub artifact_type: Option<ArtifactType>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct QuotedBlock {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub artifact_id: ArtifactId,
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::BlockId"))]
    pub block_id: BlockId,
    pub rev: i64,
    pub title: String,
    pub r#type: Option<String>,
    pub text: Option<String>,
    pub now_rev: Option<i64>,
    pub deleted: Option<bool>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BlockRef {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub artifact_id: ArtifactId,
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::BlockId"))]
    pub block_id: BlockId,
    pub rev: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum ArtifactKind {
    #[serde(rename = "html")]
    Html,
    #[serde(rename = "markdown")]
    Markdown,
    #[serde(rename = "store")]
    Store,
}

impl ArtifactKind {
    pub const ALL: [ArtifactKind; 3] = [ArtifactKind::Html, ArtifactKind::Markdown, ArtifactKind::Store];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            ArtifactKind::Html => "html",
            ArtifactKind::Markdown => "markdown",
            ArtifactKind::Store => "store",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactVersion {
    pub version: i64,
    pub size: i64,
    pub note: String,
    pub by: String,
    pub by_name: String,
    pub at: i64,
    pub channel: String,
    pub number: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSaid {
    pub channel: String,
    pub number: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    pub title: String,
    pub body: ArtifactBody,
    pub artifact_type: Option<ArtifactType>,
    /// True on the standing default design-system artifact consumed when creating visual artifacts.
    pub is_default: bool,
    /// html only; absent on blocks and store.
    pub display: Option<ArtifactDisplay>,
    pub channel: Option<String>,
    pub said: Option<ArtifactSaid>,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::IssueId>"))]
    pub issue: Option<IssueId>,
    pub by: String,
    pub by_name: String,
    /// Latest version for html; 0 for blocks and store.
    pub version: i64,
    /// Committed batch count for blocks and store; 0 for html.
    pub seq: i64,
    /// Oldest first for html; empty on blocks and store.
    pub versions: Vec<ArtifactVersion>,
    pub at: i64,
    pub updated: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEntryWriteInput {
    pub op: ArtifactEntryOp,
    pub path: String,
    pub kind: Option<ArtifactEntryKind>,
    /// UTF-8 text for text, JSON text for json/patch, or attachment id for asset.
    pub value: Option<String>,
    pub from: Option<String>,
    pub mime: Option<String>,
    /// Optimistic concurrency guard: 0 requires the path not to exist; >0 must match current rev.
    pub if_rev: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEntry {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub artifact_id: ArtifactId,
    pub path: String,
    pub kind: ArtifactEntryKind,
    pub mime: String,
    pub size: i64,
    pub rev: i64,
    pub updated_by: String,
    pub updated: i64,
    pub value: Option<String>,
    pub attachment_id: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEntrySnapshot {
    pub artifact: Artifact,
    pub seq: i64,
    pub entries: Vec<ArtifactEntry>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEntryConflict {
    pub path: String,
    pub expected_rev: i64,
    pub actual_rev: i64,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub current: Option<ArtifactEntry>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEntryBatchResult {
    pub applied: bool,
    pub seq: i64,
    pub entries: Vec<ArtifactEntry>,
    pub conflicts: Vec<ArtifactEntryConflict>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEntryListRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    pub prefix: Option<String>,
    pub include_values: Option<bool>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEntryGetRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    pub path: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEntryBatchRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    pub writes: Vec<ArtifactEntryWriteInput>,
    pub note: Option<String>,
    pub announce: Option<bool>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "_tag")]
pub enum ArtifactEntryEvent {
    #[serde(rename = "Entries", rename_all = "camelCase")]
    Entries {
        seq: i64,
        entries: Vec<ArtifactEntry>,
        deleted: Vec<String>,
    },
    #[serde(rename = "Reset")]
    Reset {},
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactTypeInfo {
    pub r#type: ArtifactType,
    pub body: ArtifactBody,
    pub title: String,
    pub summary: String,
    pub references: Vec<String>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::ArtifactId>"))]
    pub default_artifact_id: Option<ArtifactId>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactTypeReadRequest {
    pub r#type: ArtifactType,
    pub reference: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactTypeGuide {
    pub r#type: ArtifactType,
    pub title: String,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub reference: Option<String>,
    pub content: String,
    pub references: Vec<String>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::ArtifactId>"))]
    pub default_artifact_id: Option<ArtifactId>,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub default_artifact_title: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactViewContext {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub artifact_id: ArtifactId,
    pub artifact_type: Option<ArtifactType>,
    pub title: String,
    pub seq: Option<i64>,
    pub version: Option<i64>,
    pub slide_id: Option<String>,
    pub slide_index: Option<i64>,
    pub time: Option<JsNumber>,
    pub active_artboard: Option<String>,
    pub active_dataset: Option<String>,
    pub active_tab: Option<String>,
    pub selected_ids: Option<Vec<String>>,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<Vec<crate::typescript::BlockId>>"))]
    pub selected_block_ids: Option<Vec<BlockId>>,
    pub summary: Option<String>,
}

/// Omit content to create an unannounced empty blocks or store artifact.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRequest {
    pub title: String,
    pub kind: Option<ArtifactKind>,
    pub artifact_type: Option<ArtifactType>,
    /// html only; defaults to "page".
    pub display: Option<ArtifactDisplay>,
    pub content: Option<String>,
    pub entries: Option<Vec<ArtifactEntryWriteInput>>,
    pub is_default: Option<bool>,
    pub announce: Option<bool>,
    pub note: Option<String>,
    pub channel: Option<String>,
    pub issue: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactVersionRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    pub content: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum HtmlAnchorKind {
    #[serde(rename = "text")]
    Text,
}

impl HtmlAnchorKind {
    pub const ALL: [HtmlAnchorKind; 1] = [HtmlAnchorKind::Text];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            HtmlAnchorKind::Text => "text",
        }
    }
}

/// W3C Web Annotation TextQuoteSelector over text nodes outside <script> and <style>.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct HtmlAnchor {
    pub kind: HtmlAnchorKind,
    pub exact: String,
    pub prefix: String,
    pub suffix: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactHtmlEdit {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    pub version: i64,
    pub path: Option<String>,
    pub anchor: HtmlAnchor,
    pub text: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactUpdateRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    pub title: Option<String>,
    pub display: Option<ArtifactDisplay>,
    pub is_default: Option<bool>,
}

pub type ShellCount = i64;

pub type ShellTime = JsNumber;

pub type ShellWords = Vec<String>;

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ShellChapter {
    pub at: ShellTime,
    pub label: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "vibevalley")]
pub enum HtmlShellMessage {
    #[serde(rename = "selection", rename_all = "camelCase")]
    Selection { anchor: HtmlAnchor, path: Option<String> },
    #[serde(rename = "ready", rename_all = "camelCase")]
    Ready {
        display: ArtifactDisplay,
        pages: Option<ShellCount>,
        titles: Option<ShellWords>,
        notes: Option<ShellWords>,
        fragments: Option<Vec<ShellCount>>,
        duration: Option<ShellTime>,
        fps: Option<i64>,
        chapters: Option<Vec<ShellChapter>>,
    },
    #[serde(rename = "at", rename_all = "camelCase")]
    At {
        page: Option<ShellCount>,
        fragment: Option<ShellCount>,
        time: Option<ShellTime>,
        playing: Option<bool>,
    },
    #[serde(rename = "recorded", rename_all = "camelCase")]
    Recorded {
        ok: bool,
        mime_type: Option<String>,
        base64: Option<String>,
        reason: Option<String>,
    },
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "vibevalley")]
pub enum HtmlShellCommand {
    #[serde(rename = "goto", rename_all = "camelCase")]
    Goto { page: ShellCount, fragment: Option<ShellCount> },
    #[serde(rename = "step", rename_all = "camelCase")]
    Step { delta: i64 },
    #[serde(rename = "seek", rename_all = "camelCase")]
    Seek { time: ShellTime },
    #[serde(rename = "play")]
    Play {},
    #[serde(rename = "pause")]
    Pause {},
    #[serde(rename = "record", rename_all = "camelCase")]
    Record { fps: Option<i64> },
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactListRequest {
    pub channel: Option<String>,
    pub issue: Option<String>,
    pub artifact_type: Option<ArtifactType>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactReadRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    pub version: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactContent {
    pub version: i64,
    pub content: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SpanMarks {
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub code: Option<bool>,
    pub strike: Option<bool>,
    pub link: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct TextSpan {
    pub t: String,
    pub marks: SpanMarks,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BlockAttrs {
    pub level: Option<i64>,
    pub checked: Option<bool>,
    pub language: Option<String>,
    pub src: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub alt: Option<String>,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::IssueId>"))]
    pub issue_id: Option<IssueId>,
    pub memory_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum BlockType {
    #[serde(rename = "paragraph")]
    Paragraph,
    #[serde(rename = "heading")]
    Heading,
    #[serde(rename = "bulleted")]
    Bulleted,
    #[serde(rename = "numbered")]
    Numbered,
    #[serde(rename = "todo")]
    Todo,
    #[serde(rename = "quote")]
    Quote,
    #[serde(rename = "code")]
    Code,
    #[serde(rename = "divider")]
    Divider,
    #[serde(rename = "image")]
    Image,
    #[serde(rename = "issue_ref")]
    IssueRef,
    #[serde(rename = "memory_item")]
    MemoryItem,
}

impl BlockType {
    pub const ALL: [BlockType; 11] = [
        BlockType::Paragraph,
        BlockType::Heading,
        BlockType::Bulleted,
        BlockType::Numbered,
        BlockType::Todo,
        BlockType::Quote,
        BlockType::Code,
        BlockType::Divider,
        BlockType::Image,
        BlockType::IssueRef,
        BlockType::MemoryItem,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            BlockType::Paragraph => "paragraph",
            BlockType::Heading => "heading",
            BlockType::Bulleted => "bulleted",
            BlockType::Numbered => "numbered",
            BlockType::Todo => "todo",
            BlockType::Quote => "quote",
            BlockType::Code => "code",
            BlockType::Divider => "divider",
            BlockType::Image => "image",
            BlockType::IssueRef => "issue_ref",
            BlockType::MemoryItem => "memory_item",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BlockInput {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::BlockId"))]
    pub id: BlockId,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::BlockId>"))]
    pub parent_id: Option<BlockId>,
    pub order_key: String,
    pub r#type: BlockType,
    pub attrs: BlockAttrs,
    pub text: Vec<TextSpan>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Block {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::BlockId"))]
    pub id: BlockId,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::BlockId>"))]
    pub parent_id: Option<BlockId>,
    pub order_key: String,
    pub r#type: BlockType,
    pub attrs: BlockAttrs,
    pub text: Vec<TextSpan>,
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub artifact_id: ArtifactId,
    pub rev: i64,
    pub deleted: Option<bool>,
    pub updated_by: String,
    pub updated: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BlockSnapshot {
    pub artifact: Artifact,
    pub blocks: Vec<Block>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactMarkdown {
    pub markdown: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BlockOpInsertBlock {
    pub block: BlockInput,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BlockOpUpdateText {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::BlockId"))]
    pub block_id: BlockId,
    pub base_rev: i64,
    pub text: Vec<TextSpan>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BlockOpSetAttrs {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::BlockId"))]
    pub block_id: BlockId,
    pub attrs: BlockAttrs,
    pub unset: Option<Vec<String>>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BlockOpSetType {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::BlockId"))]
    pub block_id: BlockId,
    pub r#type: BlockType,
    pub attrs: BlockAttrs,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BlockOpMoveBlock {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::BlockId"))]
    pub block_id: BlockId,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::BlockId>"))]
    pub parent_id: Option<BlockId>,
    pub order_key: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BlockOpDeleteBlock {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::BlockId"))]
    pub block_id: BlockId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BlockOpRestoreBlock {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::BlockId"))]
    pub block_id: BlockId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BlockOpSplitBlock {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::BlockId"))]
    pub block_id: BlockId,
    pub base_rev: i64,
    pub offset: i64,
    pub new_block: BlockInput,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BlockOpMergeBlocks {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::BlockId"))]
    pub target_id: BlockId,
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::BlockId"))]
    pub source_id: BlockId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "op")]
pub enum BlockOp {
    #[serde(rename = "insert_block")]
    InsertBlock(BlockOpInsertBlock),
    #[serde(rename = "update_text")]
    UpdateText(BlockOpUpdateText),
    #[serde(rename = "set_attrs")]
    SetAttrs(BlockOpSetAttrs),
    #[serde(rename = "set_type")]
    SetType(BlockOpSetType),
    #[serde(rename = "move_block")]
    MoveBlock(BlockOpMoveBlock),
    #[serde(rename = "delete_block")]
    DeleteBlock(BlockOpDeleteBlock),
    #[serde(rename = "restore_block")]
    RestoreBlock(BlockOpRestoreBlock),
    #[serde(rename = "split_block")]
    SplitBlock(BlockOpSplitBlock),
    #[serde(rename = "merge_blocks")]
    MergeBlocks(BlockOpMergeBlocks),
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BlockSubmit {
    pub batch_id: String,
    pub last_seq: i64,
    pub ops: Vec<BlockOp>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum BlockOpStatus {
    #[serde(rename = "applied")]
    Applied,
    #[serde(rename = "merged")]
    Merged,
    #[serde(rename = "conflict")]
    Conflict,
    #[serde(rename = "noop")]
    Noop,
    #[serde(rename = "rejected")]
    Rejected,
}

impl BlockOpStatus {
    pub const ALL: [BlockOpStatus; 5] = [
        BlockOpStatus::Applied,
        BlockOpStatus::Merged,
        BlockOpStatus::Conflict,
        BlockOpStatus::Noop,
        BlockOpStatus::Rejected,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            BlockOpStatus::Applied => "applied",
            BlockOpStatus::Merged => "merged",
            BlockOpStatus::Conflict => "conflict",
            BlockOpStatus::Noop => "noop",
            BlockOpStatus::Rejected => "rejected",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BlockCreate {
    pub r#type: Option<String>,
    /// 1 to 3; defaults to 2.
    pub level: Option<i64>,
    pub checked: Option<bool>,
    pub language: Option<String>,
    pub text: String,
    /// "" inserts first; omit appends at the end.
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::BlockId>"))]
    pub after_block: Option<BlockId>,
    /// Omit inserts at the top level.
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::BlockId>"))]
    pub parent_id: Option<BlockId>,
}

/// Conflicts when text is changed against a stale baseRev.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BlockUpdate {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::BlockId"))]
    pub block: BlockId,
    pub base_rev: i64,
    /// Full replacement text, not a delta.
    pub text: Option<String>,
    pub r#type: Option<String>,
    pub level: Option<i64>,
    pub checked: Option<bool>,
    pub language: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BlockDelete {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::BlockId"))]
    pub block: BlockId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BlockOpResult {
    pub status: BlockOpStatus,
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::BlockId"))]
    pub block_id: BlockId,
    pub rev: Option<i64>,
    pub text: Option<Vec<TextSpan>>,
    pub yours: Option<Vec<TextSpan>>,
    pub reason: Option<String>,
    /// Populated when an agent edit to a user-authored block was diverted into a suggestion.
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::SuggestionId>"))]
    pub suggestion: Option<SuggestionId>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BlockAck {
    pub batch_id: String,
    pub seq: i64,
    pub results: Vec<BlockOpResult>,
    pub blocks: Vec<Block>,
}

/// Reset is sent when the client falls too far behind the batch log.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "_tag")]
pub enum ArtifactEvent {
    #[serde(rename = "Blocks", rename_all = "camelCase")]
    Blocks { seq: i64, blocks: Vec<Block> },
    #[serde(rename = "Reset")]
    Reset {},
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum SuggestionStatus {
    #[serde(rename = "open")]
    Open,
    #[serde(rename = "accepted")]
    Accepted,
    #[serde(rename = "rejected")]
    Rejected,
}

impl SuggestionStatus {
    pub const ALL: [SuggestionStatus; 3] = [SuggestionStatus::Open, SuggestionStatus::Accepted, SuggestionStatus::Rejected];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            SuggestionStatus::Open => "open",
            SuggestionStatus::Accepted => "accepted",
            SuggestionStatus::Rejected => "rejected",
        }
    }
}

/// At least one field must be set.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SuggestionChange {
    pub text: Option<Vec<TextSpan>>,
    pub r#type: Option<BlockType>,
    pub attrs: Option<BlockAttrs>,
    pub unset: Option<Vec<String>>,
    pub delete: Option<bool>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::SuggestionId"))]
    pub id: SuggestionId,
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub artifact_id: ArtifactId,
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::BlockId"))]
    pub block_id: BlockId,
    pub author: String,
    pub base_rev: i64,
    pub change: SuggestionChange,
    pub status: SuggestionStatus,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
    pub resolved_by: Option<String>,
    pub cursor_start: Option<String>,
    pub cursor_end: Option<String>,
    pub start_offset: Option<u32>,
    pub end_offset: Option<u32>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SuggestionCreate {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::BlockId"))]
    pub block: BlockId,
    pub base_rev: i64,
    pub change: SuggestionChange,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum SuggestionEventKind {
    #[serde(rename = "Suggestions")]
    Suggestions,
}

impl SuggestionEventKind {
    pub const ALL: [SuggestionEventKind; 1] = [SuggestionEventKind::Suggestions];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            SuggestionEventKind::Suggestions => "Suggestions",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SuggestionEvent {
    #[serde(rename = "_tag")]
    pub tag: SuggestionEventKind,
    pub suggestions: Vec<Suggestion>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactGetInput {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDeleteInput {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactBlockListInput {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSubmitInput {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    pub batch_id: String,
    pub last_seq: i64,
    pub ops: Vec<BlockOp>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactBlockCreateInput {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    pub r#type: Option<String>,
    pub level: Option<i64>,
    pub checked: Option<bool>,
    pub language: Option<String>,
    pub text: String,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::BlockId>"))]
    pub after_block: Option<BlockId>,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::BlockId>"))]
    pub parent_id: Option<BlockId>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactBlockUpdateInput {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::BlockId"))]
    pub block: BlockId,
    pub base_rev: i64,
    pub text: Option<String>,
    pub r#type: Option<String>,
    pub level: Option<i64>,
    pub checked: Option<bool>,
    pub language: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactBlockDeleteInput {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::BlockId"))]
    pub block: BlockId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSuggestionListInput {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSuggestionCreateInput {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::BlockId"))]
    pub block: BlockId,
    pub base_rev: i64,
    pub change: SuggestionChange,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSuggestionAcceptInput {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::SuggestionId"))]
    pub suggestion: SuggestionId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactMarkdownGetInput {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
}

/// Imports a `.md` document into a new `ArtifactType::Outline` blocks artifact.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactOutlineImportRequest {
    pub markdown: String,
    pub title: Option<String>,
    pub filename: Option<String>,
    pub channel: Option<String>,
    pub issue: Option<String>,
    pub announce: Option<bool>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum ArtifactPresenceKind {
    #[serde(rename = "cursor")]
    Cursor,
    #[serde(rename = "block_cursor")]
    BlockCursor,
    #[serde(rename = "selection")]
    Selection,
    #[serde(rename = "highlight")]
    Highlight,
    #[serde(rename = "viewport")]
    Viewport,
}

impl ArtifactPresenceKind {
    pub const ALL: [ArtifactPresenceKind; 5] = [
        ArtifactPresenceKind::Cursor,
        ArtifactPresenceKind::BlockCursor,
        ArtifactPresenceKind::Selection,
        ArtifactPresenceKind::Highlight,
        ArtifactPresenceKind::Viewport,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            ArtifactPresenceKind::Cursor => "cursor",
            ArtifactPresenceKind::BlockCursor => "block_cursor",
            ArtifactPresenceKind::Selection => "selection",
            ArtifactPresenceKind::Highlight => "highlight",
            ArtifactPresenceKind::Viewport => "viewport",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ViewportRect {
    pub x: JsNumber,
    pub y: JsNumber,
    pub w: JsNumber,
    pub h: JsNumber,
    pub zoom: Option<JsNumber>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPresence {
    /// Stable actor/peer identifier (e.g. "user" or "session:<id>").
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub kind: ArtifactPresenceKind,
    pub x: Option<JsNumber>,
    pub y: Option<JsNumber>,
    pub w: Option<JsNumber>,
    pub h: Option<JsNumber>,
    pub status: Option<String>,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::BlockId>"))]
    pub block_id: Option<BlockId>,
    pub offset: Option<u32>,
    pub end_offset: Option<u32>,
    pub selector: Option<String>,
    pub path: Option<String>,
    pub viewport: Option<ViewportRect>,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::SessionId>"))]
    pub session_id: Option<SessionId>,
    pub updated_at: i64,
}

/// Omit `presence` to remove the caller's live presence entry immediately.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPresenceUpdateRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    pub presence: Option<ArtifactPresence>,
    pub peer_id: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPresenceFollowRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "_tag")]
pub enum ArtifactPresenceEvent {
    #[serde(rename = "Snapshot", rename_all = "camelCase")]
    Snapshot { peers: Vec<ArtifactPresence> },
    #[serde(rename = "Upsert", rename_all = "camelCase")]
    Upsert { peer: ArtifactPresence },
    #[serde(rename = "Remove", rename_all = "camelCase")]
    Remove { peer_id: String },
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactHistoryEntry {
    /// Encoded Loro frontiers identifying this commit snapshot.
    pub frontiers: String,
    pub author: String,
    pub agent: Option<String>,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::SessionId>"))]
    pub session_id: Option<SessionId>,
    pub turn: Option<i64>,
    pub origin: String,
    pub summary: Option<String>,
    pub at: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactHistoryListRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    pub limit: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactHistoryPreviewRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    pub frontiers: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactHistoryPreviewResult {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub artifact_id: ArtifactId,
    pub body: ArtifactBody,
    pub artifact_type: Option<ArtifactType>,
    pub frontiers: String,
    pub entry: Option<ArtifactHistoryEntry>,
    pub blocks: Option<Vec<Block>>,
    pub entries: Option<Vec<ArtifactEntry>>,
    pub html: Option<String>,
    pub markdown: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactHistoryRestoreRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    pub frontiers: String,
    pub note: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactHistoryForkRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    pub frontiers: String,
    pub title: Option<String>,
    pub channel: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactHistoryUndoOriginRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    pub origin: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactHistoryCompactRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
}

#[cfg(feature = "ts-gen")]
crate::typescript::module! {
    "artifact";
    types: [ArtifactBody,
    ArtifactType,
    ArtifactEntryKind,
    ArtifactEntryOp,
    ArtifactDisplay,
    ArtifactCard,
    QuotedBlock,
    BlockRef,
    ArtifactKind,
    ArtifactVersion,
    ArtifactSaid,
    Artifact,
    ArtifactEntryWriteInput,
    ArtifactEntry,
    ArtifactEntrySnapshot,
    ArtifactEntryConflict,
    ArtifactEntryBatchResult,
    ArtifactEntryListRequest,
    ArtifactEntryGetRequest,
    ArtifactEntryBatchRequest,
    ArtifactEntryEvent,
    ArtifactTypeInfo,
    ArtifactTypeReadRequest,
    ArtifactTypeGuide,
    ArtifactViewContext,
    ArtifactRequest,
    ArtifactVersionRequest,
    HtmlAnchorKind,
    HtmlAnchor,
    ArtifactHtmlEdit,
    ArtifactUpdateRequest,
    ShellChapter,
    HtmlShellMessage,
    HtmlShellCommand,
    ArtifactListRequest,
    ArtifactReadRequest,
    ArtifactContent,
    SpanMarks,
    TextSpan,
    BlockAttrs,
    BlockType,
    BlockInput,
    Block,
    BlockSnapshot,
    ArtifactMarkdown,
    BlockOpInsertBlock,
    BlockOpUpdateText,
    BlockOpSetAttrs,
    BlockOpSetType,
    BlockOpMoveBlock,
    BlockOpDeleteBlock,
    BlockOpRestoreBlock,
    BlockOpSplitBlock,
    BlockOpMergeBlocks,
    BlockOp,
    BlockSubmit,
    BlockOpStatus,
    BlockCreate,
    BlockUpdate,
    BlockDelete,
    BlockOpResult,
    BlockAck,
    ArtifactEvent,
    SuggestionStatus,
    SuggestionChange,
    Suggestion,
    SuggestionCreate,
    SuggestionEventKind,
    SuggestionEvent,
    ArtifactGetInput,
    ArtifactDeleteInput,
    ArtifactBlockListInput,
    ArtifactSubmitInput,
    ArtifactBlockCreateInput,
    ArtifactBlockUpdateInput,
    ArtifactBlockDeleteInput,
    ArtifactSuggestionListInput,
    ArtifactSuggestionCreateInput,
    ArtifactSuggestionAcceptInput,
    ArtifactMarkdownGetInput,
    ArtifactOutlineImportRequest,
    ArtifactPresenceKind,
    ViewportRect,
    ArtifactPresence,
    ArtifactPresenceUpdateRequest,
    ArtifactPresenceFollowRequest,
    ArtifactPresenceEvent,
    ArtifactHistoryEntry,
    ArtifactHistoryListRequest,
    ArtifactHistoryPreviewRequest,
    ArtifactHistoryPreviewResult,
    ArtifactHistoryRestoreRequest,
    ArtifactHistoryForkRequest,
    ArtifactHistoryUndoOriginRequest,
    ArtifactHistoryCompactRequest];
    aliases: [ShellCount,
    ShellTime,
    ShellWords];
}
