//! Directory manifest (`manifest.json`) and canonical 12-type artifact specifications.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use vibevalley_protocol::{ArtifactFileMeta, ArtifactType};
pub use vibevalley_protocol::{ArtifactTypeSpec, all_type_specs, type_spec};

use crate::artifact::path::{ArtifactPathZone, validate_artifact_path};

/// Current manifest schema version for directory-backed artifacts.
pub const MANIFEST_SCHEMA_VERSION: u32 = 1;

/// Maximum UTF-16 code-unit length for an artifact title.
pub const TITLE_MAX_LEN: usize = 200;

fn default_schema_version() -> u32 {
    MANIFEST_SCHEMA_VERSION
}

/// On-disk `<storage>/artifact/<id>/manifest.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactManifest {
    pub id: String,
    pub artifact_type: ArtifactType,
    pub title: String,
    /// Primary entry file relative path inside `structure/`.
    pub entry: String,
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub design_system_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub meta: BTreeMap<String, Value>,
}

/// Constructs a default manifest for a newly created artifact directory.
pub fn default_manifest(id: impl Into<String>, artifact_type: ArtifactType, title: impl Into<String>) -> ArtifactManifest {
    let spec = type_spec(artifact_type);
    ArtifactManifest {
        id: id.into(),
        artifact_type,
        title: title.into(),
        entry: spec.entry_path.to_owned(),
        schema_version: MANIFEST_SCHEMA_VERSION,
        design_system_id: None,
        files: vec![spec.entry_path.to_owned()],
        meta: BTreeMap::new(),
    }
}

/// Validates an artifact title; returns `None` when valid.
pub fn title_problem(title: &str) -> Option<String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Some("title must not be empty".to_owned());
    }
    if trimmed.encode_utf16().count() > TITLE_MAX_LEN {
        return Some(format!("title exceeds {TITLE_MAX_LEN} characters"));
    }
    None
}

/// Validates a parsed manifest's required invariants.
pub fn validate_manifest(manifest: &ArtifactManifest) -> Result<(), String> {
    if manifest.id.trim().is_empty() {
        return Err("manifest.id must not be empty".to_owned());
    }
    if let Some(problem) = title_problem(&manifest.title) {
        return Err(format!("manifest.title: {problem}"));
    }
    if manifest.schema_version == 0 {
        return Err("manifest.schemaVersion must be >= 1".to_owned());
    }
    let entry_zone = validate_artifact_path(&manifest.entry)?;
    if entry_zone != ArtifactPathZone::Structure {
        return Err("manifest.entry must live under structure/".to_owned());
    }
    for file in &manifest.files {
        let zone = validate_artifact_path(file)?;
        if zone == ArtifactPathZone::Manifest {
            return Err("manifest.files must not include manifest.json".to_owned());
        }
    }
    Ok(())
}

/// Parses and validates `manifest.json` text.
pub fn parse_manifest(raw: &str) -> Result<ArtifactManifest, String> {
    let manifest: ArtifactManifest = serde_json::from_str(raw).map_err(|e| format!("invalid manifest.json: {e}"))?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

/// Serializes a validated manifest as pretty-printed JSON with a trailing newline.
pub fn serialize_manifest(manifest: &ArtifactManifest) -> Result<String, String> {
    validate_manifest(manifest)?;
    let mut out = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    out.push('\n');
    Ok(out)
}

/// Formats a concise Markdown directory summary for agent/CLI inspection.
pub fn format_directory_summary(title: &str, artifact_type: ArtifactType, seq: i64, files: &[ArtifactFileMeta]) -> String {
    let header = format!("# {title}\n\ntype: {} · seq: {seq} · files: {}", artifact_type.as_str(), files.len());
    if files.is_empty() {
        return format!("{header}\n\n(empty directory)");
    }
    let list: Vec<String> = files.iter().map(|f| format!("- `{}` ({}, {} B)", f.path, f.mime, f.size)).collect();
    format!("{header}\n\n## Files\n\n{}", list.join("\n"))
}
