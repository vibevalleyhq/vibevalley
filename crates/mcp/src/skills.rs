//! SEP-2640 Skills over MCP (`skill://`): typed skill catalog, progressive
//! disclosure over `skills/list`, `skills/get`, and `resources/read`.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::protocol::{ResourceContent, ResourceDef, ResourceTemplateDef};

pub const SKILL_URI_SCHEME: &str = "skill://";

/// Skill metadata entry returned by `skills/list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDef {
    pub uri: String,
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
}

/// Full skill document returned by `skills/get`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDocument {
    pub uri: String,
    pub name: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
}

/// Optional parameters for `skills/list`.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillListParams {
    #[serde(default)]
    pub tag: Option<String>,
}

/// Parameters for `skills/get`.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillGetParams {
    #[serde(default)]
    pub uri: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub file: Option<String>,
}

#[derive(Debug, Clone)]
struct StoredSkill {
    def: SkillDef,
    content: String,
    files: BTreeMap<String, String>,
}

/// In-memory catalog of SEP-2640 skills loaded from embedded assets or disk directories.
#[derive(Debug, Clone, Default)]
pub struct SkillCatalog {
    /// Keyed by canonical skill URI (`skill://<namespace>/<slug>` or `skill://<slug>`).
    skills: BTreeMap<String, StoredSkill>,
    namespaces: Vec<String>,
}

impl SkillCatalog {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.skills.is_empty()
    }

    pub fn len(&self) -> usize {
        self.skills.len()
    }

    /// True when `uri` uses the `skill://` scheme.
    pub fn is_skill_uri(uri: &str) -> bool {
        uri.trim().starts_with(SKILL_URI_SCHEME)
    }

    /// Registers one skill directly into the catalog.
    pub fn register(&mut self, mut def: SkillDef, content: String, mut file_contents: BTreeMap<String, String>) {
        if !file_contents.contains_key("SKILL.md") {
            file_contents.insert("SKILL.md".to_owned(), content.clone());
        }
        if def.files.is_empty() {
            def.files = file_contents.keys().cloned().collect();
        } else {
            def.files.sort();
            def.files.dedup();
        }
        if let Some(ns) = extract_namespace(&def.uri)
            && !self.namespaces.iter().any(|existing| existing == ns)
        {
            self.namespaces.push(ns.to_owned());
            self.namespaces.sort();
        }
        let uri = def.uri.clone();
        self.skills.insert(
            uri,
            StoredSkill {
                def,
                content,
                files: file_contents,
            },
        );
    }

    /// Builds a skill catalog from embedded `(relative_path, content)` entries.
    ///
    /// Expects entries organized as `<slug>/SKILL.md`, `<slug>/references/<file>.md`, etc.
    /// Each `<slug>` containing a `SKILL.md` becomes `skill://<namespace>/<slug>` (or
    /// `skill://<slug>` when `namespace` is empty).
    pub fn from_embedded_entries(namespace: &str, entries: &[(&str, &str)]) -> Self {
        let mut grouped: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
        for (raw_path, content) in entries {
            let Some(clean) = normalize_rel_path(raw_path) else {
                continue;
            };
            let Some((slug, rel)) = clean.split_once('/') else {
                continue;
            };
            if slug.is_empty() || rel.is_empty() {
                continue;
            }
            grouped.entry(slug.to_owned()).or_default().insert(rel.to_owned(), (*content).to_owned());
        }
        Self::from_grouped_files(namespace, grouped)
    }

    /// Loads a skill catalog from a directory where each immediate child directory
    /// containing a `SKILL.md` defines one skill.
    pub fn from_directory(namespace: &str, root: &Path) -> std::io::Result<Self> {
        let mut grouped: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
        if !root.exists() {
            return Ok(Self::new());
        }
        for entry in std::fs::read_dir(root)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(slug) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !path.join("SKILL.md").is_file() {
                continue;
            }
            let mut files = BTreeMap::new();
            collect_dir_files(&path, &path, &mut files)?;
            grouped.insert(slug.to_owned(), files);
        }
        Ok(Self::from_grouped_files(namespace, grouped))
    }

    fn from_grouped_files(namespace: &str, grouped: BTreeMap<String, BTreeMap<String, String>>) -> Self {
        let ns = namespace.trim().trim_matches('/');
        let mut catalog = Self::new();
        for (slug, files) in grouped {
            let Some(main_content) = files.get("SKILL.md").cloned() else {
                continue;
            };
            let parsed = parse_skill_markdown(&main_content);
            let uri = if ns.is_empty() {
                format!("{SKILL_URI_SCHEME}{slug}")
            } else {
                format!("{SKILL_URI_SCHEME}{ns}/{slug}")
            };
            let name = parsed.name.unwrap_or_else(|| slug.clone());
            let description = parsed.description.unwrap_or_else(|| name.clone());
            let mut tags = parsed.tags;
            if !ns.is_empty() && !tags.iter().any(|t| t == ns) {
                tags.insert(0, ns.to_owned());
            }
            let file_list: Vec<String> = files.keys().cloned().collect();
            let def = SkillDef {
                uri,
                name,
                description,
                tags,
                files: file_list,
            };
            catalog.register(def, main_content, files);
        }
        catalog
    }

    /// Lists skills, optionally filtered by `tag` (case-insensitive).
    pub fn list(&self, tag: Option<&str>) -> Vec<SkillDef> {
        let filter = tag.map(str::trim).filter(|t| !t.is_empty());
        self.skills
            .values()
            .filter(|s| filter.is_none_or(|wanted| s.def.tags.iter().any(|t| t.eq_ignore_ascii_case(wanted))))
            .map(|s| s.def.clone())
            .collect()
    }

    /// Fetches a skill document by full `skill://` URI (optionally including a sub-file
    /// path) or by skill name/slug, with an optional explicit `file` selector.
    pub fn get(&self, uri_or_name: &str, file: Option<&str>) -> Option<SkillDocument> {
        let key = uri_or_name.trim();
        if key.is_empty() {
            return None;
        }
        let explicit_file = file.map(str::trim).filter(|f| !f.is_empty());

        // 1. Direct skill URI lookup (exact or with sub-file path).
        if let Some((stored, uri_subfile)) = self.resolve_by_uri(key) {
            let chosen = explicit_file.or(uri_subfile);
            return build_document(stored, chosen);
        }

        // 2. Lookup by skill name or `<namespace>/<slug>` or `<slug>`.
        let stored = self
            .skills
            .values()
            .find(|s| s.def.name == key || s.def.uri.strip_prefix(SKILL_URI_SCHEME) == Some(key) || s.def.uri.rsplit('/').next() == Some(key))?;
        build_document(stored, explicit_file)
    }

    /// Reads a `skill://` URI as an MCP [`ResourceContent`].
    pub fn read_resource(&self, uri: &str) -> Option<ResourceContent> {
        let trimmed = uri.trim();
        let (stored, subfile) = self.resolve_by_uri(trimmed)?;
        let (resolved_uri, content, mime) = match subfile {
            None => (stored.def.uri.clone(), stored.content.clone(), "text/markdown"),
            Some(rel) => {
                let norm = normalize_rel_path(rel)?;
                let body = stored.files.get(&norm)?.clone();
                let mime = guess_skill_mime(&norm);
                (format!("{}/{norm}", stored.def.uri), body, mime)
            }
        };
        Some(ResourceContent::text(resolved_uri, mime, content))
    }

    /// Exposes registered skills as standard MCP [`ResourceDef`] entries for `resources/list`.
    pub fn as_resources(&self) -> Vec<ResourceDef> {
        self.skills
            .values()
            .map(|s| ResourceDef {
                uri: s.def.uri.clone(),
                name: s.def.name.clone(),
                description: Some(s.def.description.clone()),
                mime_type: Some("text/markdown".to_owned()),
            })
            .collect()
    }

    /// Exposes `skill://` URI templates for `resources/templates/list`.
    pub fn as_resource_templates(&self) -> Vec<ResourceTemplateDef> {
        if self.skills.is_empty() {
            return Vec::new();
        }
        if self.namespaces.is_empty() {
            vec![ResourceTemplateDef {
                uri_template: "skill://{name}".to_owned(),
                name: "Skill Guide".to_owned(),
                description: Some("Read an MCP skill guide or one of its supporting files".to_owned()),
                mime_type: Some("text/markdown".to_owned()),
            }]
        } else {
            vec![
                ResourceTemplateDef {
                    uri_template: "skill://{namespace}/{name}".to_owned(),
                    name: "Skill Guide".to_owned(),
                    description: Some("Read an MCP skill guide by namespace and name".to_owned()),
                    mime_type: Some("text/markdown".to_owned()),
                },
                ResourceTemplateDef {
                    uri_template: "skill://{namespace}/{name}/{path}".to_owned(),
                    name: "Skill Supporting File".to_owned(),
                    description: Some("Read a progressive-disclosure file inside an MCP skill directory".to_owned()),
                    mime_type: Some("text/markdown".to_owned()),
                },
            ]
        }
    }

    fn resolve_by_uri<'a>(&'a self, uri: &'a str) -> Option<(&'a StoredSkill, Option<&'a str>)> {
        if !uri.starts_with(SKILL_URI_SCHEME) {
            return None;
        }
        let clean = uri.trim_end_matches('/');
        if let Some(exact) = self.skills.get(clean) {
            return Some((exact, None));
        }
        // Match longest skill URI prefix followed by `/<subfile>`.
        self.skills.iter().rev().find_map(|(base_uri, stored)| {
            let sub = clean.strip_prefix(base_uri)?.strip_prefix('/')?;
            (!sub.is_empty()).then_some((stored, Some(sub)))
        })
    }
}

fn build_document(stored: &StoredSkill, file: Option<&str>) -> Option<SkillDocument> {
    match file {
        None => Some(SkillDocument {
            uri: stored.def.uri.clone(),
            name: stored.def.name.clone(),
            content: stored.content.clone(),
            files: stored.def.files.clone(),
        }),
        Some(raw_rel) => {
            let norm = normalize_rel_path(raw_rel)?;
            let body = stored.files.get(&norm)?.clone();
            Some(SkillDocument {
                uri: format!("{}/{norm}", stored.def.uri),
                name: stored.def.name.clone(),
                content: body,
                files: stored.def.files.clone(),
            })
        }
    }
}

fn extract_namespace(uri: &str) -> Option<&str> {
    let rest = uri.strip_prefix(SKILL_URI_SCHEME)?;
    let (ns, _) = rest.split_once('/')?;
    (!ns.is_empty()).then_some(ns)
}

fn normalize_rel_path(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with('/') || trimmed.contains('\\') || trimmed.contains('\0') {
        return None;
    }
    let mut parts = Vec::new();
    for seg in trimmed.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return None;
        }
        parts.push(seg);
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn guess_skill_mime(rel_path: &str) -> &'static str {
    let lower = rel_path.to_ascii_lowercase();
    if lower.ends_with(".md") || lower.ends_with(".markdown") {
        "text/markdown"
    } else if lower.ends_with(".json") {
        "application/json"
    } else if lower.ends_with(".yaml") || lower.ends_with(".yml") {
        "text/yaml"
    } else {
        "text/plain"
    }
}

fn collect_dir_files(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_dir_files(root, &path, out)?;
        } else if path.is_file()
            && let Ok(rel) = path.strip_prefix(root)
            && let Some(rel_str) = rel.to_str()
            && let Some(norm) = normalize_rel_path(&rel_str.replace('\\', "/"))
            && let Ok(content) = std::fs::read_to_string(&path)
        {
            out.insert(norm, content);
        }
    }
    Ok(())
}

struct ParsedSkillMeta {
    name: Option<String>,
    description: Option<String>,
    tags: Vec<String>,
}

/// Parses optional YAML frontmatter (`name`, `description`, `tags`) or falls back
/// to the first Markdown heading / paragraph.
fn parse_skill_markdown(raw: &str) -> ParsedSkillMeta {
    let normalized = raw.replace("\r\n", "\n");
    let mut name = None;
    let mut description = None;
    let mut tags = Vec::new();

    let body = if let Some(after_open) = normalized.strip_prefix("---\n") {
        if let Some(end_idx) = after_open.find("\n---\n") {
            let fm = &after_open[..end_idx];
            parse_frontmatter(fm, &mut name, &mut description, &mut tags);
            &after_open[end_idx + 5..]
        } else {
            normalized.as_str()
        }
    } else {
        normalized.as_str()
    };

    if description.is_none() {
        for line in body.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Some(heading) = trimmed.strip_prefix('#') {
                let text = heading.trim_start_matches('#').trim();
                if !text.is_empty() {
                    description = Some(text.to_owned());
                    break;
                }
            } else {
                description = Some(trimmed.to_owned());
                break;
            }
        }
    }

    ParsedSkillMeta { name, description, tags }
}

fn parse_frontmatter(fm: &str, name: &mut Option<String>, description: &mut Option<String>, tags: &mut Vec<String>) {
    for line in fm.lines() {
        let trimmed = line.trim();
        let Some((key, val)) = trimmed.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let val = val.trim().trim_matches('"').trim_matches('\'').trim();
        if val.is_empty() {
            continue;
        }
        match key {
            "name" => *name = Some(val.to_owned()),
            "description" => *description = Some(val.to_owned()),
            "tags" => {
                let inner = val.trim_start_matches('[').trim_end_matches(']');
                for item in inner.split(',') {
                    let clean = item.trim().trim_matches('"').trim_matches('\'').trim();
                    if !clean.is_empty() {
                        tags.push(clean.to_owned());
                    }
                }
            }
            _ => {}
        }
    }
}
