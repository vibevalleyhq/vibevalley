//! Endpoints only the native app serves (not in packages/protocol). They sit
//! beside the generated table: [`crate::endpoint`] finds them too.

use serde::{Deserialize, Serialize};

use crate::wire::{Caller, Endpoint, Op};

pub const NATIVE_ENDPOINTS: &[Endpoint] = &[
    Endpoint {
        op: "media.input.file",
        module: "media",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaInputFileInput"),
        result: Some("AttachmentFile"),
    },
    Endpoint {
        op: "media.input.uploadFile",
        module: "media",
        about: &[],
        can: &[Caller::User],
        dry_run: None,
        input: Some("MediaInputUploadFileInput"),
        result: Some("MediaInput"),
    },
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
    Endpoint {
        op: "artifact.view",
        module: "artifact",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ArtifactViewInput"),
        result: Some("ArtifactPage"),
    },
    Endpoint {
        op: "artifact.entry.writeProps",
        module: "artifact",
        about: &["id"],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ArtifactEntryWritePropsInput"),
        result: Some("ArtifactEntryBatchResult"),
    },
    Endpoint {
        op: "artifact.tokens.inspect",
        module: "artifact",
        about: &[],
        can: &[Caller::User, Caller::Remote],
        dry_run: None,
        input: Some("ArtifactTokensInspectInput"),
        result: Some("InspectedTokensSpec"),
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

/// A store artifact's rendered view as `GET /api/v1/artifact/<id>/view`
/// serves it: query `theme`, `path`, `elementId`, `print`, and `origin`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactViewInput {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub element_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub print: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

/// The page and the headers to serve it with (its sandbox policy, cached
/// for good). A version that is not there is `ArtifactNotFound` (404).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPage {
    pub content: String,
    pub headers: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DesignPropValue {
    Bool(bool),
    Number(f64),
    String(String),
}

/// Updates declared `data-props` default values inside a `.dc.html` store entry.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEntryWritePropsInput {
    pub id: String,
    pub path: String,
    pub values: std::collections::BTreeMap<String, DesignPropValue>,
}

/// Parses a design-system `tokens.json` string into swatches, typography, spacing, contrast ratios, and compiled CSS.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactTokensInspectInput {
    pub raw: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedColorSwatch {
    pub id: String,
    pub group: String,
    pub light: String,
    pub dark: String,
    pub note: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contrast_light: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contrast_dark: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedTypeFamily {
    pub id: String,
    pub value: String,
    pub note: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedTokenValue {
    pub id: String,
    pub value: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedTypeStyle {
    pub id: String,
    pub family: String,
    pub size: String,
    pub weight: String,
    pub line_height: String,
    pub letter_spacing: String,
    pub sample: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedTokensSpec {
    pub themes: Vec<String>,
    pub default_theme: String,
    pub colors: Vec<InspectedColorSwatch>,
    pub families: Vec<InspectedTypeFamily>,
    pub scale: Vec<InspectedTokenValue>,
    pub styles: Vec<InspectedTypeStyle>,
    pub space: Vec<InspectedTokenValue>,
    pub radius: Vec<InspectedTokenValue>,
    pub css: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MediaInputFileInput {
    pub id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MediaInputUploadFileInput {
    pub id: String,
    pub path: String,
}

pub mod native_ops {
    use super::*;

    pub struct MediaInputFile;
    impl Op for MediaInputFile {
        const NAME: &'static str = "media.input.file";
        type Input = MediaInputFileInput;
        type Result = super::AttachmentFile;
    }

    pub struct MediaInputUploadFile;
    impl Op for MediaInputUploadFile {
        const NAME: &'static str = "media.input.uploadFile";
        type Input = MediaInputUploadFileInput;
        type Result = crate::MediaInput;
    }

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

    /// A store artifact's rendered HTML viewer document and headers.
    pub struct ArtifactView;
    impl Op for ArtifactView {
        const NAME: &'static str = "artifact.view";
        type Input = ArtifactViewInput;
        type Result = super::ArtifactPage;
    }

    /// Rewrites `data-props` defaults in a `.dc.html` store entry and commits the update.
    pub struct ArtifactEntryWriteProps;
    impl Op for ArtifactEntryWriteProps {
        const NAME: &'static str = "artifact.entry.writeProps";
        type Input = ArtifactEntryWritePropsInput;
        type Result = crate::ArtifactEntryBatchResult;
    }

    /// Parses design-system tokens, computes WCAG contrast against surface colors, and compiles CSS.
    pub struct ArtifactTokensInspect;
    impl Op for ArtifactTokensInspect {
        const NAME: &'static str = "artifact.tokens.inspect";
        type Input = ArtifactTokensInspectInput;
        type Result = InspectedTokensSpec;
    }
}
