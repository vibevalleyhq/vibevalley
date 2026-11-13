//! Endpoints only the native app serves (not in packages/protocol). They sit
//! beside the generated table: [`crate::endpoint`] finds them too.

use serde::{Deserialize, Serialize};

use crate::wire::{Caller, Endpoint, Op};

pub const NATIVE_ENDPOINTS: &[Endpoint] = &[
    Endpoint {
        op: "attachment.file",
        module: "attachment",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("AttachmentFileInput"),
        result: Some("AttachmentFile"),
    },
    Endpoint {
        op: "artifact.page",
        module: "artifact",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ArtifactPageInput"),
        result: Some("ArtifactPage"),
    },
];

/// The attachment's id (the sha256 of its bytes).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentFileInput {
    pub id: String,
}

/// Where a kept attachment's bytes are on this machine, and its media type:
/// the views show it from the path; the HTTP adapter serves it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentFile {
    /// Absolute.
    pub path: String,
    pub r#type: String,
    pub name: String,
}

/// An html artifact's version as `GET /api/v1/artifact/<id>/<version>`
/// serves it (VibeValley `artifactContent`): the query's `shell`, `theme`
/// and `print`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPageInput {
    pub id: String,
    pub version: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub print: Option<bool>,
}

/// The page and the headers to serve it with (its sandbox policy, cached
/// for good). A version that is not there is `ArtifactNotFound` (404).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPage {
    pub content: String,
    pub headers: std::collections::BTreeMap<String, String>,
}

pub mod native_ops {
    use super::*;

    /// A kept attachment's file: its absolute path and media type.
    pub struct AttachmentFile;
    impl Op for AttachmentFile {
        const NAME: &'static str = "attachment.file";
        type Input = AttachmentFileInput;
        type Result = super::AttachmentFile;
    }

    /// An html artifact's version, plain or in the workbench's shell.
    pub struct ArtifactPage;
    impl Op for ArtifactPage {
        const NAME: &'static str = "artifact.page";
        type Input = ArtifactPageInput;
        type Result = super::ArtifactPage;
    }
}
