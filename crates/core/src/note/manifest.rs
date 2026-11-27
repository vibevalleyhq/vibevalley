//! Directory manifest (`manifest.json`) and canonical 4-type note specifications.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use vibevalley_protocol::{NoteFileMeta, NoteType};
pub use vibevalley_protocol::{NoteTypeSpec, all_type_specs, type_spec};

use crate::note::path::{NotePathZone, validate_note_path};

/// Current manifest schema version for directory-backed notes.
pub const MANIFEST_SCHEMA_VERSION: u32 = 1;

/// Maximum UTF-16 code-unit length for a note title.
pub const TITLE_MAX_LEN: usize = 200;

/// Reserved manifest field documenting canonical relative zones.
pub const MANIFEST_KIND: &str = "vibevalley.note";

/// On-disk `<storage>/note/<id>/manifest.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteManifest {
    pub schema_version: u32,
    pub id: String,
    pub note_type: NoteType,
    pub title: String,
    /// Relative primary structure entry path (e.g. `structure/doc.json`).
    pub entry: String,
    /// Ordered list of key structure/asset relative paths highlighted for agents & viewers.
    #[serde(default)]
    pub files: Vec<String>,
    /// Type-specific lightweight metadata (e.g. `viewport`, `diagramKind`).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub meta: BTreeMap<String, Value>,
}

/// Constructs a default manifest for a newly created note directory.
pub fn default_manifest(id: impl Into<String>, note_type: NoteType, title: impl Into<String>) -> NoteManifest {
    let spec = type_spec(note_type);
    NoteManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        id: id.into(),
        note_type,
        title: title.into(),
        entry: spec.entry_path.to_owned(),
        files: vec![spec.entry_path.to_owned()],
        meta: BTreeMap::new(),
    }
}

/// Validates a note title; returns `None` when valid.
pub fn title_problem(title: &str) -> Option<String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Some("note title cannot be empty".to_owned());
    }
    if trimmed.encode_utf16().count() > TITLE_MAX_LEN {
        return Some(format!("note title exceeds {TITLE_MAX_LEN} characters"));
    }
    None
}

/// Validates structural invariants of a decoded `manifest.json`.
pub fn validate_manifest(manifest: &NoteManifest) -> Result<(), String> {
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
        return Err(format!("unsupported manifest schemaVersion {}", manifest.schema_version));
    }
    if manifest.id.trim().is_empty() {
        return Err("manifest.id cannot be empty".to_owned());
    }
    if let Some(problem) = title_problem(&manifest.title) {
        return Err(problem);
    }
    let entry_zone = validate_note_path(&manifest.entry)?;
    if entry_zone != NotePathZone::Structure {
        return Err("manifest.entry must reside under structure/".to_owned());
    }
    for file in &manifest.files {
        let zone = validate_note_path(file)?;
        if zone == NotePathZone::Manifest {
            return Err("manifest.files cannot list manifest.json".to_owned());
        }
    }
    Ok(())
}

/// Parses and validates `manifest.json` UTF-8 text.
pub fn parse_manifest(raw: &str) -> Result<NoteManifest, String> {
    let manifest: NoteManifest = serde_json::from_str(raw).map_err(|e| format!("invalid manifest.json: {e}"))?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

/// Serializes and validates a `NoteManifest` as pretty JSON.
pub fn serialize_manifest(manifest: &NoteManifest) -> Result<String, String> {
    validate_manifest(manifest)?;
    let mut out = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    out.push('\n');
    Ok(out)
}

/// Formats a concise Markdown directory summary for agent/CLI inspection.
pub fn format_directory_summary(title: &str, note_type: NoteType, seq: i64, files: &[NoteFileMeta]) -> String {
    let header = format!("# {title}\n\ntype: {} · seq: {seq} · files: {}", note_type.as_str(), files.len());
    if files.is_empty() {
        return format!("{header}\n\n(empty directory)");
    }
    let list: Vec<String> = files.iter().map(|f| format!("- `{}` ({}, {} B)", f.path, f.mime, f.size)).collect();
    format!("{header}\n\n## Files\n\n{}", list.join("\n"))
}
