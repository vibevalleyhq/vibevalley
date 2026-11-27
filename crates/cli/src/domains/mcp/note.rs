//! `vv_note_*`, `vv_doc_*`, and `vv_base_*` collaborative note MCP tool handlers.

use serde_json::{Value, json};
use vibevalley_core::note::{apply_json_merge_patch, type_spec, validate_deletable_path, validate_note_path, validate_prefix};
use vibevalley_mcp::ToolCallResult;
use vibevalley_protocol::{
    BaseRunAgentColumnRequest, BaseUpsertRowRequest, BaseViewRequest, LinkEntityKind, NoteDocAppendBlockRequest, NoteDocViewRequest, NoteFileDeleteRequest,
    NoteFileEncoding, NoteFileGetRequest, NoteFileListRequest, NoteFileWriteItem, NoteFileWriteRequest, NoteGetInput, NoteLinkListRequest, NoteListRequest,
    NoteRequest, NoteSuggestionAcceptInput, NoteSuggestionCreateInput, NoteSuggestionListInput, NoteTreeMoveRequest, NoteVersionRequest, SuggestionChange,
    SuggestionStatus, ops,
};

use super::note_defs::{
    BaseRunAgentColumnArgs, BaseUpsertRowArgs, BaseViewArgs, DocAppendBlockArgs, DocViewArgs, NoteGetArgs, NoteLinkListArgs, NoteListArgs, NotePatchArgs,
    NoteReadArgs, NoteSuggestArgs, NoteTreeMoveArgs, NoteWriteArgs, SuggestAction,
};
pub(super) use super::note_defs::{NoteCreateArgs, tool_definitions};
use super::{McpServer, format_failure, non_empty_trimmed, redact_result};
use crate::client::Client;
use crate::output::issue_ref;

const DEFAULT_MCP_ORIGIN: &str = "agent:mcp";

fn encode_patch_value(raw: Value) -> Result<String, ToolCallResult> {
    match raw {
        Value::String(s) => Ok(s),
        other => serde_json::to_string(&other).map_err(|err| ToolCallResult::error(format!("invalid JSON merge patch: {err}"))),
    }
}

fn resolve_origin(raw: Option<String>) -> Option<String> {
    Some(non_empty_trimmed(raw).unwrap_or_else(|| DEFAULT_MCP_ORIGIN.to_owned()))
}

async fn resolve_entry_path(client: &Client, id: &str) -> Result<(vibevalley_protocol::Note, String), ToolCallResult> {
    match client.ask::<ops::NoteGet>(&NoteGetInput { id: id.to_owned() }).await {
        Ok(note) => {
            let entry = type_spec(note.note_type).entry_path.to_owned();
            Ok((note, entry))
        }
        Err(failure) => Err(ToolCallResult::error(format_failure(&failure))),
    }
}

fn apply_patch_body(target_path: &str, current_content: &str, patch_str: Option<String>, args: &NotePatchArgs) -> Result<String, ToolCallResult> {
    if let Some(patch_raw) = patch_str {
        return apply_json_merge_patch(Some(current_content), &patch_raw)
            .map_err(|err| ToolCallResult::error(format!("vv_note_patch JSON merge patch failed: {err}")));
    }
    let mut body = current_content.to_owned();
    if let (Some(find), Some(replace)) = (args.find.as_deref(), args.replace.as_deref()) {
        let matches = body.matches(find).count();
        if matches == 0 {
            return Err(ToolCallResult::error(format!("vv_note_patch: 'find' text not found in '{target_path}'")));
        }
        if matches > 1 && !args.replace_all.unwrap_or(false) {
            return Err(ToolCallResult::error(format!(
                "vv_note_patch: 'find' matched {matches} times in '{target_path}'; pass replaceAll=true or a more specific snippet"
            )));
        }
        body = if args.replace_all.unwrap_or(false) {
            body.replace(find, replace)
        } else {
            body.replacen(find, replace, 1)
        };
    }
    if let Some(pre) = args.prepend.as_deref() {
        body = format!("{pre}{body}");
    }
    if let Some(app) = args.append.as_deref() {
        body.push_str(app);
    }
    Ok(body)
}

impl McpServer {
    pub(super) async fn tool_note_list(&self, raw_args: Value) -> ToolCallResult {
        let args: NoteListArgs = match Self::decode_args("vv_note_list", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let req = NoteListRequest {
            channel: non_empty_trimmed(args.channel),
            issue: non_empty_trimmed(args.issue).map(|i| issue_ref(&i)),
            note_type: args.note_type,
            parent_id: non_empty_trimmed(args.parent_id),
        };
        self.refresh_client().await;
        let client = self.client.read().await;
        let result = match client.ask::<ops::NoteList>(&req).await {
            Ok(notes) => ToolCallResult::json(&json!({
                "count": notes.len(),
                "notes": notes,
            })),
            Err(failure) => ToolCallResult::error(format_failure(&failure)),
        };
        redact_result(result, &Self::known_secrets(&client, None))
    }

    pub(super) async fn tool_note_get(&self, raw_args: Value) -> ToolCallResult {
        let args: NoteGetArgs = match Self::decode_args("vv_note_get", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let id = args.id.trim().to_string();
        if id.is_empty() {
            return ToolCallResult::error("vv_note_get requires a non-empty id");
        }
        self.refresh_client().await;
        let client = self.client.read().await;
        let note_in = NoteGetInput { id: id.clone() };
        let files_in = NoteFileListRequest { id: id.clone(), prefix: None };
        let sug_in = NoteSuggestionListInput { id: id.clone() };
        let (note_res, files_res, sug_res) = tokio::join!(
            client.ask::<ops::NoteGet>(&note_in),
            client.ask::<ops::NoteFileList>(&files_in),
            client.ask::<ops::NoteSuggestionList>(&sug_in),
        );

        let result = match note_res {
            Err(failure) => ToolCallResult::error(format_failure(&failure)),
            Ok(note) => {
                let files = match files_res {
                    Ok(list) => list.files,
                    Err(failure) => return redact_result(ToolCallResult::error(format_failure(&failure)), &Self::known_secrets(&client, None)),
                };
                let suggestions = match sug_res {
                    Ok(list) => list,
                    Err(failure) => return redact_result(ToolCallResult::error(format_failure(&failure)), &Self::known_secrets(&client, None)),
                };
                let manifest: Option<Value> = if files.iter().any(|f| f.path == "manifest.json") {
                    client
                        .ask::<ops::NoteFileGet>(&NoteFileGetRequest {
                            id: id.clone(),
                            path: "manifest.json".to_owned(),
                            version: None,
                        })
                        .await
                        .ok()
                        .and_then(|f| serde_json::from_str::<Value>(&f.content).ok())
                } else {
                    None
                };
                let open_suggestions: Vec<_> = suggestions.iter().filter(|s| s.status == SuggestionStatus::Open).cloned().collect();
                let mut payload = json!({
                    "note": note,
                    "skillUri": format!("skill://note/{}", note.note_type.as_str()),
                    "files": files,
                    "versions": note.versions,
                    "openSuggestions": open_suggestions,
                    "suggestions": suggestions,
                });
                if let Some(m) = manifest {
                    payload["manifest"] = m;
                }
                ToolCallResult::json(&payload)
            }
        };
        redact_result(result, &Self::known_secrets(&client, None))
    }

    pub(super) async fn tool_note_create(&self, raw_args: Value) -> ToolCallResult {
        let args: NoteCreateArgs = match Self::decode_args("vv_note_create", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let title = args.title.trim().to_string();
        if title.is_empty() {
            return ToolCallResult::error("vv_note_create requires a non-empty title");
        }
        if let Some(files) = &args.files {
            if files.is_empty() {
                return ToolCallResult::error("vv_note_create: files array must not be empty when provided");
            }
            for item in files {
                if let Err(err) = validate_note_path(item.path.trim()) {
                    return ToolCallResult::error(format!("vv_note_create invalid path '{}': {err}", item.path));
                }
            }
        }
        let req = NoteRequest {
            title,
            note_type: args.note_type,
            parent_id: non_empty_trimmed(args.parent_id),
            sort_order: args.sort_order,
            content: args.content,
            files: args.files,
            announce: args.announce,
            note: non_empty_trimmed(args.note),
            channel: non_empty_trimmed(args.channel),
            issue: non_empty_trimmed(args.issue).map(|i| issue_ref(&i)),
        };
        self.refresh_client().await;
        let client = self.client.read().await;
        let result = match client.ask::<ops::NoteCreate>(&req).await {
            Ok(created) => ToolCallResult::json(&created),
            Err(failure) => ToolCallResult::error(format_failure(&failure)),
        };
        redact_result(result, &Self::known_secrets(&client, None))
    }

    pub(super) async fn tool_note_read(&self, raw_args: Value) -> ToolCallResult {
        let args: NoteReadArgs = match Self::decode_args("vv_note_read", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let id = args.id.trim().to_string();
        if id.is_empty() {
            return ToolCallResult::error("vv_note_read requires a non-empty id");
        }
        let path = non_empty_trimmed(args.path);
        let prefix = non_empty_trimmed(args.prefix);
        if path.is_some() && prefix.is_some() {
            return ToolCallResult::error("vv_note_read: pass either 'path' or 'prefix', not both");
        }
        if let Some(ref p) = path
            && let Err(err) = validate_note_path(p)
        {
            return ToolCallResult::error(format!("vv_note_read invalid path '{p}': {err}"));
        }
        if let Some(ref pfx) = prefix
            && let Err(err) = validate_prefix(pfx)
        {
            return ToolCallResult::error(format!("vv_note_read invalid prefix '{pfx}': {err}"));
        }

        self.refresh_client().await;
        let client = self.client.read().await;
        let result = if let Some(pfx) = prefix {
            match client.ask::<ops::NoteFileList>(&NoteFileListRequest { id, prefix: Some(pfx) }).await {
                Ok(listing) => ToolCallResult::json(&listing),
                Err(failure) => ToolCallResult::error(format_failure(&failure)),
            }
        } else {
            let (target_path, note_meta) = match path {
                Some(p) => (p, None),
                None => match resolve_entry_path(&client, &id).await {
                    Ok((note, entry)) => (entry, Some(note)),
                    Err(err_res) => return redact_result(err_res, &Self::known_secrets(&client, None)),
                },
            };
            match client
                .ask::<ops::NoteFileGet>(&NoteFileGetRequest {
                    id: id.clone(),
                    path: target_path,
                    version: args.version,
                })
                .await
            {
                Ok(file) => {
                    let mut out = serde_json::to_value(&file).unwrap_or_else(|_| json!({}));
                    if let Some(note) = note_meta {
                        out["noteType"] = json!(note.note_type);
                        out["seq"] = json!(note.seq);
                        out["version"] = json!(args.version.unwrap_or(note.version));
                    }
                    if args.include_files == Some(true)
                        && let Ok(listing) = client.ask::<ops::NoteFileList>(&NoteFileListRequest { id, prefix: None }).await
                    {
                        out["files"] = json!(listing.files);
                        out["seq"] = json!(listing.seq);
                    }
                    ToolCallResult::json(&out)
                }
                Err(failure) => ToolCallResult::error(format_failure(&failure)),
            }
        };
        redact_result(result, &Self::known_secrets(&client, None))
    }

    pub(super) async fn tool_note_write(&self, raw_args: Value) -> ToolCallResult {
        let args: NoteWriteArgs = match Self::decode_args("vv_note_write", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let id = args.id.trim().to_string();
        if id.is_empty() {
            return ToolCallResult::error("vv_note_write requires a non-empty id");
        }
        let origin = resolve_origin(args.origin);
        let summary = non_empty_trimmed(args.summary);

        let single_path = non_empty_trimmed(args.path);
        if let Some(delete_path) = non_empty_trimmed(args.delete_path) {
            if args.files.is_some() || args.content.is_some() || single_path.is_some() {
                return ToolCallResult::error("vv_note_write: 'deletePath' cannot be combined with 'files', 'path', or 'content'");
            }
            if let Err(err) = validate_deletable_path(&delete_path) {
                return ToolCallResult::error(format!("vv_note_write invalid deletePath '{delete_path}': {err}"));
            }
            self.refresh_client().await;
            let client = self.client.read().await;
            let req = NoteFileDeleteRequest {
                id,
                path: delete_path,
                origin,
                summary,
            };
            let result = match client.ask::<ops::NoteFileDelete>(&req).await {
                Ok(deleted) => ToolCallResult::json(&deleted),
                Err(failure) => ToolCallResult::error(format_failure(&failure)),
            };
            return redact_result(result, &Self::known_secrets(&client, None));
        }

        if args.files.is_some() && (args.content.is_some() || single_path.is_some()) {
            return ToolCallResult::error("vv_note_write: pass either 'files' or single-file 'content'/'path', not both");
        }

        self.refresh_client().await;
        let client = self.client.read().await;
        let files = if let Some(items) = args.files {
            if items.is_empty() {
                return ToolCallResult::error("vv_note_write requires at least one file in 'files'");
            }
            for item in &items {
                if let Err(err) = validate_note_path(item.path.trim()) {
                    return ToolCallResult::error(format!("vv_note_write invalid path '{}': {err}", item.path));
                }
            }
            items
        } else if let Some(content) = args.content {
            let target_path = match single_path {
                Some(p) => {
                    if let Err(err) = validate_note_path(&p) {
                        return ToolCallResult::error(format!("vv_note_write invalid path '{p}': {err}"));
                    }
                    p
                }
                None => match resolve_entry_path(&client, &id).await {
                    Ok((_, entry)) => entry,
                    Err(err_res) => return redact_result(err_res, &Self::known_secrets(&client, None)),
                },
            };
            vec![NoteFileWriteItem {
                path: target_path,
                content,
                encoding: args.encoding,
                mime: non_empty_trimmed(args.mime),
                expected_hash: args.expected_hash,
            }]
        } else {
            return ToolCallResult::error("vv_note_write requires 'files', 'content', or 'deletePath'");
        };

        let req = NoteFileWriteRequest {
            id: id.clone(),
            files,
            origin,
            summary: summary.clone(),
            announce: args.announce,
        };
        let result = match client.ask::<ops::NoteFileWrite>(&req).await {
            Ok(written) => {
                if args.create_version == Some(true) {
                    let ver_req = NoteVersionRequest {
                        id,
                        content: None,
                        note: non_empty_trimmed(args.version_note).or(summary),
                    };
                    match client.ask::<ops::NoteVersionCreate>(&ver_req).await {
                        Ok(note) => ToolCallResult::json(&json!({
                            "write": written,
                            "note": note,
                        })),
                        Err(failure) => ToolCallResult::error(format_failure(&failure)),
                    }
                } else {
                    ToolCallResult::json(&written)
                }
            }
            Err(failure) => ToolCallResult::error(format_failure(&failure)),
        };
        redact_result(result, &Self::known_secrets(&client, None))
    }

    pub(super) async fn tool_note_patch(&self, raw_args: Value) -> ToolCallResult {
        let args: NotePatchArgs = match Self::decode_args("vv_note_patch", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let id = args.id.trim().to_string();
        if id.is_empty() {
            return ToolCallResult::error("vv_note_patch requires a non-empty id");
        }
        let has_patch = args.patch.is_some();
        let has_text_edit = args.find.is_some() || args.append.is_some() || args.prepend.is_some();
        if !has_patch && !has_text_edit {
            return ToolCallResult::error("vv_note_patch requires 'patch' or at least one of 'find'/'replace', 'append', 'prepend'");
        }
        if has_patch && has_text_edit {
            return ToolCallResult::error("vv_note_patch: 'patch' cannot be combined with 'find', 'append', or 'prepend'");
        }
        if let Some(ref find) = args.find {
            if find.is_empty() {
                return ToolCallResult::error("vv_note_patch: 'find' must not be empty");
            }
            if args.replace.is_none() {
                return ToolCallResult::error("vv_note_patch: 'find' requires 'replace'");
            }
        }
        let patch_str = match args.patch.clone() {
            Some(v) => match encode_patch_value(v) {
                Ok(s) => Some(s),
                Err(err_res) => return err_res,
            },
            None => None,
        };
        let explicit_path = non_empty_trimmed(args.path.clone());
        if let Some(ref p) = explicit_path
            && let Err(err) = validate_note_path(p)
        {
            return ToolCallResult::error(format!("vv_note_patch invalid path '{p}': {err}"));
        }

        self.refresh_client().await;
        let client = self.client.read().await;
        let target_path = match explicit_path {
            Some(p) => p,
            None => match resolve_entry_path(&client, &id).await {
                Ok((_, entry)) => entry,
                Err(err_res) => return redact_result(err_res, &Self::known_secrets(&client, None)),
            },
        };

        let current = match client
            .ask::<ops::NoteFileGet>(&NoteFileGetRequest {
                id: id.clone(),
                path: target_path.clone(),
                version: None,
            })
            .await
        {
            Ok(file) => file,
            Err(failure) => return redact_result(ToolCallResult::error(format_failure(&failure)), &Self::known_secrets(&client, None)),
        };

        if current.encoding != NoteFileEncoding::Utf8 {
            return redact_result(
                ToolCallResult::error(format!("vv_note_patch only supports UTF-8 text files ('{target_path}' is base64)")),
                &Self::known_secrets(&client, None),
            );
        }
        if let Some(ref expected) = args.expected_hash
            && *expected != current.hash
        {
            return redact_result(
                ToolCallResult::error(format!(
                    "vv_note_patch: '{target_path}' changed concurrently (expected hash {expected}, current {})",
                    current.hash
                )),
                &Self::known_secrets(&client, None),
            );
        }

        let updated_content = match apply_patch_body(&target_path, &current.content, patch_str, &args) {
            Ok(body) => body,
            Err(err_res) => return redact_result(err_res, &Self::known_secrets(&client, None)),
        };

        let write_req = NoteFileWriteRequest {
            id,
            files: vec![NoteFileWriteItem {
                path: target_path,
                content: updated_content,
                encoding: Some(NoteFileEncoding::Utf8),
                mime: Some(current.mime),
                expected_hash: Some(args.expected_hash.unwrap_or(current.hash)),
            }],
            origin: resolve_origin(args.origin),
            summary: non_empty_trimmed(args.summary),
            announce: args.announce,
        };
        let result = match client.ask::<ops::NoteFileWrite>(&write_req).await {
            Ok(written) => ToolCallResult::json(&written),
            Err(failure) => ToolCallResult::error(format_failure(&failure)),
        };
        redact_result(result, &Self::known_secrets(&client, None))
    }

    pub(super) async fn tool_note_suggest(&self, raw_args: Value) -> ToolCallResult {
        let args: NoteSuggestArgs = match Self::decode_args("vv_note_suggest", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let id = args.id.trim().to_string();
        if id.is_empty() {
            return ToolCallResult::error("vv_note_suggest requires a non-empty id");
        }

        self.refresh_client().await;
        let client = self.client.read().await;
        let result = match args.action {
            SuggestAction::List => match client.ask::<ops::NoteSuggestionList>(&NoteSuggestionListInput { id }).await {
                Ok(list) => {
                    let open_count = list.iter().filter(|s| s.status == SuggestionStatus::Open).count();
                    ToolCallResult::json(&json!({
                        "count": list.len(),
                        "openCount": open_count,
                        "suggestions": list,
                    }))
                }
                Err(failure) => ToolCallResult::error(format_failure(&failure)),
            },
            SuggestAction::Accept | SuggestAction::Reject => {
                let Some(suggestion) = non_empty_trimmed(args.suggestion_id) else {
                    return ToolCallResult::error("vv_note_suggest accept/reject requires a non-empty suggestionId");
                };
                let req = NoteSuggestionAcceptInput { id, suggestion };
                let res = match args.action {
                    SuggestAction::Accept => client.ask::<ops::NoteSuggestionAccept>(&req).await,
                    SuggestAction::Reject => client.ask::<ops::NoteSuggestionReject>(&req).await,
                    SuggestAction::List | SuggestAction::Create => unreachable!(),
                };
                match res {
                    Ok(updated) => ToolCallResult::json(&updated),
                    Err(failure) => ToolCallResult::error(format_failure(&failure)),
                }
            }
            SuggestAction::Create => {
                let patch = match args.patch {
                    Some(v) => match encode_patch_value(v) {
                        Ok(s) => Some(s),
                        Err(err_res) => return redact_result(err_res, &Self::known_secrets(&client, None)),
                    },
                    None => None,
                };
                let is_delete = args.delete == Some(true);
                if args.content.is_none() && patch.is_none() && !is_delete {
                    return ToolCallResult::error("vv_note_suggest create requires 'content', 'patch', or 'delete: true'");
                }
                let explicit_path = non_empty_trimmed(args.path);
                if let Some(ref p) = explicit_path
                    && let Err(err) = validate_note_path(p)
                {
                    return ToolCallResult::error(format!("vv_note_suggest invalid path '{p}': {err}"));
                }
                let (target_path, resolved_rev) = match (explicit_path, args.base_rev) {
                    (Some(p), Some(rev)) => (p, rev),
                    (opt_p, opt_rev) => match resolve_entry_path(&client, &id).await {
                        Ok((note, entry)) => (opt_p.unwrap_or(entry), opt_rev.unwrap_or(note.seq)),
                        Err(err_res) => return redact_result(err_res, &Self::known_secrets(&client, None)),
                    },
                };
                let req = NoteSuggestionCreateInput {
                    id,
                    path: target_path,
                    base_rev: resolved_rev,
                    base_hash: non_empty_trimmed(args.base_hash),
                    change: SuggestionChange {
                        content: args.content,
                        patch,
                        target: non_empty_trimmed(args.target),
                        delete: is_delete.then_some(true),
                        summary: non_empty_trimmed(args.summary),
                    },
                    cursor_start: non_empty_trimmed(args.cursor_start),
                    cursor_end: non_empty_trimmed(args.cursor_end),
                    start_offset: args.start_offset,
                    end_offset: args.end_offset,
                };
                match client.ask::<ops::NoteSuggestionCreate>(&req).await {
                    Ok(created) => ToolCallResult::json(&created),
                    Err(failure) => ToolCallResult::error(format_failure(&failure)),
                }
            }
        };
        redact_result(result, &Self::known_secrets(&client, None))
    }

    pub(super) async fn tool_note_tree_move(&self, raw_args: Value) -> ToolCallResult {
        let args: NoteTreeMoveArgs = match Self::decode_args("vv_note_tree_move", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let id = args.id.trim().to_string();
        if id.is_empty() {
            return ToolCallResult::error("vv_note_tree_move requires a non-empty id");
        }
        let req = NoteTreeMoveRequest {
            id,
            parent_id: non_empty_trimmed(args.parent_id),
            sort_order: args.sort_order.unwrap_or(0),
        };
        self.refresh_client().await;
        let client = self.client.read().await;
        let result = match client.ask::<ops::NoteTreeMove>(&req).await {
            Ok(moved) => ToolCallResult::json(&moved),
            Err(failure) => ToolCallResult::error(format_failure(&failure)),
        };
        redact_result(result, &Self::known_secrets(&client, None))
    }

    pub(super) async fn tool_note_link_list(&self, raw_args: Value) -> ToolCallResult {
        let args: NoteLinkListArgs = match Self::decode_args("vv_note_link_list", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let raw_id = args.entity_id.trim().to_string();
        if raw_id.is_empty() {
            return ToolCallResult::error("vv_note_link_list requires a non-empty entityId");
        }
        let entity_id = if matches!(args.entity_kind, LinkEntityKind::Issue) {
            issue_ref(&raw_id)
        } else {
            raw_id
        };
        let req = NoteLinkListRequest {
            entity_kind: args.entity_kind,
            entity_id,
        };
        self.refresh_client().await;
        let client = self.client.read().await;
        let result = match client.ask::<ops::NoteLinkList>(&req).await {
            Ok(links) => ToolCallResult::json(&links),
            Err(failure) => ToolCallResult::error(format_failure(&failure)),
        };
        redact_result(result, &Self::known_secrets(&client, None))
    }

    pub(super) async fn tool_doc_view(&self, raw_args: Value) -> ToolCallResult {
        let args: DocViewArgs = match Self::decode_args("vv_doc_view", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let id = args.id.trim().to_string();
        if id.is_empty() {
            return ToolCallResult::error("vv_doc_view requires a non-empty id");
        }
        self.refresh_client().await;
        let client = self.client.read().await;
        let result = match client.ask::<ops::NoteDocView>(&NoteDocViewRequest { id }).await {
            Ok(view) => ToolCallResult::json(&view),
            Err(failure) => ToolCallResult::error(format_failure(&failure)),
        };
        redact_result(result, &Self::known_secrets(&client, None))
    }

    pub(super) async fn tool_doc_append_block(&self, raw_args: Value) -> ToolCallResult {
        let args: DocAppendBlockArgs = match Self::decode_args("vv_doc_append_block", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let id = args.id.trim().to_string();
        if id.is_empty() {
            return ToolCallResult::error("vv_doc_append_block requires a non-empty id");
        }
        let req = NoteDocAppendBlockRequest {
            id,
            block: args.block,
            after_block_id: non_empty_trimmed(args.after_block_id),
            origin: resolve_origin(args.origin),
        };
        self.refresh_client().await;
        let client = self.client.read().await;
        let result = match client.ask::<ops::NoteDocAppendBlock>(&req).await {
            Ok(view) => ToolCallResult::json(&view),
            Err(failure) => ToolCallResult::error(format_failure(&failure)),
        };
        redact_result(result, &Self::known_secrets(&client, None))
    }

    pub(super) async fn tool_base_view(&self, raw_args: Value) -> ToolCallResult {
        let args: BaseViewArgs = match Self::decode_args("vv_base_view", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let id = args.id.trim().to_string();
        if id.is_empty() {
            return ToolCallResult::error("vv_base_view requires a non-empty id");
        }
        let req = BaseViewRequest {
            id,
            sheet_id: non_empty_trimmed(args.sheet_id),
            view_id: non_empty_trimmed(args.view_id),
        };
        self.refresh_client().await;
        let client = self.client.read().await;
        let result = match client.ask::<ops::NoteBaseView>(&req).await {
            Ok(snap) => ToolCallResult::json(&snap),
            Err(failure) => ToolCallResult::error(format_failure(&failure)),
        };
        redact_result(result, &Self::known_secrets(&client, None))
    }

    pub(super) async fn tool_base_upsert_row(&self, raw_args: Value) -> ToolCallResult {
        let args: BaseUpsertRowArgs = match Self::decode_args("vv_base_upsert_row", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let id = args.id.trim().to_string();
        if id.is_empty() {
            return ToolCallResult::error("vv_base_upsert_row requires a non-empty id");
        }
        let req = BaseUpsertRowRequest {
            id,
            sheet_id: non_empty_trimmed(args.sheet_id),
            row_id: non_empty_trimmed(args.row_id),
            cells: args.cells,
            origin: resolve_origin(args.origin),
        };
        self.refresh_client().await;
        let client = self.client.read().await;
        let result = match client.ask::<ops::NoteBaseUpsertRow>(&req).await {
            Ok(snap) => ToolCallResult::json(&snap),
            Err(failure) => ToolCallResult::error(format_failure(&failure)),
        };
        redact_result(result, &Self::known_secrets(&client, None))
    }

    pub(super) async fn tool_base_run_agent_column(&self, raw_args: Value) -> ToolCallResult {
        let args: BaseRunAgentColumnArgs = match Self::decode_args("vv_base_run_agent_column", raw_args) {
            Ok(a) => a,
            Err(res) => return res,
        };
        let id = args.id.trim().to_string();
        if id.is_empty() {
            return ToolCallResult::error("vv_base_run_agent_column requires a non-empty id");
        }
        let column_id = args.column_id.trim().to_string();
        if column_id.is_empty() {
            return ToolCallResult::error("vv_base_run_agent_column requires a non-empty columnId");
        }
        let req = BaseRunAgentColumnRequest {
            id,
            sheet_id: non_empty_trimmed(args.sheet_id),
            column_id,
            row_ids: args.row_ids,
            origin: resolve_origin(args.origin),
        };
        self.refresh_client().await;
        let client = self.client.read().await;
        let result = match client.ask::<ops::NoteBaseRunAgentColumn>(&req).await {
            Ok(res) => ToolCallResult::json(&res),
            Err(failure) => ToolCallResult::error(format_failure(&failure)),
        };
        redact_result(result, &Self::known_secrets(&client, None))
    }
}
