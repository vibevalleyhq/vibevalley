//! Artifact type registry and progressive-disclosure guides (`types.ts`),
//! embedded from `assets/artifact/types/`.

use include_dir::{Dir, include_dir};
use vibevalley_i18n::{list, t};
use vibevalley_protocol::{ApiError, ArtifactType, ArtifactTypeGuide, ArtifactTypeInfo, ArtifactTypeReadRequest};

use super::{ArtifactStore, db, q, refused};

static TYPES_DIR: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/assets/artifact/types");

fn strip_frontmatter(raw: &str) -> String {
    let normalized = raw.replace("\r\n", "\n");
    if !normalized.starts_with("---\n") {
        return normalized.trim().to_string();
    }
    match normalized[4..].find("\n---\n") {
        Some(offset) => normalized[4 + offset + 5..].trim().to_string(),
        None => normalized.trim().to_string(),
    }
}

fn type_words(ty: ArtifactType) -> (String, String) {
    match ty {
        ArtifactType::Docs => (t("server.artifact.types.docs.title", &[]), t("server.artifact.types.docs.summary", &[])),
        ArtifactType::Outline => (t("server.artifact.types.outline.title", &[]), t("server.artifact.types.outline.summary", &[])),
        ArtifactType::Slides => (t("server.artifact.types.slides.title", &[]), t("server.artifact.types.slides.summary", &[])),
        ArtifactType::Dashboard => (
            t("server.artifact.types.dashboard.title", &[]),
            t("server.artifact.types.dashboard.summary", &[]),
        ),
        ArtifactType::Motion => (t("server.artifact.types.motion.title", &[]), t("server.artifact.types.motion.summary", &[])),
        ArtifactType::Whiteboard => (
            t("server.artifact.types.whiteboard.title", &[]),
            t("server.artifact.types.whiteboard.summary", &[]),
        ),
        ArtifactType::Design => (t("server.artifact.types.design.title", &[]), t("server.artifact.types.design.summary", &[])),
        ArtifactType::DesignSystem => (
            t("server.artifact.types.design-system.title", &[]),
            t("server.artifact.types.design-system.summary", &[]),
        ),
    }
}

fn list_references(ty: ArtifactType) -> Vec<String> {
    let path = format!("{}/references", ty.as_str());
    let Some(dir) = TYPES_DIR.get_dir(&path) else {
        return vec![];
    };
    let mut names: Vec<String> = dir
        .files()
        .filter_map(|f| f.path().file_name()?.to_str()?.strip_suffix(".md").map(str::to_string))
        .collect();
    names.sort();
    names
}

fn read_asset(path: &str) -> Result<String, ApiError> {
    let file = TYPES_DIR
        .get_file(path)
        .ok_or_else(|| crate::app::refusal::internal(format!("missing embedded artifact guide: {path}")))?;
    let raw = file
        .contents_utf8()
        .ok_or_else(|| crate::app::refusal::internal(format!("non-utf8 artifact guide: {path}")))?;
    Ok(strip_frontmatter(raw))
}

impl ArtifactStore {
    pub async fn list_types_async(&self) -> Result<Vec<ArtifactTypeInfo>, ApiError> {
        let def = db::default_design_system_artifact(self.db.read_conn()).await.map_err(q)?;
        let mut out = Vec::with_capacity(ArtifactType::ALL.len());
        for ty in ArtifactType::ALL {
            let (title, summary) = type_words(ty);
            out.push(ArtifactTypeInfo {
                r#type: ty,
                body: ty.body(),
                title,
                summary,
                references: list_references(ty),
                default_artifact_id: if ty == ArtifactType::DesignSystem {
                    def.as_ref().map(|d| d.id.clone())
                } else {
                    None
                },
            });
        }
        Ok(out)
    }

    pub async fn read_type_async(&self, req: &ArtifactTypeReadRequest) -> Result<ArtifactTypeGuide, ApiError> {
        let ty = req.r#type;
        let references = list_references(ty);
        let (title, _) = type_words(ty);
        let def = db::default_design_system_artifact(self.db.read_conn()).await.map_err(q)?;
        let raw_ref = req.reference.as_deref().unwrap_or("").trim();
        let wanted = if raw_ref.len() >= 3 && raw_ref[raw_ref.len() - 3..].eq_ignore_ascii_case(".md") {
            &raw_ref[..raw_ref.len() - 3]
        } else {
            raw_ref
        };
        let (reference, content) = if !wanted.is_empty() {
            if !references.iter().any(|r| r == wanted) {
                let available = if references.is_empty() { "-".to_string() } else { list(&references) };
                return Err(refused(t(
                    "server.artifact.noReference",
                    &[
                        ("type", ty.as_str().into()),
                        ("reference", req.reference.as_deref().unwrap_or(wanted).into()),
                        ("available", available.into()),
                    ],
                )));
            }
            (Some(wanted.to_string()), read_asset(&format!("{}/references/{wanted}.md", ty.as_str()))?)
        } else {
            let skill_file = if vibevalley_i18n::locale() == "en" { "SKILL.en.md" } else { "SKILL.md" };
            (None, read_asset(&format!("{}/{skill_file}", ty.as_str()))?)
        };
        Ok(ArtifactTypeGuide {
            r#type: ty,
            title,
            reference,
            content,
            references,
            default_artifact_id: def.as_ref().map(|d| d.id.clone()),
            default_artifact_title: def.as_ref().map(|d| d.title.clone()),
        })
    }
}
