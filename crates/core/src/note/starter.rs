//! Canonical starter directory builder for all 4 [`NoteType`] primitives
//! (`doc`, `base`, `canvas`, `media`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use vibevalley_protocol::{
    BaseCellValue, BaseColumn, BaseColumnKind, BaseRow, BaseSelectOption, BaseSheet, BaseViewConfig, BaseViewKind, BlockKind, DocBlock, NoteType,
};

use crate::note::base::{BaseDocument, serialize_base_document};
use crate::note::doc::{DocDocument, serialize_doc_document};
use crate::note::manifest::{NoteManifest, default_manifest, serialize_manifest, type_spec};
use crate::note::path::MANIFEST_FILE;

/// One initial file written when creating a note directory.
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
    pub manifest: NoteManifest,
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

fn clean_title(title: &str, fallback: &str) -> String {
    let trimmed = title.trim();
    if trimmed.is_empty() { fallback.to_owned() } else { trimmed.to_owned() }
}

/// Returns the initial `structure/*` starter files for `note_type`.
pub fn starter_files_for_type(note_type: NoteType, title: &str) -> Vec<StarterFile> {
    match note_type {
        NoteType::Doc => {
            let label = clean_title(title, "Untitled Doc");
            let doc = DocDocument {
                version: 1,
                blocks: vec![
                    DocBlock {
                        id: "b1".to_owned(),
                        kind: BlockKind::Heading { level: 1, text: label },
                        collapsed: None,
                        children: None,
                    },
                    DocBlock {
                        id: "b2".to_owned(),
                        kind: BlockKind::Prose { text: String::new() },
                        collapsed: None,
                        children: None,
                    },
                ],
            };
            vec![StarterFile {
                path: "structure/doc.json".to_owned(),
                mime: "application/json".to_owned(),
                content: serialize_doc_document(&doc).expect("starter doc serializes"),
            }]
        }
        NoteType::Base => {
            let label = clean_title(title, "Untitled Base");
            let mut starter_cells = BTreeMap::new();
            starter_cells.insert(
                "c_title".to_owned(),
                BaseCellValue::Text {
                    value: format!("{label} Item 1"),
                },
            );
            starter_cells.insert("c_status".to_owned(), BaseCellValue::Text { value: "todo".to_owned() });
            let doc = BaseDocument {
                version: 1,
                sheets: vec![BaseSheet {
                    id: "sheet1".to_owned(),
                    name: label,
                    columns: vec![
                        BaseColumn {
                            id: "c_title".to_owned(),
                            name: "Title".to_owned(),
                            kind: BaseColumnKind::Text,
                            options: None,
                            agent_config: None,
                            formula: None,
                            width: Some(260),
                        },
                        BaseColumn {
                            id: "c_status".to_owned(),
                            name: "Status".to_owned(),
                            kind: BaseColumnKind::Select,
                            options: Some(vec![
                                BaseSelectOption {
                                    value: "todo".to_owned(),
                                    label: Some("Todo".to_owned()),
                                    color: Some("stone".to_owned()),
                                },
                                BaseSelectOption {
                                    value: "doing".to_owned(),
                                    label: Some("Doing".to_owned()),
                                    color: Some("amber".to_owned()),
                                },
                                BaseSelectOption {
                                    value: "done".to_owned(),
                                    label: Some("Done".to_owned()),
                                    color: Some("green".to_owned()),
                                },
                            ]),
                            agent_config: None,
                            formula: None,
                            width: Some(140),
                        },
                        BaseColumn {
                            id: "c_issue".to_owned(),
                            name: "Issue".to_owned(),
                            kind: BaseColumnKind::IssueRef,
                            options: None,
                            agent_config: None,
                            formula: None,
                            width: Some(140),
                        },
                    ],
                    rows: vec![BaseRow {
                        id: "r1".to_owned(),
                        cells: starter_cells,
                        page_note_id: None,
                        created_at: 0,
                        updated_at: 0,
                    }],
                    views: vec![
                        BaseViewConfig {
                            id: "v_table".to_owned(),
                            name: "Table".to_owned(),
                            kind: BaseViewKind::Table,
                            group_by: None,
                            hidden_columns: None,
                            filters: None,
                            sorts: None,
                            summaries: None,
                        },
                        BaseViewConfig {
                            id: "v_board".to_owned(),
                            name: "Board".to_owned(),
                            kind: BaseViewKind::Board,
                            group_by: Some("c_status".to_owned()),
                            hidden_columns: None,
                            filters: None,
                            sorts: None,
                            summaries: None,
                        },
                    ],
                }],
            };
            vec![StarterFile {
                path: "structure/base.json".to_owned(),
                mime: "application/json".to_owned(),
                content: serialize_base_document(&doc).expect("starter base serializes"),
            }]
        }
        NoteType::Canvas => {
            let label = clean_title(title, "Untitled Canvas");
            vec![json_file(
                "structure/board.json",
                json!({
                    "version": 1,
                    "grid": "architectural",
                    "theme": "warm",
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
        NoteType::Media => {
            let label = clean_title(title, "Untitled Media");
            vec![json_file(
                "structure/media.json",
                json!({
                    "version": 1,
                    "title": label,
                    "mediaKind": "audio",
                    "caption": "",
                    "durationSec": null,
                    "posterAsset": null,
                    "items": []
                }),
            )]
        }
    }
}

/// Builds the complete starter directory (`manifest.json`, directories, and `structure/*` files)
/// for a new note of `note_type`.
pub fn starter_directory(id: &str, note_type: NoteType, title: &str) -> StarterDirectory {
    let spec = type_spec(note_type);
    let label = clean_title(title, spec.slug);
    let structure_files = starter_files_for_type(note_type, &label);
    let mut manifest = default_manifest(id, note_type, &label);
    manifest.files = structure_files.iter().map(|f| f.path.clone()).collect();

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
