//! Loro 1.18.0 collaborative content-plane kernel (`crates/core/src/collab/`).
//!
//! Strictly scoped to VibeValley's **Content Plane** (artifacts: whiteboard,
//! outline/blocks, HTML/slides/dashboard/design/motion/design-system). Never
//! used for the control plane (`SpaceState`), event stream plane, or code plane.

pub mod doc;
pub mod presence;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum CollabError {
    #[error("loro error: {0}")]
    Loro(String),
    #[error("invalid binary encoding: {0}")]
    Encoding(String),
    #[error("json codec error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid cursor or range: {0}")]
    Cursor(String),
    #[error("node not found: {0}")]
    NotFound(String),
}

impl From<loro::LoroError> for CollabError {
    fn from(err: loro::LoroError) -> Self {
        Self::Loro(err.to_string())
    }
}

impl From<loro::LoroEncodeError> for CollabError {
    fn from(err: loro::LoroEncodeError) -> Self {
        Self::Encoding(err.to_string())
    }
}

pub use doc::{
    BlockNodeSnapshot, CollabDoc, CommitMeta, DocSnapshot, HTML_TEXT_KEY, HistoryEntry, ResolvedRange, StoreEntrySnapshot, SuggestionSpan, TextRangeAnchor,
    TreeNode, coalesce_suggestions, decode_frontiers, decode_version_vector, encode_frontiers, encode_version_vector,
};
pub use presence::{DEFAULT_PRESENCE_TTL_MS, PresenceHub, PresenceKind, PresencePayload, PresenceViewport};
