#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]

#[allow(unused_imports)]
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
use ts_rs::TS;

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::wire::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub enum ArtifactBody {
    #[serde(rename = "blocks")]
    Blocks,
    #[serde(rename = "html")]
    Html,
}

impl ArtifactBody {
    pub const ALL: [ArtifactBody; 2] = [ArtifactBody::Blocks, ArtifactBody::Html];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            ArtifactBody::Blocks => "blocks",
            ArtifactBody::Html => "html",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactCard {
    #[ts(as = "crate::typescript::ArtifactId")]
    pub id: ArtifactId,
    pub title: String,
    pub body: ArtifactBody,
    /// Announced version for html; 0 for blocks.
    pub version: i64,
    pub note: String,
    /// Omit defaults to "page" for cards created before display modes existed.
    pub display: Option<ArtifactDisplay>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct QuotedBlock {
    #[ts(as = "crate::typescript::ArtifactId")]
    pub artifact_id: ArtifactId,
    #[ts(as = "crate::typescript::BlockId")]
    pub block_id: BlockId,
    pub rev: i64,
    pub title: String,
    pub r#type: Option<String>,
    pub text: Option<String>,
    pub now_rev: Option<i64>,
    pub deleted: Option<bool>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct BlockRef {
    #[ts(as = "crate::typescript::ArtifactId")]
    pub artifact_id: ArtifactId,
    #[ts(as = "crate::typescript::BlockId")]
    pub block_id: BlockId,
    pub rev: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub enum ArtifactKind {
    #[serde(rename = "html")]
    Html,
    #[serde(rename = "markdown")]
    Markdown,
}

impl ArtifactKind {
    pub const ALL: [ArtifactKind; 2] = [ArtifactKind::Html, ArtifactKind::Markdown];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            ArtifactKind::Html => "html",
            ArtifactKind::Markdown => "markdown",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
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
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSaid {
    pub channel: String,
    pub number: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    #[ts(as = "crate::typescript::ArtifactId")]
    pub id: ArtifactId,
    pub title: String,
    pub body: ArtifactBody,
    /// html only; absent on blocks.
    pub display: Option<ArtifactDisplay>,
    pub channel: Option<String>,
    pub said: Option<ArtifactSaid>,
    #[ts(as = "Option<crate::typescript::IssueId>")]
    pub issue: Option<IssueId>,
    pub by: String,
    pub by_name: String,
    /// Latest version for html; 0 for blocks.
    pub version: i64,
    /// Committed batch count for blocks; 0 for html.
    pub seq: i64,
    /// Oldest first for html; empty on blocks.
    pub versions: Vec<ArtifactVersion>,
    pub at: i64,
    pub updated: i64,
}

/// Omit content to create an unannounced empty blocks artifact.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRequest {
    pub title: String,
    pub kind: ArtifactKind,
    /// html only; defaults to "page".
    pub display: Option<ArtifactDisplay>,
    pub content: Option<String>,
    pub note: Option<String>,
    pub channel: Option<String>,
    pub issue: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactVersionRequest {
    #[ts(as = "crate::typescript::ArtifactId")]
    pub id: ArtifactId,
    pub content: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct HtmlAnchor {
    pub kind: HtmlAnchorKind,
    pub exact: String,
    pub prefix: String,
    pub suffix: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactHtmlEdit {
    #[ts(as = "crate::typescript::ArtifactId")]
    pub id: ArtifactId,
    pub version: i64,
    pub anchor: HtmlAnchor,
    pub text: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactUpdateRequest {
    #[ts(as = "crate::typescript::ArtifactId")]
    pub id: ArtifactId,
    pub title: Option<String>,
    pub display: Option<ArtifactDisplay>,
}

pub type ShellCount = i64;

pub type ShellTime = JsNumber;

pub type ShellWords = Vec<String>;

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(tag = "vibevalley")]
pub enum HtmlShellMessage {
    #[serde(rename = "selection", rename_all = "camelCase")]
    Selection { anchor: HtmlAnchor },
    #[serde(rename = "ready", rename_all = "camelCase")]
    Ready {
        display: ArtifactDisplay,
        pages: Option<ShellCount>,
        titles: Option<ShellWords>,
        notes: Option<ShellWords>,
        duration: Option<ShellTime>,
    },
    #[serde(rename = "at", rename_all = "camelCase")]
    At { page: Option<ShellCount>, time: Option<ShellTime> },
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactListRequest {
    pub channel: Option<String>,
    pub issue: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactReadRequest {
    #[ts(as = "crate::typescript::ArtifactId")]
    pub id: ArtifactId,
    pub version: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactContent {
    pub version: i64,
    pub content: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct SpanMarks {
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub code: Option<bool>,
    pub strike: Option<bool>,
    pub link: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct TextSpan {
    pub t: String,
    pub marks: SpanMarks,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct BlockAttrs {
    pub level: Option<i64>,
    pub checked: Option<bool>,
    pub language: Option<String>,
    pub src: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub alt: Option<String>,
    #[ts(as = "Option<crate::typescript::IssueId>")]
    pub issue_id: Option<IssueId>,
    pub memory_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct BlockInput {
    #[ts(as = "crate::typescript::BlockId")]
    pub id: BlockId,
    #[ts(as = "Option<crate::typescript::BlockId>")]
    pub parent_id: Option<BlockId>,
    pub order_key: String,
    pub r#type: BlockType,
    pub attrs: BlockAttrs,
    pub text: Vec<TextSpan>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    #[ts(as = "crate::typescript::BlockId")]
    pub id: BlockId,
    #[ts(as = "Option<crate::typescript::BlockId>")]
    pub parent_id: Option<BlockId>,
    pub order_key: String,
    pub r#type: BlockType,
    pub attrs: BlockAttrs,
    pub text: Vec<TextSpan>,
    #[ts(as = "crate::typescript::ArtifactId")]
    pub artifact_id: ArtifactId,
    pub rev: i64,
    pub deleted: Option<bool>,
    pub updated_by: String,
    pub updated: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct BlockSnapshot {
    pub artifact: Artifact,
    pub blocks: Vec<Block>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactMarkdown {
    pub markdown: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct BlockOpInsertBlock {
    pub block: BlockInput,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct BlockOpUpdateText {
    #[ts(as = "crate::typescript::BlockId")]
    pub block_id: BlockId,
    pub base_rev: i64,
    pub text: Vec<TextSpan>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct BlockOpSetAttrs {
    #[ts(as = "crate::typescript::BlockId")]
    pub block_id: BlockId,
    pub attrs: BlockAttrs,
    pub unset: Option<Vec<String>>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct BlockOpSetType {
    #[ts(as = "crate::typescript::BlockId")]
    pub block_id: BlockId,
    pub r#type: BlockType,
    pub attrs: BlockAttrs,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct BlockOpMoveBlock {
    #[ts(as = "crate::typescript::BlockId")]
    pub block_id: BlockId,
    #[ts(as = "Option<crate::typescript::BlockId>")]
    pub parent_id: Option<BlockId>,
    pub order_key: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct BlockOpDeleteBlock {
    #[ts(as = "crate::typescript::BlockId")]
    pub block_id: BlockId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct BlockOpRestoreBlock {
    #[ts(as = "crate::typescript::BlockId")]
    pub block_id: BlockId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct BlockOpSplitBlock {
    #[ts(as = "crate::typescript::BlockId")]
    pub block_id: BlockId,
    pub base_rev: i64,
    pub offset: i64,
    pub new_block: BlockInput,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct BlockOpMergeBlocks {
    #[ts(as = "crate::typescript::BlockId")]
    pub target_id: BlockId,
    #[ts(as = "crate::typescript::BlockId")]
    pub source_id: BlockId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
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
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct BlockSubmit {
    pub batch_id: String,
    pub last_seq: i64,
    pub ops: Vec<BlockOp>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
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
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct BlockCreate {
    pub r#type: Option<String>,
    /// 1 to 3; defaults to 2.
    pub level: Option<i64>,
    pub checked: Option<bool>,
    pub language: Option<String>,
    pub text: String,
    /// "" inserts first; omit appends at the end.
    #[ts(as = "Option<crate::typescript::BlockId>")]
    pub after_block: Option<BlockId>,
    /// Omit inserts at the top level.
    #[ts(as = "Option<crate::typescript::BlockId>")]
    pub parent_id: Option<BlockId>,
}

/// Conflicts when text is changed against a stale baseRev.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct BlockUpdate {
    #[ts(as = "crate::typescript::BlockId")]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct BlockDelete {
    #[ts(as = "crate::typescript::BlockId")]
    pub block: BlockId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct BlockOpResult {
    pub status: BlockOpStatus,
    #[ts(as = "crate::typescript::BlockId")]
    pub block_id: BlockId,
    pub rev: Option<i64>,
    pub text: Option<Vec<TextSpan>>,
    pub yours: Option<Vec<TextSpan>>,
    pub reason: Option<String>,
    /// Populated when an agent edit to a user-authored block was diverted into a suggestion.
    #[ts(as = "Option<crate::typescript::SuggestionId>")]
    pub suggestion: Option<SuggestionId>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct BlockAck {
    pub batch_id: String,
    pub seq: i64,
    pub results: Vec<BlockOpResult>,
    pub blocks: Vec<Block>,
}

/// Reset is sent when the client falls too far behind the batch log.
#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(tag = "_tag")]
pub enum ArtifactEvent {
    #[serde(rename = "Blocks", rename_all = "camelCase")]
    Blocks { seq: i64, blocks: Vec<Block> },
    #[serde(rename = "Reset")]
    Reset {},
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
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
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionChange {
    pub text: Option<Vec<TextSpan>>,
    pub r#type: Option<BlockType>,
    pub attrs: Option<BlockAttrs>,
    pub unset: Option<Vec<String>>,
    pub delete: Option<bool>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    #[ts(as = "crate::typescript::SuggestionId")]
    pub id: SuggestionId,
    #[ts(as = "crate::typescript::ArtifactId")]
    pub artifact_id: ArtifactId,
    #[ts(as = "crate::typescript::BlockId")]
    pub block_id: BlockId,
    pub author: String,
    pub base_rev: i64,
    pub change: SuggestionChange,
    pub status: SuggestionStatus,
    pub created_at: i64,
    pub resolved_at: Option<i64>,
    pub resolved_by: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionCreate {
    #[ts(as = "crate::typescript::BlockId")]
    pub block: BlockId,
    pub base_rev: i64,
    pub change: SuggestionChange,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionEvent {
    #[serde(rename = "_tag")]
    pub tag: SuggestionEventKind,
    pub suggestions: Vec<Suggestion>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactGetInput {
    #[ts(as = "crate::typescript::ArtifactId")]
    pub id: ArtifactId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDeleteInput {
    #[ts(as = "crate::typescript::ArtifactId")]
    pub id: ArtifactId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactBlockListInput {
    #[ts(as = "crate::typescript::ArtifactId")]
    pub id: ArtifactId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSubmitInput {
    #[ts(as = "crate::typescript::ArtifactId")]
    pub id: ArtifactId,
    pub batch_id: String,
    pub last_seq: i64,
    pub ops: Vec<BlockOp>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactBlockCreateInput {
    #[ts(as = "crate::typescript::ArtifactId")]
    pub id: ArtifactId,
    pub r#type: Option<String>,
    pub level: Option<i64>,
    pub checked: Option<bool>,
    pub language: Option<String>,
    pub text: String,
    #[ts(as = "Option<crate::typescript::BlockId>")]
    pub after_block: Option<BlockId>,
    #[ts(as = "Option<crate::typescript::BlockId>")]
    pub parent_id: Option<BlockId>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactBlockUpdateInput {
    #[ts(as = "crate::typescript::ArtifactId")]
    pub id: ArtifactId,
    #[ts(as = "crate::typescript::BlockId")]
    pub block: BlockId,
    pub base_rev: i64,
    pub text: Option<String>,
    pub r#type: Option<String>,
    pub level: Option<i64>,
    pub checked: Option<bool>,
    pub language: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactBlockDeleteInput {
    #[ts(as = "crate::typescript::ArtifactId")]
    pub id: ArtifactId,
    #[ts(as = "crate::typescript::BlockId")]
    pub block: BlockId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSuggestionListInput {
    #[ts(as = "crate::typescript::ArtifactId")]
    pub id: ArtifactId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSuggestionCreateInput {
    #[ts(as = "crate::typescript::ArtifactId")]
    pub id: ArtifactId,
    #[ts(as = "crate::typescript::BlockId")]
    pub block: BlockId,
    pub base_rev: i64,
    pub change: SuggestionChange,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSuggestionAcceptInput {
    #[ts(as = "crate::typescript::ArtifactId")]
    pub id: ArtifactId,
    #[ts(as = "crate::typescript::SuggestionId")]
    pub suggestion: SuggestionId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactMarkdownGetInput {
    #[ts(as = "crate::typescript::ArtifactId")]
    pub id: ArtifactId,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(optional_fields)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDemoInput {
    #[ts(as = "crate::typescript::ArtifactId")]
    pub id: ArtifactId,
}

crate::typescript::module! {
    "artifact";
    types: [ArtifactBody,
    ArtifactDisplay,
    ArtifactCard,
    QuotedBlock,
    BlockRef,
    ArtifactKind,
    ArtifactVersion,
    ArtifactSaid,
    Artifact,
    ArtifactRequest,
    ArtifactVersionRequest,
    HtmlAnchorKind,
    HtmlAnchor,
    ArtifactHtmlEdit,
    ArtifactUpdateRequest,
    HtmlShellMessage,
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
    ArtifactDemoInput];
    aliases: [ShellCount,
    ShellTime,
    ShellWords];
}
