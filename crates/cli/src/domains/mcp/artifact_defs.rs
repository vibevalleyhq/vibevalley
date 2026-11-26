//! Argument schemas and MCP tool definitions for `vv_artifact_*`.

use serde::Deserialize;
use serde_json::{Value, json};
use vibevalley_mcp::ToolDef;
use vibevalley_protocol::{ArtifactFileEncoding, ArtifactFileWriteItem, ArtifactType};

use super::tool_def;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ArtifactListArgs {
    #[serde(default, alias = "type")]
    pub(super) artifact_type: Option<ArtifactType>,
    #[serde(default)]
    pub(super) channel: Option<String>,
    #[serde(default)]
    pub(super) issue: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ArtifactGetArgs {
    pub(super) id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ArtifactCreateArgs {
    pub(super) title: String,
    #[serde(alias = "type")]
    pub(super) artifact_type: ArtifactType,
    #[serde(default)]
    pub(super) content: Option<String>,
    #[serde(default)]
    pub(super) files: Option<Vec<ArtifactFileWriteItem>>,
    #[serde(default)]
    pub(super) channel: Option<String>,
    #[serde(default)]
    pub(super) issue: Option<String>,
    #[serde(default)]
    pub(super) note: Option<String>,
    #[serde(default)]
    pub(super) announce: Option<bool>,
    #[serde(default)]
    pub(super) is_default: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ArtifactReadArgs {
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
pub(super) struct ArtifactWriteArgs {
    pub(super) id: String,
    #[serde(default)]
    pub(super) files: Option<Vec<ArtifactFileWriteItem>>,
    #[serde(default)]
    pub(super) path: Option<String>,
    #[serde(default)]
    pub(super) content: Option<String>,
    #[serde(default)]
    pub(super) encoding: Option<ArtifactFileEncoding>,
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
pub(super) struct ArtifactPatchArgs {
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
pub(super) struct ArtifactSuggestArgs {
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

fn artifact_type_enum_json() -> Vec<&'static str> {
    ArtifactType::ALL.into_iter().map(ArtifactType::as_str).collect()
}

fn encoding_enum_json() -> Vec<&'static str> {
    ArtifactFileEncoding::ALL.into_iter().map(ArtifactFileEncoding::as_str).collect()
}

fn file_write_item_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": { "type": "string", "description": "Relative path inside <storage>/artifact/<id>/ (`manifest.json`, `structure/*`, or `asset/*`)." },
            "content": { "type": "string", "description": "UTF-8 text (default) or base64 bytes when encoding is `base64`." },
            "encoding": { "type": "string", "enum": encoding_enum_json(), "description": "Payload encoding (`utf8` or `base64`)." },
            "mime": { "type": "string", "description": "Optional MIME type override." },
            "expectedHash": { "type": "string", "description": "Optional optimistic SHA-256 hash guard (empty string requires absent)." }
        },
        "required": ["path", "content"]
    })
}

pub(super) fn tool_definitions() -> Vec<ToolDef> {
    let type_enum = artifact_type_enum_json();
    vec![
        tool_def(
            "vv_artifact_list",
            "List directory-backed VibeValley artifacts with optional artifactType, channel, or issue filter.",
            json!({
                "type": "object",
                "properties": {
                    "artifactType": { "type": "string", "enum": type_enum, "description": "Optional ArtifactType filter." },
                    "channel": { "type": "string", "description": "Optional channel id or #name filter." },
                    "issue": { "type": "string", "description": "Optional linked issue number (e.g. '12' or '#12') or issue id." }
                }
            }),
        ),
        tool_def(
            "vv_artifact_get",
            "Get full metadata for a VibeValley artifact, including its manifest, structure/asset file listing, immutable versions, open suggestions, and SEP-2640 skill URI.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Artifact id (e.g. 'art_...')." }
                },
                "required": ["id"]
            }),
        ),
        tool_def(
            "vv_artifact_create",
            "Create a directory-backed collaborative artifact of any of the 12 ArtifactTypes. Before authoring content, inspect SEP-2640 skills via `skills/list` and read `skill://artifact/<type>` via `skills/get` (or `resources/read`) for progressive disclosure of that type's `structure/` layout and collaboration conventions.",
            json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Artifact display title (max 200 chars)." },
                    "artifactType": { "type": "string", "enum": type_enum, "description": "One of the 12 canonical ArtifactTypes. Read `skill://artifact/<type>` via `skills/get` first for schema and structure/ conventions." },
                    "content": { "type": "string", "description": "Optional initial UTF-8 content for the type's primary entry file." },
                    "files": { "type": "array", "items": file_write_item_schema(), "description": "Optional initial files (`manifest.json`, `structure/*`, `asset/*`) merged onto the starter skeleton." },
                    "channel": { "type": "string", "description": "Optional channel id or #name to announce in." },
                    "issue": { "type": "string", "description": "Optional linked issue number or id." },
                    "note": { "type": "string", "description": "Optional initial version/announcement note." },
                    "announce": { "type": "boolean", "description": "Whether to announce an artifact card in the target channel." },
                    "isDefault": { "type": "boolean", "description": "Only valid for `design-system`: marks this artifact as the workspace default design system." }
                },
                "required": ["title", "artifactType"]
            }),
        ),
        tool_def(
            "vv_artifact_read",
            "Read an artifact's primary entry file, a specific file inside `<storage>/artifact/<id>/` (e.g. `manifest.json`, `structure/...`, `asset/...`), or list directory files by prefix.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Artifact id." },
                    "path": { "type": "string", "description": "Optional relative path inside `<storage>/artifact/<id>/` (omit to read the type's primary entry file)." },
                    "prefix": { "type": "string", "description": "Optional directory prefix filter (`manifest.json`, `structure/`, or `asset/`) to list files when `path` is omitted." },
                    "version": { "type": "integer", "minimum": 1, "description": "Optional immutable snapshot version number to read from." },
                    "includeFiles": { "type": "boolean", "description": "When true, include the artifact directory file listing alongside the read file." }
                },
                "required": ["id"]
            }),
        ),
        tool_def(
            "vv_artifact_write",
            "Write or delete files inside a collaborative artifact directory (`manifest.json`, `structure/*`, `asset/*`) with Loro CRDT merge, optimistic `expectedHash`, and `origin` attribution. Human-owned files automatically divert to review suggestions instead of overwriting. Read `skill://artifact/<type>` via `skills/get` before editing unfamiliar types.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Artifact id." },
                    "files": { "type": "array", "items": file_write_item_schema(), "description": "Atomic batch of files to write (mutually exclusive with `path`/`content`/`deletePath`)." },
                    "path": { "type": "string", "description": "Single relative file path (`manifest.json`, `structure/*`, `asset/*`); defaults to the primary entry file when `content` is given." },
                    "content": { "type": "string", "description": "Single-file content to write." },
                    "encoding": { "type": "string", "enum": encoding_enum_json(), "description": "Single-file encoding (`utf8` or `base64`)." },
                    "mime": { "type": "string", "description": "Optional MIME type override for single-file write." },
                    "expectedHash": { "type": "string", "description": "Optional optimistic SHA-256 hash guard for single-file write." },
                    "deletePath": { "type": "string", "description": "Relative `structure/*` or `asset/*` path to delete instead of writing." },
                    "origin": { "type": "string", "description": "Loro CRDT commit attribution origin (e.g. `agent:claude`, `session:<id>:turn:<n>`); defaults to `agent:mcp`." },
                    "summary": { "type": "string", "description": "Short summary recorded in collaborative change history." },
                    "announce": { "type": "boolean", "description": "Whether to announce an update card in the channel." },
                    "createVersion": { "type": "boolean", "description": "When true, cut an immutable snapshot version after writing." },
                    "versionNote": { "type": "string", "description": "Optional note for the snapshot version when `createVersion` is true." }
                },
                "required": ["id"]
            }),
        ),
        tool_def(
            "vv_artifact_patch",
            "Incrementally patch an existing file in a collaborative artifact directory using RFC 7396 JSON Merge Patch (`patch`) or targeted UTF-8 text edits (`find`/`replace`, `append`, `prepend`) with automatic read-time `expectedHash` guard, Loro CRDT diff-merge, and `origin` attribution.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Artifact id." },
                    "path": { "type": "string", "description": "Relative path inside `<storage>/artifact/<id>/`; omit to patch the primary entry file." },
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
            "vv_artifact_suggest",
            "List, create, accept, or reject collaborative review suggestions on an artifact file without silently overwriting human edits.",
            json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "create", "accept", "reject"], "description": "Suggestion action to perform." },
                    "id": { "type": "string", "description": "Artifact id." },
                    "suggestionId": { "type": "string", "description": "Suggestion id (required for `accept` and `reject`)." },
                    "path": { "type": "string", "description": "Relative file path for `create` (omit to target the primary entry file)." },
                    "baseRev": { "type": "integer", "minimum": 0, "description": "Base artifact `seq` for `create` (defaults to current server `seq`)." },
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
    ]
}
