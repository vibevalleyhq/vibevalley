#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
#[cfg(feature = "ts-gen")]
use ts_rs::TS;

use super::*;
use crate::wire::*;

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
    #[serde(rename = "sheet")]
    Sheet,
    #[serde(rename = "prototype")]
    Prototype,
    #[serde(rename = "diagram")]
    Diagram,
    #[serde(rename = "storyboard")]
    Storyboard,
}

impl ArtifactType {
    pub const ALL: [ArtifactType; 12] = [
        ArtifactType::Docs,
        ArtifactType::Outline,
        ArtifactType::Slides,
        ArtifactType::Dashboard,
        ArtifactType::Motion,
        ArtifactType::Whiteboard,
        ArtifactType::Design,
        ArtifactType::DesignSystem,
        ArtifactType::Sheet,
        ArtifactType::Prototype,
        ArtifactType::Diagram,
        ArtifactType::Storyboard,
    ];

    /// The kebab-case string on the wire and skill folder name under `crates/server/assets/artifact/types/`.
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
            ArtifactType::Sheet => "sheet",
            ArtifactType::Prototype => "prototype",
            ArtifactType::Diagram => "diagram",
            ArtifactType::Storyboard => "storyboard",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "docs" => Some(ArtifactType::Docs),
            "outline" => Some(ArtifactType::Outline),
            "slides" => Some(ArtifactType::Slides),
            "dashboard" => Some(ArtifactType::Dashboard),
            "motion" => Some(ArtifactType::Motion),
            "whiteboard" => Some(ArtifactType::Whiteboard),
            "design" => Some(ArtifactType::Design),
            "design-system" => Some(ArtifactType::DesignSystem),
            "sheet" => Some(ArtifactType::Sheet),
            "prototype" => Some(ArtifactType::Prototype),
            "diagram" => Some(ArtifactType::Diagram),
            "storyboard" => Some(ArtifactType::Storyboard),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum ArtifactFileEncoding {
    #[serde(rename = "utf8")]
    Utf8,
    #[serde(rename = "base64")]
    Base64,
}

impl ArtifactFileEncoding {
    pub const ALL: [ArtifactFileEncoding; 2] = [ArtifactFileEncoding::Utf8, ArtifactFileEncoding::Base64];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            ArtifactFileEncoding::Utf8 => "utf8",
            ArtifactFileEncoding::Base64 => "base64",
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
    pub artifact_type: ArtifactType,
    pub version: i64,
    pub note: String,
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
    pub artifact_type: ArtifactType,
    /// True on the standing default design-system artifact consumed when creating visual artifacts.
    pub is_default: bool,
    pub channel: Option<String>,
    pub said: Option<ArtifactSaid>,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::IssueId>"))]
    pub issue: Option<IssueId>,
    pub by: String,
    pub by_name: String,
    /// Latest immutable snapshot version number; 0 before any snapshot is cut.
    pub version: i64,
    /// Monotonic collaborative revision sequence bumped on each committed file or collab write.
    pub seq: i64,
    /// Immutable version snapshots, oldest first.
    pub versions: Vec<ArtifactVersion>,
    pub at: i64,
    pub updated: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFileMeta {
    /// Relative path inside `<storage>/artifact/<id>/` (e.g. `manifest.json`, `structure/index.md`, `asset/hero.png`).
    pub path: String,
    pub mime: String,
    pub size: i64,
    /// Content SHA-256 hex digest.
    pub hash: String,
    pub updated_at: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFileListRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    /// Optional relative prefix filter (e.g. `structure/` or `asset/`).
    pub prefix: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFileListResult {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub artifact_id: ArtifactId,
    pub seq: i64,
    pub files: Vec<ArtifactFileMeta>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFileGetRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    pub path: String,
    /// Optional immutable version snapshot number to read from.
    pub version: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFileContent {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub artifact_id: ArtifactId,
    pub path: String,
    pub mime: String,
    pub encoding: ArtifactFileEncoding,
    pub content: String,
    pub size: i64,
    pub hash: String,
    pub updated_at: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFileWriteItem {
    /// Relative path inside `<storage>/artifact/<id>/` (`manifest.json`, `structure/*`, or `asset/*`).
    pub path: String,
    /// UTF-8 text (default) or base64-encoded bytes when `encoding` is `base64`.
    pub content: String,
    pub encoding: Option<ArtifactFileEncoding>,
    pub mime: Option<String>,
    /// Optional optimistic concurrency guard matching the file's current SHA-256 hash (`""` requires absent).
    pub expected_hash: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFileWriteRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    pub files: Vec<ArtifactFileWriteItem>,
    /// Attribution origin (e.g. `user`, `session:<id>:turn:<n>`); defaults to caller identity.
    pub origin: Option<String>,
    pub summary: Option<String>,
    pub announce: Option<bool>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFileWriteResult {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub artifact_id: ArtifactId,
    pub seq: i64,
    pub files: Vec<ArtifactFileMeta>,
    pub frontiers: Option<String>,
    /// Populated when an agent write to a human-owned region was diverted into review suggestions.
    pub suggestions: Option<Vec<Suggestion>>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFileDeleteRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    /// Relative path under `structure/` or `asset/` to delete.
    pub path: String,
    pub origin: Option<String>,
    pub summary: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFileDeleteResult {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub artifact_id: ArtifactId,
    pub seq: i64,
    pub path: String,
    pub frontiers: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactTypeInfo {
    pub r#type: ArtifactType,
    pub title: String,
    pub summary: String,
    /// Canonical primary entry path inside `<storage>/artifact/<id>/`.
    pub entry: String,
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
    pub artifact_type: ArtifactType,
    pub title: String,
    pub seq: Option<i64>,
    pub version: Option<i64>,
    /// Active relative file path inside `structure/` (e.g. `structure/slides/s02-kpi.json`).
    pub active_path: Option<String>,
    pub slide_id: Option<String>,
    pub slide_index: Option<i64>,
    pub time: Option<JsNumber>,
    pub active_artboard: Option<String>,
    pub active_dataset: Option<String>,
    pub active_tab: Option<String>,
    pub selected_ids: Option<Vec<String>>,
    pub summary: Option<String>,
}

/// Creates a new directory-backed artifact seeded with starter files for `artifact_type`
/// (and optional initial `content` for the entry file or additional `files`).
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRequest {
    pub title: String,
    pub artifact_type: ArtifactType,
    pub content: Option<String>,
    pub files: Option<Vec<ArtifactFileWriteItem>>,
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
    /// Optional updated primary entry content before snapshotting; omit to snapshot current directory state.
    pub content: Option<String>,
    pub note: Option<String>,
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
    pub is_default: Option<bool>,
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

/// Reset is sent when the subscriber falls too far behind the collaborative change log.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "_tag")]
pub enum ArtifactEvent {
    #[serde(rename = "Files", rename_all = "camelCase")]
    Files {
        seq: i64,
        files: Vec<ArtifactFileMeta>,
        deleted: Vec<String>,
        origin: Option<String>,
        frontiers: Option<String>,
    },
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

/// Proposed edit to a file or structured target inside an artifact directory.
/// At least one of `content`, `patch`, or `delete` must be set.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SuggestionChange {
    pub content: Option<String>,
    pub patch: Option<String>,
    pub target: Option<String>,
    pub delete: Option<bool>,
    pub summary: Option<String>,
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
    /// Relative path inside `<storage>/artifact/<id>/` (e.g. `structure/index.md`).
    pub path: String,
    pub author: String,
    pub base_rev: i64,
    pub base_hash: Option<String>,
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
    pub path: String,
    pub base_rev: i64,
    pub base_hash: Option<String>,
    pub change: SuggestionChange,
    pub cursor_start: Option<String>,
    pub cursor_end: Option<String>,
    pub start_offset: Option<u32>,
    pub end_offset: Option<u32>,
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
    pub path: String,
    pub base_rev: i64,
    pub base_hash: Option<String>,
    pub change: SuggestionChange,
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
pub struct ArtifactSuggestionAcceptInput {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::ArtifactId"))]
    pub id: ArtifactId,
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::SuggestionId"))]
    pub suggestion: SuggestionId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum ArtifactPresenceKind {
    #[serde(rename = "cursor")]
    Cursor,
    #[serde(rename = "selection")]
    Selection,
    #[serde(rename = "highlight")]
    Highlight,
    #[serde(rename = "viewport")]
    Viewport,
}

impl ArtifactPresenceKind {
    pub const ALL: [ArtifactPresenceKind; 4] = [
        ArtifactPresenceKind::Cursor,
        ArtifactPresenceKind::Selection,
        ArtifactPresenceKind::Highlight,
        ArtifactPresenceKind::Viewport,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            ArtifactPresenceKind::Cursor => "cursor",
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
    /// Focused element, outline node, slide, or cell identifier inside `path`.
    pub node_id: Option<String>,
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
    pub artifact_type: ArtifactType,
    pub frontiers: String,
    pub entry: Option<ArtifactHistoryEntry>,
    pub files: Vec<ArtifactFileContent>,
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
    types: [ArtifactType,
    ArtifactFileEncoding,
    ArtifactCard,
    ArtifactVersion,
    ArtifactSaid,
    Artifact,
    ArtifactFileMeta,
    ArtifactFileListRequest,
    ArtifactFileListResult,
    ArtifactFileGetRequest,
    ArtifactFileContent,
    ArtifactFileWriteItem,
    ArtifactFileWriteRequest,
    ArtifactFileWriteResult,
    ArtifactFileDeleteRequest,
    ArtifactFileDeleteResult,
    ArtifactTypeInfo,
    ArtifactTypeReadRequest,
    ArtifactTypeGuide,
    ArtifactViewContext,
    ArtifactRequest,
    ArtifactVersionRequest,
    ArtifactUpdateRequest,
    ArtifactListRequest,
    ArtifactReadRequest,
    ArtifactContent,
    ArtifactGetInput,
    ArtifactDeleteInput,
    ArtifactEvent,
    SuggestionStatus,
    SuggestionChange,
    Suggestion,
    SuggestionCreate,
    SuggestionEventKind,
    SuggestionEvent,
    ArtifactSuggestionListInput,
    ArtifactSuggestionCreateInput,
    ArtifactSuggestionAcceptInput,
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
    aliases: [];
}
