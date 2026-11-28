#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
#[cfg(feature = "ts-gen")]
use ts_rs::TS;

use super::*;
use crate::wire::*;

/// Four consolidated note primitives (`doc`, `base`, `canvas`, `media`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum NoteType {
    #[serde(rename = "doc")]
    Doc,
    #[serde(rename = "base")]
    Base,
    #[serde(rename = "canvas")]
    Canvas,
    #[serde(rename = "media")]
    Media,
}

impl NoteType {
    pub const ALL: [NoteType; 4] = [NoteType::Doc, NoteType::Base, NoteType::Canvas, NoteType::Media];

    /// The kebab-case string on the wire and skill folder name under `crates/server/assets/note/types/`.
    pub fn as_str(self) -> &'static str {
        match self {
            NoteType::Doc => "doc",
            NoteType::Base => "base",
            NoteType::Canvas => "canvas",
            NoteType::Media => "media",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "doc" => Some(NoteType::Doc),
            "base" => Some(NoteType::Base),
            "canvas" => Some(NoteType::Canvas),
            "media" => Some(NoteType::Media),
            _ => None,
        }
    }
}

/// Static directory layout specification for one of the 4 `NoteType` primitives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct NoteTypeSpec {
    pub note_type: NoteType,
    /// Kebab-case slug matching `crates/server/assets/note/types/<slug>/`.
    pub slug: &'static str,
    /// Primary entry file path inside `<storage>/note/<id>/`.
    pub entry_path: &'static str,
    /// MIME type of the primary entry file.
    pub entry_mime: &'static str,
    /// Relative directories created inside `<storage>/note/<id>/`.
    pub default_dirs: &'static [&'static str],
    /// Default suffix when exporting a single file for the user.
    pub export_suffix: &'static str,
}

const ALL_SPECS: [NoteTypeSpec; 4] = [
    NoteTypeSpec {
        note_type: NoteType::Doc,
        slug: "doc",
        entry_path: "structure/doc.json",
        entry_mime: "application/json",
        default_dirs: &["structure", "asset"],
        export_suffix: ".md",
    },
    NoteTypeSpec {
        note_type: NoteType::Base,
        slug: "base",
        entry_path: "structure/base.json",
        entry_mime: "application/json",
        default_dirs: &["structure", "asset"],
        export_suffix: ".base.json",
    },
    NoteTypeSpec {
        note_type: NoteType::Canvas,
        slug: "canvas",
        entry_path: "structure/board.json",
        entry_mime: "application/json",
        default_dirs: &["structure", "asset"],
        export_suffix: ".canvas.json",
    },
    NoteTypeSpec {
        note_type: NoteType::Media,
        slug: "media",
        entry_path: "structure/media.json",
        entry_mime: "application/json",
        default_dirs: &["structure", "asset", "asset/audio", "asset/video", "asset/image"],
        export_suffix: ".media.json",
    },
];

/// Returns all 4 canonical note type specifications in `NoteType::ALL` order.
pub fn all_type_specs() -> &'static [NoteTypeSpec] {
    &ALL_SPECS
}

/// Returns the canonical directory specification for `note_type`.
pub fn type_spec(note_type: NoteType) -> &'static NoteTypeSpec {
    match note_type {
        NoteType::Doc => &ALL_SPECS[0],
        NoteType::Base => &ALL_SPECS[1],
        NoteType::Canvas => &ALL_SPECS[2],
        NoteType::Media => &ALL_SPECS[3],
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum NoteFileEncoding {
    #[serde(rename = "utf8")]
    Utf8,
    #[serde(rename = "base64")]
    Base64,
}

impl NoteFileEncoding {
    pub const ALL: [NoteFileEncoding; 2] = [NoteFileEncoding::Utf8, NoteFileEncoding::Base64];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            NoteFileEncoding::Utf8 => "utf8",
            NoteFileEncoding::Base64 => "base64",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteCard {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    pub title: String,
    pub note_type: NoteType,
    pub version: i64,
    pub note: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteVersion {
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
pub struct NoteSaid {
    pub channel: String,
    pub number: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteCover {
    /// Absolute local filesystem path on the desktop host (for `file://` rendering).
    pub path: String,
    /// Authenticated HTTP URL path for remote clients (e.g. `/api/v1/note/<id>/cover?seq=<seq>`).
    pub url: String,
    /// Stored cover MIME type (`image/png`, `image/jpeg`, or `image/webp`).
    pub mime: String,
    /// Collaborative `seq` the cover was captured from.
    pub seq: i64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub updated_at: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteCoverSetRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    /// Collaborative `seq` rendered when capturing this cover.
    pub seq: i64,
    /// Image MIME type (`image/png`, `image/jpeg`, or `image/webp`).
    pub mime: String,
    /// Base64-encoded image bytes (max 2 MiB decoded).
    pub data: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NotePreviewOutlineItem {
    pub depth: u32,
    pub text: String,
    pub kind: String,
    pub checked: Option<bool>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NotePreviewSwatch {
    pub name: String,
    pub light: String,
    pub dark: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NotePreviewKpi {
    pub label: String,
    pub value: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NotePreviewMinimapShape {
    pub x: JsNumber,
    pub y: JsNumber,
    pub w: JsNumber,
    pub h: JsNumber,
    pub kind: String,
    pub label: Option<String>,
}

/// Lightweight structured content preview extracted from a note's `structure/` and `asset/` files.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "_tag")]
pub enum NotePreview {
    #[serde(rename = "doc", rename_all = "camelCase")]
    Doc {
        heading: Option<String>,
        excerpt: String,
        block_count: u32,
        slide_count: u32,
        outline: Vec<NotePreviewOutlineItem>,
    },
    #[serde(rename = "base", rename_all = "camelCase")]
    Base {
        sheet_name: Option<String>,
        columns: Vec<String>,
        rows: Vec<Vec<String>>,
        total_rows: u32,
        total_cols: u32,
    },
    #[serde(rename = "canvas", rename_all = "camelCase")]
    Canvas {
        shapes: Vec<NotePreviewMinimapShape>,
        node_count: u32,
        theme: Option<String>,
    },
    #[serde(rename = "media", rename_all = "camelCase")]
    Media {
        media_kind: String,
        caption: Option<String>,
        duration_sec: Option<JsNumber>,
        frame_asset: Option<String>,
        frame_path: Option<String>,
    },
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Note {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    pub title: String,
    pub note_type: NoteType,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::NoteId>"))]
    pub parent_id: Option<NoteId>,
    pub sort_order: i64,
    pub channel: Option<String>,
    pub said: Option<NoteSaid>,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::IssueId>"))]
    pub issue: Option<IssueId>,
    pub by: String,
    pub by_name: String,
    /// Latest immutable snapshot version number; 0 before any snapshot is cut.
    pub version: i64,
    /// Monotonic collaborative revision sequence bumped on each committed file or collab write.
    pub seq: i64,
    /// Immutable version snapshots, oldest first.
    pub versions: Vec<NoteVersion>,
    pub at: i64,
    pub updated: i64,
    /// Derived lightweight content preview extracted from `structure/` and `asset/`.
    pub preview: Option<Box<NotePreview>>,
    /// Derived auto-captured cover image stored outside the note directory and CRDT.
    pub cover: Option<Box<NoteCover>>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteFileMeta {
    /// Relative path inside `<storage>/note/<id>/` (e.g. `manifest.json`, `structure/doc.json`, `asset/hero.png`).
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
pub struct NoteFileListRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    /// Optional relative prefix filter (e.g. `structure/` or `asset/`).
    pub prefix: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteFileListResult {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub note_id: NoteId,
    pub seq: i64,
    pub files: Vec<NoteFileMeta>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteFileGetRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    pub path: String,
    /// Optional immutable version snapshot number to read from.
    pub version: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteFileContent {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub note_id: NoteId,
    pub path: String,
    pub mime: String,
    pub encoding: NoteFileEncoding,
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
pub struct NoteFileWriteItem {
    /// Relative path inside `<storage>/note/<id>/` (`manifest.json`, `structure/*`, or `asset/*`).
    pub path: String,
    /// UTF-8 text (default) or base64-encoded bytes when `encoding` is `base64`.
    pub content: String,
    pub encoding: Option<NoteFileEncoding>,
    pub mime: Option<String>,
    /// Optional optimistic concurrency guard matching the file's current SHA-256 hash (`""` requires absent).
    pub expected_hash: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteFileWriteRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    pub files: Vec<NoteFileWriteItem>,
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
pub struct NoteFileWriteResult {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub note_id: NoteId,
    pub seq: i64,
    pub files: Vec<NoteFileMeta>,
    pub frontiers: Option<String>,
    /// Populated when an agent write to a human-owned region was diverted into review suggestions.
    pub suggestions: Option<Vec<Suggestion>>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteFileDeleteRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
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
pub struct NoteFileDeleteResult {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub note_id: NoteId,
    pub seq: i64,
    pub path: String,
    pub frontiers: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteTypeInfo {
    pub r#type: NoteType,
    pub title: String,
    pub summary: String,
    /// Canonical primary entry path inside `<storage>/note/<id>/`.
    pub entry: String,
    pub references: Vec<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteTypeReadRequest {
    pub r#type: NoteType,
    pub reference: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteTypeGuide {
    pub r#type: NoteType,
    pub title: String,
    #[serialize_always]
    #[cfg_attr(feature = "ts-gen", ts(optional = false))]
    pub reference: Option<String>,
    pub content: String,
    pub references: Vec<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteViewContext {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub note_id: NoteId,
    pub note_type: NoteType,
    pub title: String,
    pub seq: Option<i64>,
    pub version: Option<i64>,
    /// Active relative file path inside `structure/` (e.g. `structure/doc.json`).
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

/// Creates a new directory-backed note seeded with starter files for `note_type`
/// (and optional initial `content` for the entry file or additional `files`).
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteRequest {
    pub title: String,
    pub note_type: NoteType,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::NoteId>"))]
    pub parent_id: Option<NoteId>,
    pub sort_order: Option<i64>,
    pub content: Option<String>,
    pub files: Option<Vec<NoteFileWriteItem>>,
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
pub struct NoteVersionRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    /// Optional updated primary entry content before snapshotting; omit to snapshot current directory state.
    pub content: Option<String>,
    pub note: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteUpdateRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    pub title: Option<String>,
    /// Parent note id; "" clears parent (moves to root).
    pub parent_id: Option<String>,
    pub sort_order: Option<i64>,
    /// Linked issue id or number; "" clears the linked issue.
    #[serde(default)]
    pub issue: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteListRequest {
    pub channel: Option<String>,
    pub issue: Option<String>,
    pub note_type: Option<NoteType>,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::NoteId>"))]
    pub parent_id: Option<NoteId>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteReadRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    pub version: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteContent {
    pub version: i64,
    pub content: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteGetInput {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteDeleteInput {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteFollowPayload {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    pub after: i64,
}

/// Reset is sent when the subscriber falls too far behind the collaborative change log.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "_tag")]
pub enum NoteEvent {
    #[serde(rename = "Files", rename_all = "camelCase")]
    Files {
        seq: i64,
        files: Vec<NoteFileMeta>,
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

/// Proposed edit to a file or structured target inside a note directory.
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
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub note_id: NoteId,
    /// Relative path inside `<storage>/note/<id>/` (e.g. `structure/doc.json`).
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
pub struct NoteSuggestionListInput {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteSuggestionCreateInput {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
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
pub struct NoteSuggestionAcceptInput {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::SuggestionId"))]
    pub suggestion: SuggestionId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteSuggestionFollowPayload {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum NotePresenceKind {
    #[serde(rename = "cursor")]
    Cursor,
    #[serde(rename = "selection")]
    Selection,
    #[serde(rename = "highlight")]
    Highlight,
    #[serde(rename = "viewport")]
    Viewport,
}

impl NotePresenceKind {
    pub const ALL: [NotePresenceKind; 4] = [
        NotePresenceKind::Cursor,
        NotePresenceKind::Selection,
        NotePresenceKind::Highlight,
        NotePresenceKind::Viewport,
    ];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            NotePresenceKind::Cursor => "cursor",
            NotePresenceKind::Selection => "selection",
            NotePresenceKind::Highlight => "highlight",
            NotePresenceKind::Viewport => "viewport",
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
pub struct NotePresence {
    /// Stable actor/peer identifier (e.g. "user" or "session:<id>").
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub avatar: Option<String>,
    pub kind: NotePresenceKind,
    pub x: Option<JsNumber>,
    pub y: Option<JsNumber>,
    pub w: Option<JsNumber>,
    pub h: Option<JsNumber>,
    pub status: Option<String>,
    /// Focused block, canvas node, or cell identifier inside `path`.
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
pub struct NotePresenceUpdateRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    pub presence: Option<NotePresence>,
    pub peer_id: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NotePresenceFollowRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "_tag")]
pub enum NotePresenceEvent {
    #[serde(rename = "Snapshot", rename_all = "camelCase")]
    Snapshot { peers: Vec<NotePresence> },
    #[serde(rename = "Upsert", rename_all = "camelCase")]
    Upsert { peer: NotePresence },
    #[serde(rename = "Remove", rename_all = "camelCase")]
    Remove { peer_id: String },
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteHistoryEntry {
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
pub struct NoteHistoryListRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    pub limit: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteHistoryPreviewRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    pub frontiers: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteHistoryPreviewResult {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub note_id: NoteId,
    pub note_type: NoteType,
    pub frontiers: String,
    pub entry: Option<NoteHistoryEntry>,
    pub files: Vec<NoteFileContent>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteHistoryRestoreRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    pub frontiers: String,
    pub note: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteHistoryForkRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    pub frontiers: String,
    pub title: Option<String>,
    pub channel: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteHistoryUndoOriginRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    pub origin: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteHistoryCompactRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteCollabExportRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    /// Base64-encoded Loro `VersionVector` (`LoroDoc::version`); omit for full snapshot.
    pub version_vector: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteCollabExportResult {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub note_id: NoteId,
    pub seq: i64,
    /// Server's current Loro `VersionVector` encoded as base64.
    pub version_vector: String,
    /// Server's current Loro `Frontiers` encoded as base64.
    pub frontiers: String,
    /// True when `update` contains a full Loro snapshot rather than an incremental delta.
    pub snapshot: bool,
    /// Base64-encoded Loro update or snapshot bytes compatible with `loro-crdt` WASM/JS.
    pub update: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteCollabImportRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    /// Base64-encoded Loro update or snapshot bytes compatible with `loro-crdt` WASM/JS.
    pub update: String,
    /// Optional client Loro `VersionVector` (base64); when provided, returns missing `server_update`.
    pub client_version_vector: Option<String>,
    pub origin: Option<String>,
    pub summary: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteCollabImportResult {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub note_id: NoteId,
    pub seq: i64,
    pub version_vector: String,
    pub frontiers: String,
    pub files: Vec<NoteFileMeta>,
    pub deleted: Vec<String>,
    /// Base64-encoded server updates missing from `client_version_vector`, when requested.
    pub server_update: Option<String>,
    pub server_snapshot: Option<bool>,
}

// ============================================================================
// Page Tree & Bidirectional Links (#131)
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum LinkEntityKind {
    #[serde(rename = "note")]
    Note,
    #[serde(rename = "issue")]
    Issue,
}

impl LinkEntityKind {
    pub const ALL: [LinkEntityKind; 2] = [LinkEntityKind::Note, LinkEntityKind::Issue];

    pub fn as_str(self) -> &'static str {
        match self {
            LinkEntityKind::Note => "note",
            LinkEntityKind::Issue => "issue",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum LinkRelation {
    #[serde(rename = "link")]
    Link,
    #[serde(rename = "embed")]
    Embed,
}

impl LinkRelation {
    pub const ALL: [LinkRelation; 2] = [LinkRelation::Link, LinkRelation::Embed];

    pub fn as_str(self) -> &'static str {
        match self {
            LinkRelation::Link => "link",
            LinkRelation::Embed => "embed",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteLinkRef {
    pub kind: LinkEntityKind,
    pub id: String,
    pub relation: LinkRelation,
    pub title: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteTreeMoveRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::NoteId>"))]
    pub parent_id: Option<NoteId>,
    pub sort_order: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteLink {
    pub id: String,
    pub source_kind: LinkEntityKind,
    pub source_id: String,
    pub target_kind: LinkEntityKind,
    pub target_id: String,
    pub relation: LinkRelation,
    pub title: Option<String>,
    pub note_type: Option<NoteType>,
    pub created_at: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteLinkListRequest {
    pub entity_kind: LinkEntityKind,
    pub entity_id: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteLinkListResult {
    pub outgoing: Vec<NoteLink>,
    pub backlinks: Vec<NoteLink>,
}

// ============================================================================
// Non-Destructive Image Annotation Layer (#144) & Review Checklist Linkage (#145)
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum MediaAnnotationKind {
    #[serde(rename = "pin")]
    Pin,
    #[serde(rename = "rect")]
    Rect,
    #[serde(rename = "arrow")]
    Arrow,
    #[serde(rename = "callout")]
    Callout,
}

impl MediaAnnotationKind {
    pub const ALL: [MediaAnnotationKind; 4] = [
        MediaAnnotationKind::Pin,
        MediaAnnotationKind::Rect,
        MediaAnnotationKind::Arrow,
        MediaAnnotationKind::Callout,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            MediaAnnotationKind::Pin => "pin",
            MediaAnnotationKind::Rect => "rect",
            MediaAnnotationKind::Arrow => "arrow",
            MediaAnnotationKind::Callout => "callout",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum MediaAnnotationSeverity {
    #[serde(rename = "p0")]
    P0,
    #[serde(rename = "p1")]
    P1,
    #[serde(rename = "p2")]
    P2,
    #[serde(rename = "ux")]
    Ux,
}

impl MediaAnnotationSeverity {
    pub const ALL: [MediaAnnotationSeverity; 4] = [
        MediaAnnotationSeverity::P0,
        MediaAnnotationSeverity::P1,
        MediaAnnotationSeverity::P2,
        MediaAnnotationSeverity::Ux,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            MediaAnnotationSeverity::P0 => "p0",
            MediaAnnotationSeverity::P1 => "p1",
            MediaAnnotationSeverity::P2 => "p2",
            MediaAnnotationSeverity::Ux => "ux",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "p0" => Some(MediaAnnotationSeverity::P0),
            "p1" => Some(MediaAnnotationSeverity::P1),
            "p2" => Some(MediaAnnotationSeverity::P2),
            "ux" => Some(MediaAnnotationSeverity::Ux),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum MediaAnnotationStatus {
    #[serde(rename = "open")]
    Open,
    #[serde(rename = "resolved")]
    Resolved,
}

impl MediaAnnotationStatus {
    pub const ALL: [MediaAnnotationStatus; 2] = [MediaAnnotationStatus::Open, MediaAnnotationStatus::Resolved];

    pub fn as_str(self) -> &'static str {
        match self {
            MediaAnnotationStatus::Open => "open",
            MediaAnnotationStatus::Resolved => "resolved",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "open" | "todo" | "doing" | "in_progress" => Some(MediaAnnotationStatus::Open),
            "resolved" | "done" | "closed" | "fixed" => Some(MediaAnnotationStatus::Resolved),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum MediaAnnotationSide {
    #[serde(rename = "before")]
    Before,
    #[serde(rename = "after")]
    After,
}

impl MediaAnnotationSide {
    pub const ALL: [MediaAnnotationSide; 2] = [MediaAnnotationSide::Before, MediaAnnotationSide::After];

    pub fn as_str(self) -> &'static str {
        match self {
            MediaAnnotationSide::Before => "before",
            MediaAnnotationSide::After => "after",
        }
    }
}

/// Normalized `0..=1` bounding rectangle over an image, immune to Retina 2x and viewport scaling.
#[skip_serializing_none]
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaAnnotationRect {
    pub x: JsNumber,
    pub y: JsNumber,
    pub w: JsNumber,
    pub h: JsNumber,
}

/// Normalized `0..=1` coordinate point (used for arrow endpoints or pin anchors).
#[skip_serializing_none]
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaAnnotationPoint {
    pub x: JsNumber,
    pub y: JsNumber,
}

/// Non-destructive interactive image annotation stored cleanly in JSON/CRDT without touching image pixels.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaAnnotation {
    pub id: String,
    pub number: u32,
    pub kind: Option<MediaAnnotationKind>,
    pub rect: MediaAnnotationRect,
    pub to: Option<MediaAnnotationPoint>,
    pub side: Option<MediaAnnotationSide>,
    pub severity: MediaAnnotationSeverity,
    pub title: String,
    pub body: Option<String>,
    pub status: MediaAnnotationStatus,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::IssueId>"))]
    pub issue_id: Option<IssueId>,
    pub base_row_id: Option<String>,
    pub author: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
}

/// Aggregate review rollup across all [`MediaAnnotation`]s in a block or note.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MediaAnnotationSummary {
    pub total: u32,
    pub open: u32,
    pub resolved: u32,
    pub p0: u32,
    pub p1: u32,
    pub p2: u32,
    pub ux: u32,
    pub linked_rows: u32,
    pub linked_issues: u32,
}

/// Back-reference from a `BaseRow` to a specific `MediaAnnotation` in a `doc` or `media` note.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BaseAnnotationRef {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub note_id: NoteId,
    pub block_id: String,
    pub annotation_id: String,
    pub number: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum ReviewSyncDirection {
    #[serde(rename = "docToBase")]
    DocToBase,
    #[serde(rename = "baseToDoc")]
    BaseToDoc,
}

impl ReviewSyncDirection {
    pub const ALL: [ReviewSyncDirection; 2] = [ReviewSyncDirection::DocToBase, ReviewSyncDirection::BaseToDoc];

    pub fn as_str(self) -> &'static str {
        match self {
            ReviewSyncDirection::DocToBase => "docToBase",
            ReviewSyncDirection::BaseToDoc => "baseToDoc",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteAnnotationUpsertRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    /// Target `DocBlock.id` for `doc` notes (`media` or `compare` block),
    /// or optional `media.json` item id for `media` notes.
    pub block_id: Option<String>,
    pub annotation: MediaAnnotation,
    /// Optional linked `base` note id to keep `BaseRow.annotationRef` and review status in sync.
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::NoteId>"))]
    pub base_note_id: Option<NoteId>,
    pub base_sheet_id: Option<String>,
    pub origin: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteAnnotationDeleteRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    pub block_id: Option<String>,
    pub annotation_id: String,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::NoteId>"))]
    pub base_note_id: Option<NoteId>,
    pub base_sheet_id: Option<String>,
    pub origin: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteAnnotationMutationResult {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub note_id: NoteId,
    pub block_id: Option<String>,
    pub annotations: Vec<MediaAnnotation>,
    pub summary: MediaAnnotationSummary,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::NoteId>"))]
    pub synced_base_note_id: Option<NoteId>,
    pub synced_base_row_id: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteReviewSyncRequest {
    /// The `doc` note whose `media`/`compare` annotations sync with an embedded `base` review checklist.
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    /// Optional target `base` note id; omit to reuse the first `baseEmbed` in `id` or create a built-in review checklist Base.
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::NoteId>"))]
    pub base_note_id: Option<NoteId>,
    pub sheet_id: Option<String>,
    pub spawn_issue_repo: Option<String>,
    pub direction: Option<ReviewSyncDirection>,
    pub origin: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteReviewSyncResult {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub doc_note_id: NoteId,
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub base_note_id: NoteId,
    pub sheet_id: String,
    pub created_base: bool,
    pub linked_count: u32,
    pub updated_annotations: u32,
    pub updated_rows: u32,
    pub summary: MediaAnnotationSummary,
    pub base_snapshot: BaseViewSnapshot,
}

// ============================================================================
// Block Doc Projection & Blocks (#31, #38, #39)
// ============================================================================

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DocKpiItem {
    pub label: String,
    pub value: String,
    pub delta: Option<String>,
    pub tone: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DocChartSeries {
    pub name: String,
    pub data: Vec<JsNumber>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DocColumn {
    pub blocks: Vec<DocBlock>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "type")]
pub enum BlockKind {
    #[serde(rename = "prose", rename_all = "camelCase")]
    Prose { text: String },
    #[serde(rename = "heading", rename_all = "camelCase")]
    Heading { level: u8, text: String },
    #[serde(rename = "list", rename_all = "camelCase")]
    List { ordered: bool, items: Vec<String> },
    #[serde(rename = "todo", rename_all = "camelCase")]
    Todo { checked: bool, text: String },
    #[serde(rename = "callout", rename_all = "camelCase")]
    Callout { tone: String, title: Option<String>, text: String },
    #[serde(rename = "code", rename_all = "camelCase")]
    Code { language: Option<String>, code: String },
    #[serde(rename = "kpi", rename_all = "camelCase")]
    Kpi { items: Vec<DocKpiItem> },
    #[serde(rename = "chart", rename_all = "camelCase")]
    Chart {
        title: Option<String>,
        kind: String,
        labels: Vec<String>,
        series: Vec<DocChartSeries>,
    },
    #[serde(rename = "diagram", rename_all = "camelCase")]
    Diagram { title: Option<String>, source: String },
    #[serde(rename = "compare", rename_all = "camelCase")]
    Compare {
        title: Option<String>,
        before_label: String,
        after_label: String,
        before_asset: String,
        after_asset: String,
        annotations: Option<Vec<MediaAnnotation>>,
    },
    #[serde(rename = "media", rename_all = "camelCase")]
    Media {
        media_kind: String,
        src: String,
        caption: Option<String>,
        annotations: Option<Vec<MediaAnnotation>>,
    },
    #[serde(rename = "preview", rename_all = "camelCase")]
    Preview {
        entry: String,
        height: Option<u32>,
        title: Option<String>,
    },
    #[serde(rename = "baseEmbed", rename_all = "camelCase")]
    BaseEmbed {
        #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
        note_id: NoteId,
        sheet_id: Option<String>,
        view_id: Option<String>,
    },
    #[serde(rename = "issueCard", rename_all = "camelCase")]
    IssueCard {
        #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::IssueId"))]
        issue_id: IssueId,
    },
    #[serde(rename = "issueList", rename_all = "camelCase")]
    IssueList {
        repo: Option<String>,
        status: Option<String>,
        tag: Option<String>,
        limit: Option<u32>,
    },
    #[serde(rename = "columns", rename_all = "camelCase")]
    Columns { columns: Vec<DocColumn> },
    #[serde(rename = "pageBreak", rename_all = "camelCase")]
    PageBreak { title: Option<String>, speaker_notes: Option<String> },
    #[serde(rename = "divider")]
    Divider,
    #[serde(rename = "quote", rename_all = "camelCase")]
    Quote { text: String, attribution: Option<String> },
    #[serde(rename = "toggle", rename_all = "camelCase")]
    Toggle { title: String, text: String },
    #[serde(rename = "table", rename_all = "camelCase")]
    Table {
        headers: Vec<String>,
        rows: Vec<Vec<String>>,
        alignments: Option<Vec<String>>,
        column_widths: Option<Vec<u32>>,
    },
    #[serde(rename = "bookmark", rename_all = "camelCase")]
    Bookmark {
        url: String,
        title: Option<String>,
        description: Option<String>,
    },
    #[serde(rename = "toc", rename_all = "camelCase")]
    Toc { max_level: Option<u8> },
    #[serde(rename = "math", rename_all = "camelCase")]
    Math { expression: String, display: Option<bool> },
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DocBlock {
    pub id: String,
    #[serde(flatten)]
    pub kind: BlockKind,
    pub collapsed: Option<bool>,
    pub children: Option<Vec<DocBlock>>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DocView {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub note_id: NoteId,
    pub title: String,
    pub blocks: Vec<DocBlock>,
    pub slide_count: u32,
    pub word_count: u32,
    pub extracted_links: Vec<NoteLinkRef>,
    pub annotation_summary: Option<MediaAnnotationSummary>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteDocViewRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NoteDocAppendBlockRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    pub block: DocBlock,
    pub after_block_id: Option<String>,
    pub origin: Option<String>,
}

// ============================================================================
// Multi-Dimensional Database Base (#32, #38, #40)
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum BaseColumnKind {
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "number")]
    Number,
    #[serde(rename = "select")]
    Select,
    #[serde(rename = "multiSelect")]
    MultiSelect,
    #[serde(rename = "date")]
    Date,
    #[serde(rename = "checkbox")]
    Checkbox,
    #[serde(rename = "media")]
    Media,
    #[serde(rename = "issueRef")]
    IssueRef,
    #[serde(rename = "agentRef")]
    AgentRef,
    #[serde(rename = "agentAction")]
    AgentAction,
    #[serde(rename = "noteRef")]
    NoteRef,
    #[serde(rename = "formula")]
    Formula,
}

impl BaseColumnKind {
    pub const ALL: [BaseColumnKind; 12] = [
        BaseColumnKind::Text,
        BaseColumnKind::Number,
        BaseColumnKind::Select,
        BaseColumnKind::MultiSelect,
        BaseColumnKind::Date,
        BaseColumnKind::Checkbox,
        BaseColumnKind::Media,
        BaseColumnKind::IssueRef,
        BaseColumnKind::AgentRef,
        BaseColumnKind::AgentAction,
        BaseColumnKind::NoteRef,
        BaseColumnKind::Formula,
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum BaseViewKind {
    #[serde(rename = "table")]
    Table,
    #[serde(rename = "board")]
    Board,
    #[serde(rename = "gallery")]
    Gallery,
    #[serde(rename = "timeline")]
    Timeline,
}

impl BaseViewKind {
    pub const ALL: [BaseViewKind; 4] = [BaseViewKind::Table, BaseViewKind::Board, BaseViewKind::Gallery, BaseViewKind::Timeline];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum BaseSummaryOp {
    #[serde(rename = "count")]
    Count,
    #[serde(rename = "sum")]
    Sum,
    #[serde(rename = "avg")]
    Avg,
    #[serde(rename = "min")]
    Min,
    #[serde(rename = "max")]
    Max,
}

impl BaseSummaryOp {
    pub const ALL: [BaseSummaryOp; 5] = [
        BaseSummaryOp::Count,
        BaseSummaryOp::Sum,
        BaseSummaryOp::Avg,
        BaseSummaryOp::Min,
        BaseSummaryOp::Max,
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum BaseFilterOp {
    #[serde(rename = "eq")]
    Eq,
    #[serde(rename = "neq")]
    Neq,
    #[serde(rename = "contains")]
    Contains,
    #[serde(rename = "notEmpty")]
    NotEmpty,
    #[serde(rename = "empty")]
    Empty,
}

impl BaseFilterOp {
    pub const ALL: [BaseFilterOp; 5] = [
        BaseFilterOp::Eq,
        BaseFilterOp::Neq,
        BaseFilterOp::Contains,
        BaseFilterOp::NotEmpty,
        BaseFilterOp::Empty,
    ];
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BaseSelectOption {
    pub value: String,
    pub label: Option<String>,
    pub color: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BaseAgentColumnConfig {
    pub agent_id: Option<String>,
    pub prompt_template: String,
    pub target_column_id: Option<String>,
    pub spawn_issue_repo: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BaseColumn {
    pub id: String,
    pub name: String,
    pub kind: BaseColumnKind,
    pub options: Option<Vec<BaseSelectOption>>,
    pub agent_config: Option<BaseAgentColumnConfig>,
    pub formula: Option<String>,
    pub width: Option<u32>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(tag = "_tag")]
pub enum BaseCellValue {
    #[serde(rename = "text", rename_all = "camelCase")]
    Text { value: String },
    #[serde(rename = "number", rename_all = "camelCase")]
    Number { value: JsNumber },
    #[serde(rename = "bool", rename_all = "camelCase")]
    Bool { value: bool },
    #[serde(rename = "strings", rename_all = "camelCase")]
    Strings { items: Vec<String> },
    #[serde(rename = "issueRef", rename_all = "camelCase")]
    IssueRef {
        #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::IssueId"))]
        issue_id: IssueId,
    },
    #[serde(rename = "noteRef", rename_all = "camelCase")]
    NoteRef {
        #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
        note_id: NoteId,
    },
    #[serde(rename = "agentRef", rename_all = "camelCase")]
    AgentRef { agent_id: String },
    #[serde(rename = "agentRun", rename_all = "camelCase")]
    AgentRun {
        status: String,
        summary: Option<String>,
        #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::SessionId>"))]
        session_id: Option<SessionId>,
        #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::IssueId>"))]
        spawned_issue_id: Option<IssueId>,
        updated_at: i64,
    },
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BaseRow {
    pub id: String,
    pub cells: BTreeMap<String, BaseCellValue>,
    #[cfg_attr(feature = "ts-gen", ts(as = "Option<crate::typescript::NoteId>"))]
    pub page_note_id: Option<NoteId>,
    pub annotation_ref: Option<BaseAnnotationRef>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BaseFilterRule {
    pub column_id: String,
    pub op: BaseFilterOp,
    pub value: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BaseSortRule {
    pub column_id: String,
    pub desc: bool,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BaseSummaryConfig {
    pub column_id: String,
    pub op: BaseSummaryOp,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BaseViewConfig {
    pub id: String,
    pub name: String,
    pub kind: BaseViewKind,
    pub group_by: Option<String>,
    pub hidden_columns: Option<Vec<String>>,
    pub filters: Option<Vec<BaseFilterRule>>,
    pub sorts: Option<Vec<BaseSortRule>>,
    pub summaries: Option<Vec<BaseSummaryConfig>>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BaseSheet {
    pub id: String,
    pub name: String,
    pub columns: Vec<BaseColumn>,
    pub rows: Vec<BaseRow>,
    pub views: Vec<BaseViewConfig>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BaseSheetMeta {
    pub id: String,
    pub name: String,
    pub row_count: u32,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BaseGroupSnapshot {
    pub key: String,
    pub label: String,
    pub row_ids: Vec<String>,
    pub count: u32,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BaseSummaryResult {
    pub column_id: String,
    pub op: BaseSummaryOp,
    pub value: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BaseViewRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    pub sheet_id: Option<String>,
    pub view_id: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BaseViewSnapshot {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub note_id: NoteId,
    pub sheets: Vec<BaseSheetMeta>,
    pub active_sheet_id: String,
    pub active_view_id: String,
    pub active_view_kind: BaseViewKind,
    pub columns: Vec<BaseColumn>,
    pub rows: Vec<BaseRow>,
    pub groups: Vec<BaseGroupSnapshot>,
    pub summaries: Vec<BaseSummaryResult>,
    pub total_rows: u32,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BaseUpsertRowRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    pub sheet_id: Option<String>,
    pub row_id: Option<String>,
    pub cells: BTreeMap<String, BaseCellValue>,
    pub origin: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BaseRunAgentColumnRequest {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub id: NoteId,
    pub sheet_id: Option<String>,
    pub column_id: String,
    pub row_ids: Option<Vec<String>>,
    pub origin: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BaseRunAgentColumnResult {
    #[cfg_attr(feature = "ts-gen", ts(as = "crate::typescript::NoteId"))]
    pub note_id: NoteId,
    pub sheet_id: String,
    pub column_id: String,
    pub executed: u32,
    pub updated_row_ids: Vec<String>,
    pub spawned_issue_ids: Vec<String>,
}

#[cfg(feature = "ts-gen")]
crate::typescript::module! {
    "note";
    types: [NoteType,
    NoteTypeSpec,
    NoteFileEncoding,
    NoteCard,
    NoteVersion,
    NoteSaid,
    NoteCover,
    NoteCoverSetRequest,
    NotePreviewOutlineItem,
    NotePreviewSwatch,
    NotePreviewKpi,
    NotePreviewMinimapShape,
    NotePreview,
    Note,
    NoteFileMeta,
    NoteFileListRequest,
    NoteFileListResult,
    NoteFileGetRequest,
    NoteFileContent,
    NoteFileWriteItem,
    NoteFileWriteRequest,
    NoteFileWriteResult,
    NoteFileDeleteRequest,
    NoteFileDeleteResult,
    NoteTypeInfo,
    NoteTypeReadRequest,
    NoteTypeGuide,
    NoteViewContext,
    NoteRequest,
    NoteVersionRequest,
    NoteUpdateRequest,
    NoteListRequest,
    NoteReadRequest,
    NoteContent,
    NoteGetInput,
    NoteDeleteInput,
    NoteFollowPayload,
    NoteEvent,
    SuggestionStatus,
    SuggestionChange,
    Suggestion,
    SuggestionCreate,
    SuggestionEventKind,
    SuggestionEvent,
    NoteSuggestionListInput,
    NoteSuggestionCreateInput,
    NoteSuggestionAcceptInput,
    NoteSuggestionFollowPayload,
    NotePresenceKind,
    ViewportRect,
    NotePresence,
    NotePresenceUpdateRequest,
    NotePresenceFollowRequest,
    NotePresenceEvent,
    NoteHistoryEntry,
    NoteHistoryListRequest,
    NoteHistoryPreviewRequest,
    NoteHistoryPreviewResult,
    NoteHistoryRestoreRequest,
    NoteHistoryForkRequest,
    NoteHistoryUndoOriginRequest,
    NoteHistoryCompactRequest,
    NoteCollabExportRequest,
    NoteCollabExportResult,
    NoteCollabImportRequest,
    NoteCollabImportResult,
    LinkEntityKind,
    LinkRelation,
    NoteLinkRef,
    NoteTreeMoveRequest,
    NoteLink,
    NoteLinkListRequest,
    NoteLinkListResult,
    MediaAnnotationKind,
    MediaAnnotationSeverity,
    MediaAnnotationStatus,
    MediaAnnotationSide,
    MediaAnnotationRect,
    MediaAnnotationPoint,
    MediaAnnotation,
    MediaAnnotationSummary,
    BaseAnnotationRef,
    ReviewSyncDirection,
    NoteAnnotationUpsertRequest,
    NoteAnnotationDeleteRequest,
    NoteAnnotationMutationResult,
    NoteReviewSyncRequest,
    NoteReviewSyncResult,
    DocKpiItem,
    DocChartSeries,
    DocColumn,
    BlockKind,
    DocBlock,
    DocView,
    NoteDocViewRequest,
    NoteDocAppendBlockRequest,
    BaseColumnKind,
    BaseViewKind,
    BaseSummaryOp,
    BaseFilterOp,
    BaseSelectOption,
    BaseAgentColumnConfig,
    BaseColumn,
    BaseCellValue,
    BaseRow,
    BaseFilterRule,
    BaseSortRule,
    BaseSummaryConfig,
    BaseViewConfig,
    BaseSheet,
    BaseSheetMeta,
    BaseGroupSnapshot,
    BaseSummaryResult,
    BaseViewRequest,
    BaseViewSnapshot,
    BaseUpsertRowRequest,
    BaseRunAgentColumnRequest,
    BaseRunAgentColumnResult];
    aliases: [];
}
