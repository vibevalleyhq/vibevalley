//! Argument schemas and MCP tool definitions for `vv_note_*`, `vv_doc_*`, and `vv_base_*`.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{Value, json};
use vibevalley_mcp::ToolDef;
use vibevalley_protocol::{BaseCellValue, DocBlock, LinkEntityKind, NoteFileEncoding, NoteFileWriteItem, NoteType};

use super::tool_def;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NoteListArgs {
    #[serde(default, alias = "type")]
    pub(super) note_type: Option<NoteType>,
    #[serde(default)]
    pub(super) channel: Option<String>,
    #[serde(default)]
    pub(super) issue: Option<String>,
    #[serde(default)]
    pub(super) parent_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NoteGetArgs {
    pub(super) id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NoteCreateArgs {
    pub(super) title: String,
    #[serde(alias = "type")]
    pub(super) note_type: NoteType,
    #[serde(default)]
    pub(super) parent_id: Option<String>,
    #[serde(default)]
    pub(super) sort_order: Option<i64>,
    #[serde(default)]
    pub(super) content: Option<String>,
    #[serde(default)]
    pub(super) files: Option<Vec<NoteFileWriteItem>>,
    #[serde(default)]
    pub(super) channel: Option<String>,
    #[serde(default)]
    pub(super) issue: Option<String>,
    #[serde(default)]
    pub(super) note: Option<String>,
    #[serde(default)]
    pub(super) announce: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NoteReadArgs {
    pub(super) id: String,
    #[serde(default)]
    pub(super) path: Option<String>,
    #[serde(default)]
    pub(super) prefix: Option<String>,
    #[serde(default)]
    pub(super) version: Option<i64>,
    #[serde(default)]
    pub(super) include_files: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NoteWriteArgs {
    pub(super) id: String,
    #[serde(default)]
    pub(super) files: Option<Vec<NoteFileWriteItem>>,
    #[serde(default)]
    pub(super) path: Option<String>,
    #[serde(default)]
    pub(super) content: Option<String>,
    #[serde(default)]
    pub(super) encoding: Option<NoteFileEncoding>,
    #[serde(default)]
    pub(super) mime: Option<String>,
    #[serde(default)]
    pub(super) expected_hash: Option<String>,
    #[serde(default)]
    pub(super) delete_path: Option<String>,
    #[serde(default)]
    pub(super) origin: Option<String>,
    #[serde(default)]
    pub(super) summary: Option<String>,
    #[serde(default)]
    pub(super) announce: Option<bool>,
    #[serde(default)]
    pub(super) create_version: Option<bool>,
    #[serde(default)]
    pub(super) version_note: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NotePatchArgs {
    pub(super) id: String,
    #[serde(default)]
    pub(super) path: Option<String>,
    #[serde(default)]
    pub(super) patch: Option<Value>,
    #[serde(default)]
    pub(super) find: Option<String>,
    #[serde(default)]
    pub(super) replace: Option<String>,
    #[serde(default)]
    pub(super) replace_all: Option<bool>,
    #[serde(default)]
    pub(super) append: Option<String>,
    #[serde(default)]
    pub(super) prepend: Option<String>,
    #[serde(default)]
    pub(super) expected_hash: Option<String>,
    #[serde(default)]
    pub(super) origin: Option<String>,
    #[serde(default)]
    pub(super) summary: Option<String>,
    #[serde(default)]
    pub(super) announce: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum SuggestAction {
    List,
    Create,
    Accept,
    Reject,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NoteSuggestArgs {
    pub(super) action: SuggestAction,
    pub(super) id: String,
    #[serde(default, alias = "suggestion")]
    pub(super) suggestion_id: Option<String>,
    #[serde(default)]
    pub(super) path: Option<String>,
    #[serde(default)]
    pub(super) base_rev: Option<i64>,
    #[serde(default)]
    pub(super) base_hash: Option<String>,
    #[serde(default)]
    pub(super) content: Option<String>,
    #[serde(default)]
    pub(super) patch: Option<Value>,
    #[serde(default)]
    pub(super) target: Option<String>,
    #[serde(default)]
    pub(super) delete: Option<bool>,
    #[serde(default)]
    pub(super) summary: Option<String>,
    #[serde(default)]
    pub(super) start_offset: Option<u32>,
    #[serde(default)]
    pub(super) end_offset: Option<u32>,
    #[serde(default)]
    pub(super) cursor_start: Option<String>,
    #[serde(default)]
    pub(super) cursor_end: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NoteTreeMoveArgs {
    pub(super) id: String,
    #[serde(default)]
    pub(super) parent_id: Option<String>,
    #[serde(default)]
    pub(super) sort_order: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NoteLinkListArgs {
    pub(super) entity_kind: LinkEntityKind,
    pub(super) entity_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DocViewArgs {
    pub(super) id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DocAppendBlockArgs {
    pub(super) id: String,
    pub(super) block: DocBlock,
    #[serde(default)]
    pub(super) after_block_id: Option<String>,
    #[serde(default)]
    pub(super) origin: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BaseViewArgs {
    pub(super) id: String,
    #[serde(default)]
    pub(super) sheet_id: Option<String>,
    #[serde(default)]
    pub(super) view_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BaseUpsertRowArgs {
    pub(super) id: String,
    #[serde(default)]
    pub(super) sheet_id: Option<String>,
    #[serde(default)]
    pub(super) row_id: Option<String>,
    pub(super) cells: BTreeMap<String, BaseCellValue>,
    #[serde(default)]
    pub(super) origin: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BaseRunAgentColumnArgs {
    pub(super) id: String,
    #[serde(default)]
    pub(super) sheet_id: Option<String>,
    pub(super) column_id: String,
    #[serde(default)]
    pub(super) row_ids: Option<Vec<String>>,
    #[serde(default)]
    pub(super) origin: Option<String>,
}

fn note_type_enum_json() -> Vec<&'static str> {
    NoteType::ALL.into_iter().map(NoteType::as_str).collect()
}

fn encoding_enum_json() -> Vec<&'static str> {
    NoteFileEncoding::ALL.into_iter().map(NoteFileEncoding::as_str).collect()
}

fn file_write_item_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": { "type": "string", "description": "Relative path inside <storage>/note/<id>/ (`manifest.json`, `structure/*`, or `asset/*`)." },
            "content": { "type": "string", "description": "UTF-8 text (default) or base64 bytes when encoding is `base64`." },
            "encoding": { "type": "string", "enum": encoding_enum_json(), "description": "Payload encoding (`utf8` or `base64`)." },
            "mime": { "type": "string", "description": "Optional MIME type override." },
            "expectedHash": { "type": "string", "description": "Optional optimistic SHA-256 hash guard (empty string requires absent)." }
        },
        "required": ["path", "content"]
    })
}

pub(super) fn tool_definitions() -> Vec<ToolDef> {
    let type_enum = note_type_enum_json();
    vec![
        tool_def(
            "vv_note_list",
            "List directory-backed VibeValley notes with optional noteType, channel, issue, or parentId filter.",
            json!({
                "type": "object",
                "properties": {
                    "noteType": { "type": "string", "enum": type_enum, "description": "Optional NoteType filter (`doc`, `base`, `canvas`, `media`)." },
                    "channel": { "type": "string", "description": "Optional channel id or #name filter." },
                    "issue": { "type": "string", "description": "Optional linked issue number (e.g. '12' or '#12') or issue id." },
                    "parentId": { "type": "string", "description": "Optional parent note id filter in the page tree." }
                }
            }),
        ),
        tool_def(
            "vv_note_get",
            "Get full metadata for a VibeValley note, including its manifest, structure/asset file listing, immutable versions, open suggestions, and SEP-2640 skill URI.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Note id (e.g. 'note_...')." }
                },
                "required": ["id"]
            }),
        ),
        tool_def(
            "vv_note_create",
            "Create a directory-backed collaborative note of any of the 4 NoteTypes (`doc`, `base`, `canvas`, `media`). Before authoring content, inspect SEP-2640 skills via `skills/list` and read `skill://note/<type>` via `skills/get` (or `resources/read`) for progressive disclosure of that primitive's `structure/` layout and collaboration conventions.",
            json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Note display title (max 200 chars)." },
                    "noteType": { "type": "string", "enum": type_enum, "description": "One of the 4 canonical NoteTypes (`doc`, `base`, `canvas`, `media`). Read `skill://note/<type>` via `skills/get` first for schema and structure/ conventions." },
                    "parentId": { "type": "string", "description": "Optional parent note id in the page tree." },
                    "sortOrder": { "type": "integer", "description": "Optional sibling sort order." },
                    "content": { "type": "string", "description": "Optional initial UTF-8 content for the primitive's primary entry file." },
                    "files": { "type": "array", "items": file_write_item_schema(), "description": "Optional initial files (`manifest.json`, `structure/*`, `asset/*`) merged onto the starter skeleton." },
                    "channel": { "type": "string", "description": "Optional channel id or #name to announce in." },
                    "issue": { "type": "string", "description": "Optional linked issue number or id." },
                    "note": { "type": "string", "description": "Optional initial version/announcement note." },
                    "announce": { "type": "boolean", "description": "Whether to announce a note card in the target channel." }
                },
                "required": ["title", "noteType"]
            }),
        ),
        tool_def(
            "vv_note_read",
            "Read a note's primary entry file, a specific file inside `<storage>/note/<id>/` (e.g. `manifest.json`, `structure/...`, `asset/...`), or list directory files by prefix.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Note id." },
                    "path": { "type": "string", "description": "Optional relative path inside `<storage>/note/<id>/` (omit to read the primary entry file)." },
                    "prefix": { "type": "string", "description": "Optional directory prefix filter (`manifest.json`, `structure/`, or `asset/`) to list files when `path` is omitted." },
                    "version": { "type": "integer", "minimum": 1, "description": "Optional immutable snapshot version number to read from." },
                    "includeFiles": { "type": "boolean", "description": "When true, include the note directory file listing alongside the read file." }
                },
                "required": ["id"]
            }),
        ),
        tool_def(
            "vv_note_write",
            "Write or delete files inside a collaborative note directory (`manifest.json`, `structure/*`, `asset/*`) with Loro CRDT merge, optimistic `expectedHash`, and `origin` attribution. Human-owned files automatically divert to review suggestions instead of overwriting. Read `skill://note/<type>` via `skills/get` before editing unfamiliar types.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Note id." },
                    "files": { "type": "array", "items": file_write_item_schema(), "description": "Atomic batch of files to write (mutually exclusive with `path`/`content`/`deletePath`)." },
                    "path": { "type": "string", "description": "Single relative file path (`manifest.json`, `structure/*`, `asset/*`); defaults to the primary entry file when `content` is given." },
                    "content": { "type": "string", "description": "Single-file content to write." },
                    "encoding": { "type": "string", "enum": encoding_enum_json(), "description": "Single-file encoding (`utf8` or `base64`)." },
                    "mime": { "type": "string", "description": "Optional MIME type override for single-file write." },
                    "expectedHash": { "type": "string", "description": "Optional optimistic SHA-256 hash guard for single-file write." },
                    "deletePath": { "type": "string", "description": "Relative `structure/*` or `asset/*` path to delete instead of writing." },
                    "origin": { "type": "string", "description": "Loro CRDT commit attribution origin (e.g. `agent:<id>` from `vv_agent_list`/`vv_agent_register`, `session:<id>:turn:<n>`); defaults to `agent:mcp`." },
                    "summary": { "type": "string", "description": "Short summary recorded in collaborative change history." },
                    "announce": { "type": "boolean", "description": "Whether to announce an update card in the channel." },
                    "createVersion": { "type": "boolean", "description": "When true, cut an immutable snapshot version after writing." },
                    "versionNote": { "type": "string", "description": "Optional note for the snapshot version when `createVersion` is true." }
                },
                "required": ["id"]
            }),
        ),
        tool_def(
            "vv_note_patch",
            "Incrementally patch an existing file in a collaborative note directory using RFC 7396 JSON Merge Patch (`patch`) or targeted UTF-8 text edits (`find`/`replace`, `append`, `prepend`) with automatic read-time `expectedHash` guard, Loro CRDT diff-merge, and `origin` attribution.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Note id." },
                    "path": { "type": "string", "description": "Relative path inside `<storage>/note/<id>/`; omit to patch the primary entry file." },
                    "patch": { "description": "RFC 7396 JSON Merge Patch object or JSON string (for JSON files)." },
                    "find": { "type": "string", "description": "Exact UTF-8 substring to replace (requires `replace`)." },
                    "replace": { "type": "string", "description": "Replacement text when `find` is provided." },
                    "replaceAll": { "type": "boolean", "description": "Replace all occurrences of `find` (default false; errors if multiple matches when false)." },
                    "append": { "type": "string", "description": "Text to append to the file." },
                    "prepend": { "type": "string", "description": "Text to prepend to the file." },
                    "expectedHash": { "type": "string", "description": "Optional explicit SHA-256 hash guard; defaults to the hash observed when reading the file." },
                    "origin": { "type": "string", "description": "Loro CRDT commit attribution origin; defaults to `agent:mcp`." },
                    "summary": { "type": "string", "description": "Short summary recorded in collaborative change history." },
                    "announce": { "type": "boolean", "description": "Whether to announce an update card in the channel." }
                },
                "required": ["id"]
            }),
        ),
        tool_def(
            "vv_note_suggest",
            "List, create, accept, or reject collaborative review suggestions on a note file without silently overwriting human edits.",
            json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "create", "accept", "reject"], "description": "Suggestion action to perform." },
                    "id": { "type": "string", "description": "Note id." },
                    "suggestionId": { "type": "string", "description": "Suggestion id (required for `accept` and `reject`)." },
                    "path": { "type": "string", "description": "Relative file path for `create` (omit to target the primary entry file)." },
                    "baseRev": { "type": "integer", "minimum": 0, "description": "Base note `seq` for `create` (defaults to current server `seq`)." },
                    "baseHash": { "type": "string", "description": "Optional base file SHA-256 hash for `create`." },
                    "content": { "type": "string", "description": "Proposed replacement content for `create`." },
                    "patch": { "description": "Proposed RFC 7396 JSON Merge Patch (object or JSON string) for `create`." },
                    "target": { "type": "string", "description": "Optional node/element/selector target inside the file." },
                    "delete": { "type": "boolean", "description": "Set true on `create` to propose deleting the file or target." },
                    "summary": { "type": "string", "description": "Short rationale or summary for `create`." },
                    "startOffset": { "type": "integer", "minimum": 0, "description": "Optional UTF-16/char start offset for anchored text suggestion." },
                    "endOffset": { "type": "integer", "minimum": 0, "description": "Optional end offset for anchored text suggestion." },
                    "cursorStart": { "type": "string", "description": "Optional encoded Loro start cursor." },
                    "cursorEnd": { "type": "string", "description": "Optional encoded Loro end cursor." }
                },
                "required": ["action", "id"]
            }),
        ),
        tool_def(
            "vv_note_tree_move",
            "Move or reorder a note within the page tree hierarchy (validating against cycles).",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Note id to move." },
                    "parentId": { "type": ["string", "null"], "description": "Target parent note id, or omit/null for root." },
                    "sortOrder": { "type": "integer", "description": "Target sort order among siblings (defaults to 0)." }
                },
                "required": ["id"]
            }),
        ),
        tool_def(
            "vv_note_link_list",
            "List outgoing `[[note:...]]`/`[[issue:...]]` links and incoming backlinks for a note or issue.",
            json!({
                "type": "object",
                "properties": {
                    "entityKind": { "type": "string", "enum": ["note", "issue"], "description": "Entity kind (`note` or `issue`)." },
                    "entityId": { "type": "string", "description": "Note id or issue id/number." }
                },
                "required": ["entityKind", "entityId"]
            }),
        ),
        tool_def(
            "vv_doc_view",
            "Render a `doc` note's structured Block Doc projection (`blocks`, word count, slide count, extracted links).",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Note id of a `doc` note." }
                },
                "required": ["id"]
            }),
        ),
        tool_def(
            "vv_doc_append_block",
            "Append a structured DocBlock object to a `doc` note cleanly via Loro CRDT and refresh extracted backlinks.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Note id of a `doc` note." },
                    "block": { "type": "object", "description": "DocBlock JSON object (`{ id, type, ... }`)." },
                    "afterBlockId": { "type": "string", "description": "Optional existing block id after which to insert." },
                    "origin": { "type": "string", "description": "Optional Loro attribution origin." }
                },
                "required": ["id", "block"]
            }),
        ),
        tool_def(
            "vv_base_view",
            "Compute and read a filtered, sorted, grouped, and summarized Multi-Dimensional Base sheet (`base` note).",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Note id of a `base` note." },
                    "sheetId": { "type": "string", "description": "Optional sheet id." },
                    "viewId": { "type": "string", "description": "Optional view id (`table`, `board`, `gallery`, `timeline`)." }
                },
                "required": ["id"]
            }),
        ),
        tool_def(
            "vv_base_upsert_row",
            "Insert or update a row in a `base` note sheet with typed `BaseCellValue` entries.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Note id of a `base` note." },
                    "sheetId": { "type": "string", "description": "Optional sheet id." },
                    "rowId": { "type": "string", "description": "Optional existing row id to update." },
                    "cells": { "type": "object", "description": "Map of columnId -> `_tag`-tagged `BaseCellValue`." },
                    "origin": { "type": "string", "description": "Optional Loro attribution origin." }
                },
                "required": ["id", "cells"]
            }),
        ),
        tool_def(
            "vv_base_run_agent_column",
            "Execute an Agent Action column across selected rows (or all incomplete rows) of a `base` note sheet.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Note id of a `base` note." },
                    "sheetId": { "type": "string", "description": "Optional sheet id." },
                    "columnId": { "type": "string", "description": "Agent Action column id." },
                    "rowIds": { "type": "array", "items": { "type": "string" }, "description": "Optional row ids to target." },
                    "origin": { "type": "string", "description": "Optional Loro attribution origin." }
                },
                "required": ["id", "columnId"]
            }),
        ),
    ]
}
