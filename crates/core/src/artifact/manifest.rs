//! Directory manifest (`manifest.json`) and canonical 12-type artifact specifications.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use vibevalley_protocol::{ArtifactFileMeta, ArtifactType};

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

/// Static directory layout specification for one of the 12 `ArtifactType`s.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArtifactTypeSpec {
    pub artifact_type: ArtifactType,
    /// Kebab-case slug matching `crates/server/assets/artifact/types/<slug>/`.
    pub slug: &'static str,
    /// Primary entry file path inside `<storage>/artifact/<id>/`.
    pub entry_path: &'static str,
    /// MIME type of the primary entry file.
    pub entry_mime: &'static str,
    /// Relative directories created inside `<storage>/artifact/<id>/`.
    pub default_dirs: &'static [&'static str],
    /// Default suffix when exporting a single file for the user.
    pub export_suffix: &'static str,
    /// True when this type can link to a workspace default `design-system`.
    pub supports_design_system: bool,
}

const ALL_SPECS: [ArtifactTypeSpec; 12] = [
    ArtifactTypeSpec {
        artifact_type: ArtifactType::Docs,
        slug: "docs",
        entry_path: "structure/index.md",
        entry_mime: "text/markdown",
        default_dirs: &["structure", "asset"],
        export_suffix: ".md",
        supports_design_system: false,
    },
    ArtifactTypeSpec {
        artifact_type: ArtifactType::Outline,
        slug: "outline",
        entry_path: "structure/outline.json",
        entry_mime: "application/json",
        default_dirs: &["structure", "asset"],
        export_suffix: ".outline.json",
        supports_design_system: false,
    },
    ArtifactTypeSpec {
        artifact_type: ArtifactType::Slides,
        slug: "slides",
        entry_path: "structure/deck.json",
        entry_mime: "application/json",
        default_dirs: &["structure", "structure/slides", "asset"],
        export_suffix: ".slides.json",
        supports_design_system: true,
    },
    ArtifactTypeSpec {
        artifact_type: ArtifactType::Dashboard,
        slug: "dashboard",
        entry_path: "structure/dashboard.json",
        entry_mime: "application/json",
        default_dirs: &["structure", "structure/data", "asset"],
        export_suffix: ".dashboard.json",
        supports_design_system: true,
    },
    ArtifactTypeSpec {
        artifact_type: ArtifactType::Motion,
        slug: "motion",
        entry_path: "structure/timeline.json",
        entry_mime: "application/json",
        default_dirs: &["structure", "structure/scenes", "asset", "asset/audio", "asset/video", "asset/image"],
        export_suffix: ".motion.json",
        supports_design_system: true,
    },
    ArtifactTypeSpec {
        artifact_type: ArtifactType::Whiteboard,
        slug: "whiteboard",
        entry_path: "structure/board.json",
        entry_mime: "application/json",
        default_dirs: &["structure", "asset"],
        export_suffix: ".whiteboard.json",
        supports_design_system: false,
    },
    ArtifactTypeSpec {
        artifact_type: ArtifactType::Design,
        slug: "design",
        entry_path: "structure/frames/main.json",
        entry_mime: "application/json",
        default_dirs: &["structure", "structure/frames", "asset"],
        export_suffix: ".design.json",
        supports_design_system: true,
    },
    ArtifactTypeSpec {
        artifact_type: ArtifactType::DesignSystem,
        slug: "design-system",
        entry_path: "structure/tokens.json",
        entry_mime: "application/json",
        default_dirs: &["structure", "structure/components", "asset"],
        export_suffix: ".design-system.json",
        supports_design_system: false,
    },
    ArtifactTypeSpec {
        artifact_type: ArtifactType::Sheet,
        slug: "sheet",
        entry_path: "structure/workbook.json",
        entry_mime: "application/json",
        default_dirs: &["structure", "structure/sheets", "asset"],
        export_suffix: ".sheet.json",
        supports_design_system: false,
    },
    ArtifactTypeSpec {
        artifact_type: ArtifactType::Prototype,
        slug: "prototype",
        entry_path: "structure/index.html",
        entry_mime: "text/html",
        default_dirs: &["structure", "asset"],
        export_suffix: ".html",
        supports_design_system: true,
    },
    ArtifactTypeSpec {
        artifact_type: ArtifactType::Diagram,
        slug: "diagram",
        entry_path: "structure/diagram.json",
        entry_mime: "application/json",
        default_dirs: &["structure", "asset"],
        export_suffix: ".diagram.json",
        supports_design_system: false,
    },
    ArtifactTypeSpec {
        artifact_type: ArtifactType::Storyboard,
        slug: "storyboard",
        entry_path: "structure/shots.json",
        entry_mime: "application/json",
        default_dirs: &["structure", "asset", "asset/frames", "asset/refs", "asset/audio"],
        export_suffix: ".storyboard.json",
        supports_design_system: false,
    },
];

/// Returns all 12 canonical artifact type specifications in `ArtifactType::ALL` order.
pub fn all_type_specs() -> &'static [ArtifactTypeSpec] {
    &ALL_SPECS
}

/// Returns the canonical directory specification for `artifact_type`.
pub fn type_spec(artifact_type: ArtifactType) -> &'static ArtifactTypeSpec {
    match artifact_type {
        ArtifactType::Docs => &ALL_SPECS[0],
        ArtifactType::Outline => &ALL_SPECS[1],
        ArtifactType::Slides => &ALL_SPECS[2],
        ArtifactType::Dashboard => &ALL_SPECS[3],
        ArtifactType::Motion => &ALL_SPECS[4],
        ArtifactType::Whiteboard => &ALL_SPECS[5],
        ArtifactType::Design => &ALL_SPECS[6],
        ArtifactType::DesignSystem => &ALL_SPECS[7],
        ArtifactType::Sheet => &ALL_SPECS[8],
        ArtifactType::Prototype => &ALL_SPECS[9],
        ArtifactType::Diagram => &ALL_SPECS[10],
        ArtifactType::Storyboard => &ALL_SPECS[11],
    }
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
