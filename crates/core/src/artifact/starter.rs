//! Canonical starter directory builder for all 12 `ArtifactType`s.
//!
//! Each starter matches the directory layout and schema documented in
//! `crates/server/assets/artifact/types/<type>/SKILL.en.md`.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use vibevalley_protocol::ArtifactType;

use crate::artifact::manifest::{ArtifactManifest, default_manifest, serialize_manifest, type_spec};
use crate::artifact::path::{MANIFEST_FILE, infer_mime};

/// One initial file written when creating an artifact directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StarterFile {
    pub path: String,
    pub mime: String,
    pub content: String,
}

/// Complete starter directory layout (`manifest.json` + directories + `structure/*` files).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StarterDirectory {
    pub manifest: ArtifactManifest,
    pub dirs: Vec<String>,
    pub files: Vec<StarterFile>,
}

fn json_file(path: &str, value: Value) -> StarterFile {
    let mut content = serde_json::to_string_pretty(&value).expect("starter json serializes");
    content.push('\n');
    StarterFile {
        path: path.to_owned(),
        mime: "application/json".to_owned(),
        content,
    }
}

fn text_file(path: &str, content: String) -> StarterFile {
    StarterFile {
        path: path.to_owned(),
        mime: infer_mime(path).to_owned(),
        content,
    }
}

fn clean_title(title: &str, fallback: &str) -> String {
    let trimmed = title.trim();
    if trimmed.is_empty() { fallback.to_owned() } else { trimmed.to_owned() }
}

fn escape_html(raw: &str) -> String {
    raw.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Returns the initial `structure/*` starter files for `artifact_type`.
pub fn starter_files_for_type(artifact_type: ArtifactType, title: &str) -> Vec<StarterFile> {
    match artifact_type {
        ArtifactType::Docs => {
            let label = clean_title(title, "Untitled Document");
            vec![text_file("structure/index.md", format!("# {label}\n\n"))]
        }
        ArtifactType::Outline => {
            let label = clean_title(title, "Untitled Outline");
            vec![json_file(
                "structure/outline.json",
                json!({
                    "version": 1,
                    "rootIds": ["n_root"],
                    "nodes": {
                        "n_root": {
                            "id": "n_root",
                            "text": label,
                            "kind": "heading",
                            "children": []
                        }
                    }
                }),
            )]
        }
        ArtifactType::Slides => {
            let label = clean_title(title, "Untitled Deck");
            vec![
                json_file(
                    "structure/deck.json",
                    json!({
                        "title": label,
                        "aspectRatio": "16:9",
                        "designSystemId": null,
                        "slides": [
                            { "id": "s01-cover", "file": "structure/slides/s01-cover.json", "title": label }
                        ]
                    }),
                ),
                json_file(
                    "structure/slides/s01-cover.json",
                    json!({
                        "id": "s01-cover",
                        "layout": "cover",
                        "title": label,
                        "subtitle": "",
                        "blocks": [],
                        "notes": ""
                    }),
                ),
            ]
        }
        ArtifactType::Dashboard => {
            let label = clean_title(title, "Untitled Dashboard");
            vec![
                json_file(
                    "structure/dashboard.json",
                    json!({
                        "title": label,
                        "filters": [],
                        "panels": [
                            {
                                "id": "kpi_primary",
                                "kind": "kpi",
                                "label": "Primary Metric",
                                "source": { "dataset": "structure/data/sample.json", "field": "value", "agg": "sum" },
                                "format": "number"
                            }
                        ]
                    }),
                ),
                json_file(
                    "structure/data/sample.json",
                    json!({
                        "schema": [
                            { "name": "label", "type": "string" },
                            { "name": "value", "type": "number" }
                        ],
                        "rows": [
                            { "label": "Period 1", "value": 100 }
                        ]
                    }),
                ),
            ]
        }
        ArtifactType::Motion => {
            let label = clean_title(title, "Untitled Motion");
            vec![
                json_file(
                    "structure/timeline.json",
                    json!({
                        "title": label,
                        "width": 1920,
                        "height": 1080,
                        "fps": 30,
                        "duration": 6.0,
                        "background": "#151413",
                        "chapters": [{ "at": 0, "label": "Intro" }],
                        "scenes": [
                            { "id": "sc01-intro", "file": "structure/scenes/sc01-intro.json", "start": 0.0, "end": 6.0 }
                        ],
                        "audioTracks": []
                    }),
                ),
                json_file(
                    "structure/scenes/sc01-intro.json",
                    json!({
                        "id": "sc01-intro",
                        "title": label,
                        "layers": [
                            { "id": "title", "kind": "text", "text": label, "x": 960, "y": 540, "opacity": 1.0 }
                        ]
                    }),
                ),
            ]
        }
        ArtifactType::Whiteboard => {
            let label = clean_title(title, "Untitled Board");
            vec![json_file(
                "structure/board.json",
                json!({
                    "version": 1,
                    "grid": "architectural",
                    "viewport": { "x": 0, "y": 0, "zoom": 1 },
                    "elements": {
                        "t1": {
                            "id": "t1",
                            "type": "text",
                            "variant": "title",
                            "x": 80,
                            "y": 40,
                            "w": 640,
                            "h": 54,
                            "label": label
                        }
                    }
                }),
            )]
        }
        ArtifactType::Design => {
            let label = clean_title(title, "Untitled Design");
            vec![json_file(
                "structure/frames/main.json",
                json!({
                    "id": "main",
                    "name": label,
                    "width": 1280,
                    "height": 800,
                    "background": "#fcfcfb",
                    "nodes": []
                }),
            )]
        }
        ArtifactType::DesignSystem => {
            let label = clean_title(title, "Design System");
            vec![
                json_file(
                    "structure/tokens.json",
                    json!({
                        "name": label,
                        "version": "1.0.0",
                        "defaultTheme": "light",
                        "color": {
                            "surface": { "light": "#fcfcfb", "dark": "#151413" },
                            "ink": { "light": "#1c1917", "dark": "#f5f5f4" },
                            "accent": { "light": "#4d7a2a", "dark": "#84cc16" }
                        },
                        "typography": {
                            "sans": "system-ui, sans-serif",
                            "mono": "ui-monospace, monospace"
                        },
                        "space": { "sm": 8, "md": 16, "lg": 24 },
                        "radius": { "sm": 6, "md": 10, "lg": 16 }
                    }),
                ),
                json_file(
                    "structure/components/button.json",
                    json!({
                        "id": "button",
                        "name": "Button",
                        "variants": ["primary", "secondary", "ghost"],
                        "states": ["default", "hover", "active", "disabled"]
                    }),
                ),
            ]
        }
        ArtifactType::Sheet => {
            let label = clean_title(title, "Untitled Workbook");
            vec![
                json_file(
                    "structure/workbook.json",
                    json!({
                        "title": label,
                        "locale": "en-US",
                        "currency": "USD",
                        "sheets": [
                            { "id": "sheet1", "title": "Sheet 1", "file": "structure/sheets/sheet1.json" }
                        ],
                        "namedRanges": {}
                    }),
                ),
                json_file(
                    "structure/sheets/sheet1.json",
                    json!({
                        "id": "sheet1",
                        "title": "Sheet 1",
                        "columns": [
                            { "key": "A", "title": "Item", "type": "string" },
                            { "key": "B", "title": "Value", "type": "number" }
                        ],
                        "rows": []
                    }),
                ),
            ]
        }
        ArtifactType::Prototype => {
            let label = clean_title(title, "Untitled Prototype");
            let safe = escape_html(&label);
            vec![
                text_file(
                    "structure/index.html",
                    format!(
                        "<!doctype html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\" />\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n  <title>{safe}</title>\n  <link rel=\"stylesheet\" href=\"./styles.css\" />\n</head>\n<body>\n  <main id=\"app\">\n    <h1>{safe}</h1>\n  </main>\n  <script type=\"module\" src=\"./app.js\"></script>\n</body>\n</html>\n"
                    ),
                ),
                text_file(
                    "structure/styles.css",
                    ":root {\n  --surface: #fcfcfb;\n  --ink: #1c1917;\n  --accent: #4d7a2a;\n}\nbody {\n  margin: 0;\n  font-family: system-ui, sans-serif;\n  background: var(--surface);\n  color: var(--ink);\n  padding: 24px;\n}\n"
                        .to_owned(),
                ),
                text_file("structure/app.js", "export const state = { ready: true };\n".to_owned()),
            ]
        }
        ArtifactType::Diagram => {
            let label = clean_title(title, "Untitled Diagram");
            vec![json_file(
                "structure/diagram.json",
                json!({
                    "title": label,
                    "kind": "architecture",
                    "direction": "LR",
                    "nodes": [
                        { "id": "n1", "label": label, "kind": "service" }
                    ],
                    "edges": []
                }),
            )]
        }
        ArtifactType::Storyboard => {
            let label = clean_title(title, "Untitled Storyboard");
            vec![json_file(
                "structure/shots.json",
                json!({
                    "title": label,
                    "aspectRatio": "16:9",
                    "fps": 30,
                    "styleGuide": {
                        "visualTone": "",
                        "palette": ["#fcfcfb", "#1c1917", "#4d7a2a"],
                        "continuityRefs": []
                    },
                    "shots": [
                        {
                            "id": "sh01",
                            "scene": "Opening",
                            "durationSec": 3.0,
                            "framing": "wide",
                            "camera": "static",
                            "visual": "",
                            "dialogue": "",
                            "status": "draft"
                        }
                    ]
                }),
            )]
        }
    }
}

/// Builds the complete starter directory (`manifest.json`, directories, and `structure/*` files)
/// for a new artifact of `artifact_type`.
pub fn starter_directory(id: &str, artifact_type: ArtifactType, title: &str) -> StarterDirectory {
    let spec = type_spec(artifact_type);
    let label = clean_title(title, spec.slug);
    let structure_files = starter_files_for_type(artifact_type, &label);
    let mut manifest = default_manifest(id, artifact_type, &label);
    manifest.files = structure_files.iter().map(|f| f.path.clone()).collect();
    if artifact_type == ArtifactType::Diagram {
        manifest.meta.insert("diagramKind".to_owned(), json!("architecture"));
    } else if artifact_type == ArtifactType::Prototype {
        manifest.meta.insert("viewport".to_owned(), json!({ "width": 1280, "height": 800 }));
    }

    let manifest_json = serialize_manifest(&manifest).expect("starter manifest is valid");
    let mut files = Vec::with_capacity(structure_files.len() + 1);
    files.push(StarterFile {
        path: MANIFEST_FILE.to_owned(),
        mime: "application/json".to_owned(),
        content: manifest_json,
    });
    files.extend(structure_files);

    StarterDirectory {
        manifest,
        dirs: spec.default_dirs.iter().map(|d| (*d).to_owned()).collect(),
        files,
    }
}
