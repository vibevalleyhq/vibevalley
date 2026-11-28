//! Read-only trajectory inspector across IssueSession, WorkspaceChat, and
//! Orchestrator trajectories, joining SQLite `session_event` rows, live
//! DB/`LiveState` state, and on-disk `oar-voyage/3` JSONL records.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::BufReader;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Value, json};
use vibevalley_protocol::{
    ApiError, BizCode, DebugTrajectoryDetail, DebugTrajectoryExportRequest, DebugTrajectoryExportResult, DebugTrajectoryGetRequest, DebugTrajectoryKind,
    DebugTrajectoryRawEntry, DebugTrajectorySubagentNode, DebugTrajectorySummary, DebugTrajectoryTurn, EventTokens, Issue, ORCHESTRATOR_RUNTIME, Phase,
    Session, SessionController, SessionEvent, SessionEventType, SessionSubagents, SubagentStatus,
};
use vibevalley_runtime::agent::durable::{Store, Task, TaskStatus};
use vibevalley_runtime::agent::eval::{EvalProfile, ReplaySpec};
use vibevalley_runtime::oar::voyage::{Header as VoyageHeader, Kind as VoyageKind, Reader as VoyageReader, Record as VoyageRecord};
use vibevalley_runtime::oar::{EventKind as OarEventKind, StopReason};

use super::collector::clip_utf8;
use super::redact::{Redactor, contains_ascii_ci};
use super::types::DebugDataSource;
use crate::runtime::session::journal::event_tokens_of;

const RAW_PAYLOAD_MAX_BYTES: usize = 4096;
const SILENT_ERROR_MARKERS: [&str; 6] = [
    "QUOTA_EXHAUSTED",
    "INVALID_THINKING_SIGNATURE",
    "RESOURCE_EXHAUSTED",
    "RATE_LIMIT_EXCEEDED",
    "OVERLOADED_ERROR",
    "CONTEXT_LENGTH_EXCEEDED",
];

/// Minimal per-session metadata extracted under a brief `state snapshot` lock so
/// disk/JSONL and SQLite I/O run strictly outside the snapshot lock.
#[derive(Debug, Clone, Default)]
pub(crate) struct SessionStateMeta {
    pub exists: bool,
    pub is_orchestrator: bool,
    pub is_issue_session: bool,
    pub in_issue_history: bool,
    pub runtime: Option<String>,
    pub status: Option<&'static str>,
    pub updated_at: i64,
    pub title: Option<String>,
    pub subagents: Option<SessionSubagents>,
}

#[derive(Debug, Default)]
pub(crate) struct StateTrajectoryIndex {
    pub sessions: HashMap<String, SessionStateMeta>,
    pub known_ids: BTreeSet<String>,
}

pub(crate) fn is_safe_id(id: &str) -> bool {
    !id.is_empty() && !id.contains('/') && !id.contains('\\') && !id.contains("..") && id != "."
}

pub(crate) fn phase_status_str(phase: &Phase) -> &'static str {
    match phase {
        Phase::Working(_) => "working",
        Phase::Done(_) => "done",
        Phase::Failed(_) => "failed",
        Phase::Resting(_) => "resting",
        Phase::Closed(_) => "closed",
    }
}

pub(crate) fn classify_live_session(session: &Session, orchestrator_ids: &[String], in_issue_history: bool) -> DebugTrajectoryKind {
    if session.is_orchestrator() || session.controller == SessionController::Daemon || orchestrator_ids.iter().any(|o| o == &session.id) {
        return DebugTrajectoryKind::Orchestrator;
    }
    if session.is_board_worker() || session.issue_id().is_some() || in_issue_history {
        return DebugTrajectoryKind::IssueSession;
    }
    DebugTrajectoryKind::WorkspaceChat
}

fn classify_meta(id: &str, meta: Option<&SessionStateMeta>, orchestrator_ids: &[String], voyage_header: Option<&VoyageHeader>) -> DebugTrajectoryKind {
    if meta.is_some_and(|m| m.is_orchestrator) || orchestrator_ids.iter().any(|o| o == id) || voyage_header.is_some_and(|h| h.runtime == ORCHESTRATOR_RUNTIME) {
        return DebugTrajectoryKind::Orchestrator;
    }
    if meta.is_some_and(|m| m.is_issue_session || m.in_issue_history) {
        return DebugTrajectoryKind::IssueSession;
    }
    DebugTrajectoryKind::WorkspaceChat
}

pub(crate) fn extract_session_meta(issues: &[Issue], sessions: &[Session], id: &str) -> Option<SessionStateMeta> {
    let session = sessions.iter().find(|s| s.id == id);
    let exec_issue = issues.iter().find(|i| i.executions().any(|e| e.session() == id));
    if session.is_none() && exec_issue.is_none() {
        return None;
    }
    let title = if let Some(s) = session {
        if let Some(issue_id) = s.issue_id()
            && let Some(issue) = issues.iter().find(|i| i.id == issue_id)
        {
            Some(format!("#{} {}", issue.number, issue.title))
        } else if !s.name.trim().is_empty() {
            Some(s.name.clone())
        } else {
            exec_issue.map(|i| format!("#{} {}", i.number, i.title))
        }
    } else {
        exec_issue.map(|i| format!("#{} {}", i.number, i.title))
    };
    Some(SessionStateMeta {
        exists: session.is_some(),
        is_orchestrator: session.is_some_and(|s| s.is_orchestrator() || s.controller == SessionController::Daemon),
        is_issue_session: session.is_some_and(|s| s.is_board_worker() || s.issue_id().is_some()),
        in_issue_history: exec_issue.is_some(),
        runtime: session.map(|s| s.runtime.clone()),
        status: session.map(|s| phase_status_str(&s.phase)),
        updated_at: session.map(|s| s.last_run.as_ref().map_or(s.hired_at, |r| r.at.max(s.hired_at))).unwrap_or(0),
        title,
        subagents: session.and_then(|s| s.subagents.clone()),
    })
}

pub(crate) fn extract_trajectory_index(issues: &[Issue], sessions: &[Session]) -> StateTrajectoryIndex {
    let mut index = StateTrajectoryIndex::default();
    let issue_by_id: HashMap<&str, (i64, &str)> = issues.iter().map(|i| (i.id.as_str(), (i.number, i.title.as_str()))).collect();
    let mut exec_issue: HashMap<&str, (i64, &str)> = HashMap::new();
    for issue in issues {
        for exec in issue.executions() {
            let sid = exec.session();
            exec_issue.entry(sid).or_insert((issue.number, issue.title.as_str()));
            index.known_ids.insert(sid.to_string());
        }
    }

    for s in sessions {
        index.known_ids.insert(s.id.clone());
        let linked_exec = exec_issue.get(s.id.as_str()).copied();
        let title = if let Some(issue_id) = s.issue_id()
            && let Some((num, t)) = issue_by_id.get(issue_id).copied()
        {
            Some(format!("#{num} {t}"))
        } else if !s.name.trim().is_empty() {
            Some(s.name.clone())
        } else {
            linked_exec.map(|(num, t)| format!("#{num} {t}"))
        };
        index.sessions.insert(
            s.id.clone(),
            SessionStateMeta {
                exists: true,
                is_orchestrator: s.is_orchestrator() || s.controller == SessionController::Daemon,
                is_issue_session: s.is_board_worker() || s.issue_id().is_some(),
                in_issue_history: linked_exec.is_some(),
                runtime: Some(s.runtime.clone()),
                status: Some(phase_status_str(&s.phase)),
                updated_at: s.last_run.as_ref().map_or(s.hired_at, |r| r.at.max(s.hired_at)),
                title,
                subagents: s.subagents.clone(),
            },
        );
    }

    for (sid, (num, t)) in exec_issue {
        index.sessions.entry(sid.to_string()).or_insert_with(|| SessionStateMeta {
            exists: false,
            is_orchestrator: false,
            is_issue_session: false,
            in_issue_history: true,
            runtime: None,
            status: None,
            updated_at: 0,
            title: Some(format!("#{num} {t}")),
            subagents: None,
        });
    }

    index
}

async fn voyage_record_path_async(home: &Path, id: &str) -> Option<PathBuf> {
    if !is_safe_id(id) {
        return None;
    }
    for candidate in [
        home.join("records").join(format!("{id}.jsonl")),
        home.join("issues").join("records").join(format!("{id}.jsonl")),
    ] {
        if tokio::fs::metadata(&candidate).await.is_ok_and(|m| m.is_file()) {
            return Some(candidate);
        }
    }
    None
}

async fn scan_record_ids_async(home: &Path) -> Vec<String> {
    let mut ids = Vec::new();
    for dir in [home.join("records"), home.join("issues").join("records")] {
        let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "jsonl")
                && let Some(stem) = path.file_stem().and_then(|s| s.to_str())
                && is_safe_id(stem)
            {
                ids.push(stem.to_string());
            }
        }
    }
    ids
}

struct LoadedVoyage {
    header: VoyageHeader,
    records: Vec<VoyageRecord>,
}

async fn load_voyage_async(home: &Path, id: &str) -> Option<LoadedVoyage> {
    let path = voyage_record_path_async(home, id).await?;
    let file = tokio::fs::File::open(&path).await.ok()?.into_std().await;
    crate::log::spawn_blocking_traced(move || {
        let mut reader = VoyageReader::new(BufReader::new(file)).ok()?;
        let header = reader.header.clone();
        let mut records = Vec::new();
        while let Ok(Some(rec)) = reader.read() {
            records.push(rec);
        }
        Some(LoadedVoyage { header, records })
    })
    .await
    .ok()
    .flatten()
}

fn merge_tokens(dst: &mut Option<EventTokens>, src: &EventTokens) {
    match dst {
        None => *dst = Some(src.clone()),
        Some(acc) => {
            acc.input += src.input;
            acc.cache_read += src.cache_read;
            acc.output += src.output;
            if let Some(v) = src.cache_write {
                acc.cache_write = Some(acc.cache_write.unwrap_or(0) + v);
            }
            if let Some(v) = src.reasoning {
                acc.reasoning = Some(acc.reasoning.unwrap_or(0) + v);
            }
            if let Some(v) = src.context_used {
                acc.context_used = Some(acc.context_used.map_or(v, |cur| cur.max(v)));
            }
            if let Some(v) = src.context_window {
                acc.context_window = Some(acc.context_window.map_or(v, |cur| cur.max(v)));
            }
        }
    }
}

fn tokens_from_voyage_record(rec: &VoyageRecord) -> Option<EventTokens> {
    let mut total: Option<EventTokens> = None;
    for native in &rec.native_events {
        if let OarEventKind::TurnFinished { usage, .. } = &native.kind
            && let Some(t) = event_tokens_of(usage)
        {
            merge_tokens(&mut total, &t);
        }
    }
    if total.is_some() {
        return total;
    }
    for ev in &rec.events {
        if ev.get("kind").and_then(Value::as_str) == Some("usage")
            && let Some(tok) = ev.pointer("/usage/tokens").and_then(Value::as_object)
        {
            let input = tok.get("inputTokens").and_then(Value::as_i64).unwrap_or(0);
            let output = tok.get("outputTokens").and_then(Value::as_i64).unwrap_or(0);
            let cache_read = tok.get("cacheReadTokens").and_then(Value::as_i64).unwrap_or(0);
            let cache_write = tok.get("cacheWriteTokens").and_then(Value::as_i64);
            let reasoning = tok.get("reasoningTokens").and_then(Value::as_i64);
            let context_used = tok.get("contextUsedTokens").and_then(Value::as_i64);
            let context_window = tok.get("contextWindowTokens").and_then(Value::as_i64);
            merge_tokens(
                &mut total,
                &EventTokens {
                    input,
                    cache_read,
                    output,
                    cache_write,
                    reasoning,
                    context_used,
                    context_window,
                },
            );
        }
    }
    total
}

fn push_unique_error(errors: &mut Vec<String>, msg: String) {
    let trimmed = msg.trim();
    if !trimmed.is_empty() && !errors.iter().any(|existing| existing == trimmed) {
        errors.push(trimmed.to_string());
    }
}

fn detect_redacted_text_silent_errors(clean: &str, out: &mut Vec<String>) {
    if clean.is_empty() {
        return;
    }
    if contains_step_type_17(clean) {
        push_unique_error(out, "step_type=17 error step detected".into());
    }
    let bytes = clean.as_bytes();
    for marker in SILENT_ERROR_MARKERS {
        if contains_ascii_ci(bytes, marker.as_bytes()) {
            let (snippet, _) = clip_utf8(clean, 160);
            push_unique_error(out, format!("{marker}: {snippet}"));
        }
    }
}

fn detect_text_silent_errors(text: &str, redactor: &Redactor, count: &mut u32, out: &mut Vec<String>) {
    if text.is_empty() {
        return;
    }
    let clean = redactor.redact_cow(text, count);
    detect_redacted_text_silent_errors(&clean, out);
}

fn text_has_silent_error(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    if contains_step_type_17(text) {
        return true;
    }
    let bytes = text.as_bytes();
    SILENT_ERROR_MARKERS.iter().any(|marker| contains_ascii_ci(bytes, marker.as_bytes()))
}

fn raw_may_contain_step_type(text: &str) -> bool {
    text.contains("step_type") || text.contains("stepType") || text.contains("CORTEX_STEP_TYPE_ERROR_MESSAGE")
}

fn value_has_silent_error_text(val: &Value) -> bool {
    match val {
        Value::String(s) => text_has_silent_error(s),
        Value::Array(items) => items.iter().any(value_has_silent_error_text),
        Value::Object(map) => map.iter().any(|(k, v)| text_has_silent_error(k) || value_has_silent_error_text(v)),
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

fn contains_step_type_17(text: &str) -> bool {
    text.contains("\"step_type\":17")
        || text.contains("\"step_type\": 17")
        || text.contains("\"stepType\":17")
        || text.contains("\"stepType\": 17")
        || text.contains("step_type = 17")
        || text.contains("step_type=17")
        || text.contains("CORTEX_STEP_TYPE_ERROR_MESSAGE")
}

fn value_has_step_type_17(val: &Value) -> bool {
    match val {
        Value::Object(map) => {
            for (k, v) in map {
                if (k == "step_type" || k == "stepType")
                    && (v.as_i64() == Some(17) || v.as_str() == Some("17") || v.as_str() == Some("CORTEX_STEP_TYPE_ERROR_MESSAGE"))
                {
                    return true;
                }
                if value_has_step_type_17(v) {
                    return true;
                }
            }
            false
        }
        Value::Array(items) => items.iter().any(value_has_step_type_17),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => false,
    }
}

fn detect_redacted_session_event_errors(ev: &SessionEvent, out: &mut Vec<String>) {
    match ev.r#type {
        SessionEventType::RunError => {
            let msg = if ev.text.trim().is_empty() {
                "run/error".to_string()
            } else {
                ev.text.clone()
            };
            push_unique_error(out, msg);
        }
        SessionEventType::RunEnd if ev.text.eq_ignore_ascii_case("failed") => {
            push_unique_error(out, "run/end: failed".into());
        }
        SessionEventType::RunStart
        | SessionEventType::UserMessage
        | SessionEventType::MemoryRecalled
        | SessionEventType::AssistantThinking
        | SessionEventType::AssistantMessage
        | SessionEventType::ToolCall
        | SessionEventType::ToolResult
        | SessionEventType::PermissionRequest
        | SessionEventType::PermissionResolved
        | SessionEventType::InteractionRequest
        | SessionEventType::InteractionResolved
        | SessionEventType::LlmRetry
        | SessionEventType::LlmUsage
        | SessionEventType::RunEnd => {}
    }
    detect_redacted_text_silent_errors(&ev.text, out);
    if let Some(output) = &ev.output {
        detect_redacted_text_silent_errors(output, out);
    }
}

fn session_event_has_silent_error(ev: &SessionEvent) -> bool {
    let is_error_type = match ev.r#type {
        SessionEventType::RunError => true,
        SessionEventType::RunEnd => ev.text.eq_ignore_ascii_case("failed"),
        SessionEventType::RunStart
        | SessionEventType::UserMessage
        | SessionEventType::MemoryRecalled
        | SessionEventType::AssistantThinking
        | SessionEventType::AssistantMessage
        | SessionEventType::ToolCall
        | SessionEventType::ToolResult
        | SessionEventType::PermissionRequest
        | SessionEventType::PermissionResolved
        | SessionEventType::InteractionRequest
        | SessionEventType::InteractionResolved
        | SessionEventType::LlmRetry
        | SessionEventType::LlmUsage => false,
    };
    is_error_type || text_has_silent_error(&ev.text) || ev.output.as_deref().is_some_and(text_has_silent_error)
}

fn detect_voyage_record_errors(rec: &VoyageRecord, clean_raw: Option<&str>, redactor: &Redactor, count: &mut u32, out: &mut Vec<String>) {
    for native in &rec.native_events {
        match &native.kind {
            OarEventKind::Error { message } => push_unique_error(out, redactor.redact_str(message, count)),
            OarEventKind::TurnFinished { reason: StopReason::Error, .. } => push_unique_error(out, "turn_finished: error".into()),
            OarEventKind::SessionStarted { .. }
            | OarEventKind::TurnStarted { .. }
            | OarEventKind::TextDelta { .. }
            | OarEventKind::ThinkingDelta { .. }
            | OarEventKind::ToolCallStarted { .. }
            | OarEventKind::ToolCallFinished { .. }
            | OarEventKind::SubagentSpawned { .. }
            | OarEventKind::SubagentWait { .. }
            | OarEventKind::SubagentMessage { .. }
            | OarEventKind::SubagentPlanUpdated { .. }
            | OarEventKind::SubagentStatusChanged { .. }
            | OarEventKind::FileChanged { .. }
            | OarEventKind::PermissionRequested { .. }
            | OarEventKind::PermissionResolved { .. }
            | OarEventKind::InteractionRequested { .. }
            | OarEventKind::InteractionResolved { .. }
            | OarEventKind::Question { .. }
            | OarEventKind::TurnFinished { .. }
            | OarEventKind::SessionEnded => {}
        }
    }
    for ev in &rec.events {
        if value_has_step_type_17(ev) {
            push_unique_error(out, "step_type=17 error step detected".into());
        }
        if ev.get("kind").and_then(Value::as_str) == Some("error") {
            let msg = ev
                .get("message")
                .or_else(|| ev.get("error"))
                .and_then(Value::as_str)
                .unwrap_or("voyage error event");
            push_unique_error(out, redactor.redact_str(msg, count));
        }
        if ev.get("kind").and_then(Value::as_str) == Some("turn_ended") && ev.pointer("/outcome/kind").and_then(Value::as_str) == Some("failed") {
            let reason = ev.pointer("/outcome/reason").and_then(Value::as_str).unwrap_or("turn_ended: failed");
            push_unique_error(out, redactor.redact_str(reason, count));
        }
        if value_has_silent_error_text(ev) {
            detect_text_silent_errors(&ev.to_string(), redactor, count, out);
        }
    }
    if let Some(marker) = &rec.marker {
        if value_has_step_type_17(marker) {
            push_unique_error(out, "step_type=17 error marker detected".into());
        }
        if matches!(marker.get("name").and_then(Value::as_str), Some("error" | "silent_error")) {
            push_unique_error(out, redactor.redact_str(&marker.to_string(), count));
        }
    }
    if let Some(clean) = clean_raw {
        if raw_may_contain_step_type(clean)
            && let Ok(parsed) = serde_json::from_str::<Value>(clean)
            && value_has_step_type_17(&parsed)
        {
            push_unique_error(out, "step_type=17 error frame detected".into());
        }
        detect_redacted_text_silent_errors(clean, out);
    }
}

fn voyage_record_has_silent_error(rec: &VoyageRecord) -> bool {
    for native in &rec.native_events {
        let is_err = match &native.kind {
            OarEventKind::Error { message } => !message.trim().is_empty(),
            OarEventKind::TurnFinished { reason: StopReason::Error, .. } => true,
            OarEventKind::SessionStarted { .. }
            | OarEventKind::TurnStarted { .. }
            | OarEventKind::TextDelta { .. }
            | OarEventKind::ThinkingDelta { .. }
            | OarEventKind::ToolCallStarted { .. }
            | OarEventKind::ToolCallFinished { .. }
            | OarEventKind::SubagentSpawned { .. }
            | OarEventKind::SubagentWait { .. }
            | OarEventKind::SubagentMessage { .. }
            | OarEventKind::SubagentPlanUpdated { .. }
            | OarEventKind::SubagentStatusChanged { .. }
            | OarEventKind::FileChanged { .. }
            | OarEventKind::PermissionRequested { .. }
            | OarEventKind::PermissionResolved { .. }
            | OarEventKind::InteractionRequested { .. }
            | OarEventKind::InteractionResolved { .. }
            | OarEventKind::Question { .. }
            | OarEventKind::TurnFinished { .. }
            | OarEventKind::SessionEnded => false,
        };
        if is_err {
            return true;
        }
    }
    for ev in &rec.events {
        if value_has_step_type_17(ev) {
            return true;
        }
        if ev.get("kind").and_then(Value::as_str) == Some("error") {
            let msg = ev
                .get("message")
                .or_else(|| ev.get("error"))
                .and_then(Value::as_str)
                .unwrap_or("voyage error event");
            if !msg.trim().is_empty() {
                return true;
            }
        }
        if ev.get("kind").and_then(Value::as_str) == Some("turn_ended") && ev.pointer("/outcome/kind").and_then(Value::as_str) == Some("failed") {
            let reason = ev.pointer("/outcome/reason").and_then(Value::as_str).unwrap_or("turn_ended: failed");
            if !reason.trim().is_empty() {
                return true;
            }
        }
        if value_has_silent_error_text(ev) {
            return true;
        }
    }
    if let Some(marker) = &rec.marker
        && (value_has_step_type_17(marker) || matches!(marker.get("name").and_then(Value::as_str), Some("error" | "silent_error")))
    {
        return true;
    }
    if !rec.raw.is_empty() {
        let raw_text = String::from_utf8_lossy(&rec.raw);
        if text_has_silent_error(&raw_text) {
            return true;
        }
        if raw_may_contain_step_type(&raw_text)
            && let Ok(parsed) = serde_json::from_str::<Value>(&raw_text)
            && value_has_step_type_17(&parsed)
        {
            return true;
        }
    }
    false
}

fn voyage_kind_str(kind: VoyageKind) -> &'static str {
    match kind {
        VoyageKind::Frame => "frame",
        VoyageKind::Control => "control",
        VoyageKind::Marker => "marker",
    }
}

fn redacted_raw_text(rec: &VoyageRecord, redactor: &Redactor, count: &mut u32) -> Option<String> {
    if rec.raw.is_empty() {
        return None;
    }
    let lossy = String::from_utf8_lossy(&rec.raw);
    Some(redactor.redact_str(&lossy, count))
}

fn raw_entry_of(rec: &VoyageRecord, clean_raw: Option<String>, redactor: &Redactor, count: &mut u32) -> DebugTrajectoryRawEntry {
    let clean_payload = if clean_raw.is_some() {
        clean_raw
    } else if !rec.events.is_empty() || rec.control.is_some() || rec.marker.is_some() {
        let mut obj = serde_json::Map::new();
        if !rec.events.is_empty() {
            obj.insert("events".into(), Value::Array(rec.events.clone()));
        }
        if let Some(ctrl) = &rec.control {
            obj.insert("control".into(), ctrl.clone());
        }
        if let Some(marker) = &rec.marker {
            obj.insert("marker".into(), marker.clone());
        }
        serde_json::to_string(&Value::Object(obj)).ok().map(|s| redactor.redact_owned(s, count))
    } else {
        None
    };

    let (payload, original_bytes, truncated) = match clean_payload {
        Some(clean) => {
            let original_bytes = u32::try_from(clean.len()).unwrap_or(u32::MAX);
            let (clipped, truncated) = clip_utf8(&clean, RAW_PAYLOAD_MAX_BYTES);
            let payload = if truncated { clipped.to_string() } else { clean };
            (Some(payload), original_bytes, truncated)
        }
        None => (None, 0, false),
    };

    let summary_raw = if !rec.frame_type.is_empty() {
        if let Some(first_kind) = rec.events.first().and_then(|e| e.get("kind")).and_then(Value::as_str)
            && first_kind != rec.frame_type
        {
            format!("{} ({first_kind})", rec.frame_type)
        } else {
            rec.frame_type.clone()
        }
    } else if let Some(marker_name) = rec.marker.as_ref().and_then(|m| m.get("name")).and_then(Value::as_str) {
        format!("marker:{marker_name}")
    } else {
        voyage_kind_str(rec.kind).to_string()
    };

    DebugTrajectoryRawEntry {
        seq: rec.seq as i64,
        time: rec.received_at as i64,
        kind: voyage_kind_str(rec.kind).to_string(),
        frame_type: (!rec.frame_type.is_empty()).then(|| rec.frame_type.clone()),
        agent_path: rec.agent_path.clone(),
        trace_id: rec.trace_id.map(|t| t as i64),
        summary: redactor.redact_str(&summary_raw, count),
        payload,
        original_bytes,
        truncated,
    }
}

fn voyage_turn_prompt(rec: &VoyageRecord) -> Option<String> {
    for native in &rec.native_events {
        if let OarEventKind::TurnStarted { prompt } = &native.kind {
            return Some(prompt.clone());
        }
    }
    for ev in &rec.events {
        if ev.get("kind").and_then(Value::as_str) == Some("turn_started")
            && let Some(input) = ev.get("input").and_then(Value::as_str)
        {
            return Some(input.to_string());
        }
    }
    None
}

fn extract_voyage_system_prompt(voyage: &LoadedVoyage) -> Option<String> {
    if let Some(p) = voyage
        .header
        .metadata
        .get("systemPrompt")
        .or_else(|| voyage.header.metadata.get("system_prompt"))
        .filter(|s| !s.trim().is_empty())
    {
        return Some(p.clone());
    }
    for rec in &voyage.records {
        for ev in &rec.events {
            if let Some(p) = ev
                .get("systemPrompt")
                .or_else(|| ev.get("system_prompt"))
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
            {
                return Some(p.to_string());
            }
        }
    }
    None
}

#[derive(Clone, Copy)]
struct TurnFlags {
    has_prompt: bool,
    has_run_end: bool,
    has_non_preamble: bool,
}

fn should_start_session_turn(kind: SessionEventType, last: Option<TurnFlags>) -> bool {
    let Some(last) = last else {
        return true;
    };
    match kind {
        SessionEventType::RunStart => last.has_prompt || last.has_run_end,
        SessionEventType::UserMessage => last.has_prompt || last.has_non_preamble,
        SessionEventType::MemoryRecalled
        | SessionEventType::AssistantThinking
        | SessionEventType::AssistantMessage
        | SessionEventType::ToolCall
        | SessionEventType::ToolResult
        | SessionEventType::PermissionRequest
        | SessionEventType::PermissionResolved
        | SessionEventType::InteractionRequest
        | SessionEventType::InteractionResolved
        | SessionEventType::LlmRetry
        | SessionEventType::LlmUsage
        | SessionEventType::RunError
        | SessionEventType::RunEnd => false,
    }
}

fn turn_flags_of_detail(turn: &DebugTrajectoryTurn) -> TurnFlags {
    TurnFlags {
        has_prompt: turn.prompt.is_some(),
        has_run_end: turn.events.iter().any(|e| e.r#type == SessionEventType::RunEnd),
        has_non_preamble: turn
            .events
            .iter()
            .any(|e| !matches!(e.r#type, SessionEventType::RunStart | SessionEventType::MemoryRecalled)),
    }
}

fn find_turn_index(len: usize, span_id: &str, matches_span: impl Fn(usize) -> bool, started_at: impl Fn(usize) -> i64, received_at: u64) -> usize {
    if !span_id.is_empty()
        && let Some(pos) = (0..len).rev().find(|&i| matches_span(i))
    {
        return pos;
    }
    let ts = received_at as i64;
    (0..len).rev().find(|&i| started_at(i) <= ts).unwrap_or(0)
}

fn push_session_event_to_turns(
    raw_ev: SessionEvent,
    redactor: &Redactor,
    count: &mut u32,
    turns: &mut Vec<DebugTrajectoryTurn>,
    turn_runs: &mut Vec<Option<String>>,
    subagent_paths: &mut BTreeSet<String>,
) {
    let ev = redactor.redact_session_event(raw_ev, count);
    if let Some(tid) = &ev.thread_id
        && !tid.is_empty()
    {
        subagent_paths.insert(redactor.redact_str(tid, count));
    }
    let start_new = should_start_session_turn(ev.r#type, turns.last().map(turn_flags_of_detail));
    if start_new {
        let index = turns.len() as u32;
        let prompt = (ev.r#type == SessionEventType::UserMessage).then(|| ev.text.clone());
        turns.push(DebugTrajectoryTurn {
            index,
            prompt,
            started_at: ev.time,
            ended_at: Some(ev.time),
            duration_ms: Some(0),
            events: Vec::new(),
            raw_entries: Vec::new(),
            tokens: None,
            silent_errors: Vec::new(),
            trace_ids: Vec::new(),
        });
        turn_runs.push(ev.run.clone());
    } else if ev.r#type == SessionEventType::UserMessage
        && let Some(cur) = turns.last_mut()
        && cur.prompt.is_none()
    {
        cur.prompt = Some(ev.text.clone());
    }
    let Some(cur) = turns.last_mut() else {
        return;
    };
    if let Some(slot) = turn_runs.last_mut()
        && slot.is_none()
        && ev.run.is_some()
    {
        *slot = ev.run.clone();
    }
    cur.ended_at = Some(cur.ended_at.map_or(ev.time, |end| end.max(ev.time)));
    if let Some(tokens) = &ev.tokens {
        merge_tokens(&mut cur.tokens, tokens);
    }
    detect_redacted_session_event_errors(&ev, &mut cur.silent_errors);
    cur.events.push(ev);
}

fn record_voyage_agent_path(rec: &VoyageRecord, redactor: &Redactor, count: &mut u32, subagent_paths: &mut BTreeSet<String>) {
    if !rec.agent_path.is_empty() {
        subagent_paths.insert(redactor.redact_str(&rec.agent_path.join("/"), count));
    }
}

fn append_voyage_record_to_turn(
    rec: &VoyageRecord,
    cur: &mut DebugTrajectoryTurn,
    update_tokens: bool,
    update_ended_at: bool,
    redactor: &Redactor,
    count: &mut u32,
) {
    if update_ended_at {
        let t = rec.received_at as i64;
        cur.ended_at = Some(cur.ended_at.map_or(t, |end| end.max(t)));
    }
    if update_tokens && let Some(tokens) = tokens_from_voyage_record(rec) {
        merge_tokens(&mut cur.tokens, &tokens);
    }
    let clean_raw = redacted_raw_text(rec, redactor, count);
    detect_voyage_record_errors(rec, clean_raw.as_deref(), redactor, count, &mut cur.silent_errors);
    cur.raw_entries.push(raw_entry_of(rec, clean_raw, redactor, count));
}

fn build_voyage_only_turns(records: &[VoyageRecord], redactor: &Redactor, count: &mut u32, subagent_paths: &mut BTreeSet<String>) -> Vec<DebugTrajectoryTurn> {
    let mut turns: Vec<DebugTrajectoryTurn> = Vec::new();
    let mut active_span: Option<String> = None;
    for rec in records {
        record_voyage_agent_path(rec, redactor, count, subagent_paths);
        let prompt = voyage_turn_prompt(rec).map(|p| redactor.redact_owned(p, count));
        let span_changed = !rec.span_id.is_empty() && active_span.as_deref().is_some_and(|s| s != rec.span_id);
        let start_new = turns.is_empty() || prompt.is_some() || span_changed;
        if start_new {
            let index = turns.len() as u32;
            turns.push(DebugTrajectoryTurn {
                index,
                prompt,
                started_at: rec.received_at as i64,
                ended_at: Some(rec.received_at as i64),
                duration_ms: Some(0),
                events: Vec::new(),
                raw_entries: Vec::new(),
                tokens: None,
                silent_errors: Vec::new(),
                trace_ids: Vec::new(),
            });
        }
        if !rec.span_id.is_empty() && (start_new || active_span.is_none()) {
            active_span = Some(rec.span_id.clone());
        }
        if let Some(cur) = turns.last_mut() {
            append_voyage_record_to_turn(rec, cur, true, true, redactor, count);
        }
    }
    turns
}

fn attach_voyage_to_turns(
    records: &[VoyageRecord],
    turn_runs: &[Option<String>],
    redactor: &Redactor,
    count: &mut u32,
    turns: &mut [DebugTrajectoryTurn],
    subagent_paths: &mut BTreeSet<String>,
) {
    for rec in records {
        record_voyage_agent_path(rec, redactor, count, subagent_paths);
        let idx = find_turn_index(
            turns.len(),
            &rec.span_id,
            |i| turn_runs.get(i).and_then(|r| r.as_deref()) == Some(rec.span_id.as_str()),
            |i| turns[i].started_at,
            rec.received_at,
        );
        if let Some(cur) = turns.get_mut(idx) {
            let need_tokens = cur.tokens.is_none();
            append_voyage_record_to_turn(rec, cur, need_tokens, false, redactor, count);
        }
    }
}

fn build_turns(events: Vec<SessionEvent>, voyage: Option<&LoadedVoyage>, redactor: &Redactor, count: &mut u32) -> (Vec<DebugTrajectoryTurn>, BTreeSet<String>) {
    let mut subagent_paths = BTreeSet::new();
    let mut turns: Vec<DebugTrajectoryTurn> = Vec::new();
    let mut turn_runs: Vec<Option<String>> = Vec::new();

    for raw_ev in events {
        push_session_event_to_turns(raw_ev, redactor, count, &mut turns, &mut turn_runs, &mut subagent_paths);
    }

    if let Some(loaded) = voyage {
        if turns.is_empty() {
            // Pure voyage-only trajectory (no SessionEvents in SQLite yet).
            turns = build_voyage_only_turns(&loaded.records, redactor, count, &mut subagent_paths);
        } else {
            // Attach voyage records to the best-matching SessionEvent turn by span_id or timestamp.
            attach_voyage_to_turns(&loaded.records, &turn_runs, redactor, count, &mut turns, &mut subagent_paths);
        }
    }

    for turn in &mut turns {
        turn.duration_ms = turn.ended_at.map(|end| (end - turn.started_at).max(0));
        let trace_set: BTreeSet<i64> = turn.raw_entries.iter().filter_map(|e| e.trace_id).collect();
        turn.trace_ids = trace_set.into_iter().collect();
    }
    (turns, subagent_paths)
}

fn subagent_status_str(status: SubagentStatus) -> &'static str {
    match status {
        SubagentStatus::PendingInit => "pending_init",
        SubagentStatus::Running => "running",
        SubagentStatus::Interrupted => "interrupted",
        SubagentStatus::Completed => "completed",
        SubagentStatus::Errored => "errored",
        SubagentStatus::Shutdown => "shutdown",
        SubagentStatus::NotFound => "not_found",
    }
}

fn oar_subagent_status_str(status: &vibevalley_runtime::oar::SubagentStatus) -> &'static str {
    match status {
        vibevalley_runtime::oar::SubagentStatus::PendingInit => "pending_init",
        vibevalley_runtime::oar::SubagentStatus::Running => "running",
        vibevalley_runtime::oar::SubagentStatus::Interrupted => "interrupted",
        vibevalley_runtime::oar::SubagentStatus::Completed => "completed",
        vibevalley_runtime::oar::SubagentStatus::Errored => "errored",
        vibevalley_runtime::oar::SubagentStatus::Shutdown => "shutdown",
        vibevalley_runtime::oar::SubagentStatus::NotFound => "not_found",
    }
}

#[derive(Default)]
struct SubagentNodeAccum {
    parent_id: Option<String>,
    path: String,
    label: String,
    agent_name: Option<String>,
    status: Option<String>,
    turns: BTreeSet<u32>,
    event_count: u32,
    raw_count: u32,
    started_at: Option<i64>,
    ended_at: Option<i64>,
    trace_ids: BTreeSet<i64>,
}

fn touch_subagent_time(acc: &mut SubagentNodeAccum, ts: i64) {
    if ts > 0 {
        acc.started_at = Some(acc.started_at.map_or(ts, |s| s.min(ts)));
        acc.ended_at = Some(acc.ended_at.map_or(ts, |e| e.max(ts)));
    }
}

fn build_subagent_nodes(
    meta: Option<&SessionStateMeta>,
    turns: &[DebugTrajectoryTurn],
    voyage: Option<&LoadedVoyage>,
    redactor: &Redactor,
    count: &mut u32,
) -> Vec<DebugTrajectorySubagentNode> {
    let mut nodes: BTreeMap<String, SubagentNodeAccum> = BTreeMap::new();
    let root_thread = meta.and_then(|m| m.subagents.as_ref()).map(|s| s.root_thread_id.as_str());

    let ensure_path_chain = |nodes: &mut BTreeMap<String, SubagentNodeAccum>, segments: &[&str], count: &mut u32| -> Option<String> {
        let mut parent: Option<String> = None;
        let mut prefix = String::new();
        for (idx, seg) in segments.iter().enumerate() {
            let clean_seg = redactor.redact_str(seg.trim(), count);
            if clean_seg.is_empty() {
                continue;
            }
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(&clean_seg);
            let entry = nodes.entry(prefix.clone()).or_insert_with(|| SubagentNodeAccum {
                parent_id: parent.clone(),
                path: prefix.clone(),
                label: clean_seg.clone(),
                ..Default::default()
            });
            if idx > 0 && entry.parent_id.is_none() {
                entry.parent_id = parent.clone();
            }
            parent = Some(prefix.clone());
        }
        parent
    };

    if let Some(subagents) = meta.and_then(|m| m.subagents.as_ref()) {
        for thread in &subagents.threads {
            let id = redactor.redact_str(thread.thread_id.trim(), count);
            if id.is_empty() {
                continue;
            }
            let parent_id = thread
                .parent_thread_id
                .as_deref()
                .map(str::trim)
                .filter(|p| !p.is_empty() && Some(*p) != root_thread)
                .map(|p| redactor.redact_str(p, count));
            let agent_name = thread.agent_name.as_deref().map(|n| redactor.redact_str(n, count));
            let label = agent_name.clone().unwrap_or_else(|| id.clone());
            let entry = nodes.entry(id.clone()).or_insert_with(|| SubagentNodeAccum {
                parent_id: parent_id.clone(),
                path: id.clone(),
                label: label.clone(),
                agent_name: agent_name.clone(),
                ..Default::default()
            });
            if entry.parent_id.is_none() {
                entry.parent_id = parent_id;
            }
            if entry.agent_name.is_none() {
                entry.agent_name = agent_name;
            }
            if entry.label.is_empty() {
                entry.label = label;
            }
            if let Some(status) = thread.status {
                entry.status = Some(subagent_status_str(status).to_string());
            }
            touch_subagent_time(entry, thread.updated_at);
        }
    }

    for turn in turns {
        for ev in &turn.events {
            let Some(raw_tid) = ev.thread_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
                continue;
            };
            let tid = redactor.redact_str(raw_tid, count);
            let entry = nodes.entry(tid.clone()).or_insert_with(|| SubagentNodeAccum {
                parent_id: None,
                path: tid.clone(),
                label: tid.clone(),
                ..Default::default()
            });
            entry.turns.insert(turn.index);
            entry.event_count += 1;
            touch_subagent_time(entry, ev.time);
        }
        for raw in &turn.raw_entries {
            if raw.agent_path.is_empty() {
                continue;
            }
            let segs: Vec<&str> = raw.agent_path.iter().map(String::as_str).collect();
            if let Some(leaf_id) = ensure_path_chain(&mut nodes, &segs, count)
                && let Some(entry) = nodes.get_mut(&leaf_id)
            {
                entry.turns.insert(turn.index);
                entry.raw_count += 1;
                touch_subagent_time(entry, raw.time);
                if let Some(trace) = raw.trace_id {
                    entry.trace_ids.insert(trace);
                }
            }
        }
    }

    if let Some(loaded) = voyage {
        for rec in &loaded.records {
            let parent_from_rec = if rec.agent_path.is_empty() {
                None
            } else {
                let segs: Vec<&str> = rec.agent_path.iter().map(String::as_str).collect();
                ensure_path_chain(&mut nodes, &segs, count)
            };
            for native in &rec.native_events {
                match &native.kind {
                    OarEventKind::SubagentSpawned { thread_id, agent_name, .. } => {
                        let id = redactor.redact_str(thread_id.trim(), count);
                        if id.is_empty() {
                            continue;
                        }
                        let agent_clean = agent_name.as_deref().map(|n| redactor.redact_str(n, count));
                        let entry = nodes.entry(id.clone()).or_insert_with(|| SubagentNodeAccum {
                            parent_id: parent_from_rec.clone().filter(|p| p != &id),
                            path: parent_from_rec.as_ref().map_or_else(|| id.clone(), |p| format!("{p}/{id}")),
                            label: agent_clean.clone().unwrap_or_else(|| id.clone()),
                            agent_name: agent_clean.clone(),
                            status: Some("running".to_string()),
                            ..Default::default()
                        });
                        if entry.parent_id.is_none() {
                            entry.parent_id = parent_from_rec.clone().filter(|p| p != &id);
                        }
                        if entry.agent_name.is_none() {
                            entry.agent_name = agent_clean;
                        }
                        touch_subagent_time(entry, rec.received_at as i64);
                        if let Some(trace) = rec.trace_id {
                            entry.trace_ids.insert(trace as i64);
                        }
                    }
                    OarEventKind::SubagentStatusChanged { thread_id, status, .. } => {
                        let id = redactor.redact_str(thread_id.trim(), count);
                        if id.is_empty() {
                            continue;
                        }
                        let entry = nodes.entry(id.clone()).or_insert_with(|| SubagentNodeAccum {
                            parent_id: parent_from_rec.clone().filter(|p| p != &id),
                            path: id.clone(),
                            label: id.clone(),
                            ..Default::default()
                        });
                        entry.status = Some(oar_subagent_status_str(status).to_string());
                        touch_subagent_time(entry, rec.received_at as i64);
                    }
                    OarEventKind::SubagentWait { thread_id, .. }
                    | OarEventKind::SubagentMessage { thread_id, .. }
                    | OarEventKind::SubagentPlanUpdated { thread_id, .. } => {
                        let id = redactor.redact_str(thread_id.trim(), count);
                        if !id.is_empty() {
                            let entry = nodes.entry(id.clone()).or_insert_with(|| SubagentNodeAccum {
                                parent_id: parent_from_rec.clone().filter(|p| p != &id),
                                path: id.clone(),
                                label: id.clone(),
                                ..Default::default()
                            });
                            touch_subagent_time(entry, rec.received_at as i64);
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    let existing_ids: BTreeSet<String> = nodes.keys().cloned().collect();
    nodes
        .into_iter()
        .map(|(id, acc)| DebugTrajectorySubagentNode {
            parent_id: acc.parent_id.filter(|p| p != &id && existing_ids.contains(p)),
            id,
            path: acc.path,
            label: acc.label,
            agent_name: acc.agent_name,
            status: acc.status,
            turn_count: acc.turns.len() as u32,
            event_count: acc.event_count,
            raw_count: acc.raw_count,
            started_at: acc.started_at,
            ended_at: acc.ended_at,
            trace_ids: acc.trace_ids.into_iter().collect(),
        })
        .collect()
}

fn resolve_trajectory_runtime(meta: Option<&SessionStateMeta>, voyage: Option<&LoadedVoyage>, kind: DebugTrajectoryKind) -> String {
    meta.and_then(|m| m.runtime.clone())
        .or_else(|| voyage.map(|v| v.header.runtime.clone()).filter(|r| !r.is_empty()))
        .unwrap_or_else(|| {
            if kind == DebugTrajectoryKind::Orchestrator {
                ORCHESTRATOR_RUNTIME.to_string()
            } else {
                "unknown".to_string()
            }
        })
}

fn max_voyage_updated_at(mut updated_at: i64, loaded: &LoadedVoyage) -> i64 {
    updated_at = updated_at.max(loaded.header.created_at as i64);
    if let Some(last) = loaded.records.last() {
        updated_at = updated_at.max(last.received_at as i64);
    }
    updated_at
}

pub(crate) async fn build_detail_async(
    home: &Path,
    meta: Option<&SessionStateMeta>,
    sources: &dyn DebugDataSource,
    redactor: &Redactor,
    req: &DebugTrajectoryGetRequest,
    orchestrator_ids: &[String],
    redacted_count: &mut u32,
) -> Result<DebugTrajectoryDetail, ApiError> {
    let id = req.id.trim();
    if !is_safe_id(id) {
        return Err(ApiError::new(BizCode::InvalidInput, "invalid trajectory id"));
    }
    let events = sources.trajectory_events(id);
    let voyage = load_voyage_async(home, id).await;
    let exists_in_state = meta.is_some_and(|m| m.exists || m.in_issue_history);
    let is_orchestrator_profile = orchestrator_ids.iter().any(|o| o == id);
    if !exists_in_state && events.is_empty() && voyage.is_none() && !is_orchestrator_profile {
        return Err(ApiError::new(BizCode::SessionNotFound, format!("trajectory not found: {id}")));
    }

    let kind = req
        .kind
        .unwrap_or_else(|| classify_meta(id, meta, orchestrator_ids, voyage.as_ref().map(|v| &v.header)));
    let event_count = events.len() as u32;
    let voyage_record_count = voyage.as_ref().map(|v| v.records.len() as u32).unwrap_or(0);
    let has_voyage_record = voyage.is_some();

    let raw_system_prompt = sources
        .system_prompt_async(id, kind)
        .await
        .or_else(|| voyage.as_ref().and_then(extract_voyage_system_prompt));
    let system_prompt = redactor.redact_opt_str(raw_system_prompt, redacted_count);

    let (turns, mut subagent_set) = build_turns(events, voyage.as_ref(), redactor, redacted_count);
    let subagent_nodes = build_subagent_nodes(meta, &turns, voyage.as_ref(), redactor, redacted_count);
    for node in &subagent_nodes {
        subagent_set.insert(node.path.clone());
    }

    let mut total_tokens: Option<EventTokens> = None;
    let mut updated_at = meta.map_or(0, |m| m.updated_at);
    for turn in &turns {
        if let Some(tokens) = &turn.tokens {
            merge_tokens(&mut total_tokens, tokens);
        }
        updated_at = updated_at.max(turn.ended_at.unwrap_or(turn.started_at));
    }
    if let Some(loaded) = &voyage {
        updated_at = max_voyage_updated_at(updated_at, loaded);
    }

    let runtime = resolve_trajectory_runtime(meta, voyage.as_ref(), kind);
    let status = meta.and_then(|m| m.status).unwrap_or("recorded").to_string();
    let raw_title = meta.and_then(|m| m.title.as_deref()).unwrap_or(id);
    let title = redactor.redact_str(raw_title, redacted_count);
    let has_silent_error = turns.iter().any(|t| !t.silent_errors.is_empty());

    Ok(DebugTrajectoryDetail {
        summary: DebugTrajectorySummary {
            id: id.to_string(),
            kind,
            title,
            runtime,
            status,
            updated_at,
            event_count: event_count.max(voyage_record_count),
            has_voyage_record,
            has_silent_error,
            tokens: total_tokens,
        },
        system_prompt,
        turns,
        subagent_paths: subagent_set.into_iter().collect(),
        subagent_nodes,
        voyage_record_count,
    })
}

struct SummaryTurnMeta {
    started_at: i64,
    run: Option<String>,
    has_prompt: bool,
    has_run_end: bool,
    has_non_preamble: bool,
    has_tokens: bool,
}

fn turn_flags_of_summary(turn: &SummaryTurnMeta) -> TurnFlags {
    TurnFlags {
        has_prompt: turn.has_prompt,
        has_run_end: turn.has_run_end,
        has_non_preamble: turn.has_non_preamble,
    }
}

fn summarize_session_events(
    events: &[SessionEvent],
    total_tokens: &mut Option<EventTokens>,
    updated_at: &mut i64,
    has_silent_error: &mut bool,
) -> Vec<SummaryTurnMeta> {
    let mut turns: Vec<SummaryTurnMeta> = Vec::new();
    for ev in events {
        let start_new = should_start_session_turn(ev.r#type, turns.last().map(turn_flags_of_summary));
        if start_new {
            turns.push(SummaryTurnMeta {
                started_at: ev.time,
                run: ev.run.clone(),
                has_prompt: ev.r#type == SessionEventType::UserMessage,
                has_run_end: false,
                has_non_preamble: false,
                has_tokens: false,
            });
        } else if ev.r#type == SessionEventType::UserMessage
            && let Some(cur) = turns.last_mut()
            && !cur.has_prompt
        {
            cur.has_prompt = true;
        }
        if let Some(cur) = turns.last_mut() {
            if cur.run.is_none() && ev.run.is_some() {
                cur.run = ev.run.clone();
            }
            if ev.r#type == SessionEventType::RunEnd {
                cur.has_run_end = true;
            }
            if !matches!(ev.r#type, SessionEventType::RunStart | SessionEventType::MemoryRecalled) {
                cur.has_non_preamble = true;
            }
            *updated_at = (*updated_at).max(ev.time);
            if let Some(tokens) = &ev.tokens {
                merge_tokens(total_tokens, tokens);
                cur.has_tokens = true;
            }
        }
        if !*has_silent_error && session_event_has_silent_error(ev) {
            *has_silent_error = true;
        }
    }
    turns
}

fn merge_voyage_into_summary_turns(
    records: &[VoyageRecord],
    turns: &mut [SummaryTurnMeta],
    total_tokens: &mut Option<EventTokens>,
    has_silent_error: &mut bool,
) {
    for rec in records {
        let idx = find_turn_index(
            turns.len(),
            &rec.span_id,
            |i| turns[i].run.as_deref() == Some(rec.span_id.as_str()),
            |i| turns[i].started_at,
            rec.received_at,
        );
        if let Some(cur) = turns.get_mut(idx)
            && !cur.has_tokens
            && let Some(tokens) = tokens_from_voyage_record(rec)
        {
            merge_tokens(total_tokens, &tokens);
            cur.has_tokens = true;
        }
        if !*has_silent_error && voyage_record_has_silent_error(rec) {
            *has_silent_error = true;
        }
    }
}

fn summarize_voyage_only(records: &[VoyageRecord], total_tokens: &mut Option<EventTokens>, updated_at: &mut i64, has_silent_error: &mut bool) {
    for rec in records {
        *updated_at = (*updated_at).max(rec.received_at as i64);
        if let Some(tokens) = tokens_from_voyage_record(rec) {
            merge_tokens(total_tokens, &tokens);
        }
        if !*has_silent_error && voyage_record_has_silent_error(rec) {
            *has_silent_error = true;
        }
    }
}

async fn build_summary_async(
    home: &Path,
    id: &str,
    meta: Option<&SessionStateMeta>,
    sources: &dyn DebugDataSource,
    redactor: &Redactor,
    orchestrator_ids: &[String],
    redacted_count: &mut u32,
) -> Option<DebugTrajectorySummary> {
    if !is_safe_id(id) {
        return None;
    }
    let events = sources.trajectory_events(id);
    let voyage = load_voyage_async(home, id).await;
    let exists_in_state = meta.is_some_and(|m| m.exists || m.in_issue_history);
    let is_orchestrator_profile = orchestrator_ids.iter().any(|o| o == id);
    if !exists_in_state && events.is_empty() && voyage.is_none() && !is_orchestrator_profile {
        return None;
    }

    let kind = classify_meta(id, meta, orchestrator_ids, voyage.as_ref().map(|v| &v.header));
    let event_count = events.len() as u32;
    let voyage_record_count = voyage.as_ref().map(|v| v.records.len() as u32).unwrap_or(0);
    let has_voyage_record = voyage.is_some();

    let mut total_tokens: Option<EventTokens> = None;
    let mut updated_at = meta.map_or(0, |m| m.updated_at);
    let mut has_silent_error = false;

    if !events.is_empty() {
        let mut turns = summarize_session_events(&events, &mut total_tokens, &mut updated_at, &mut has_silent_error);
        if let Some(loaded) = &voyage {
            merge_voyage_into_summary_turns(&loaded.records, &mut turns, &mut total_tokens, &mut has_silent_error);
        }
    } else if let Some(loaded) = &voyage {
        summarize_voyage_only(&loaded.records, &mut total_tokens, &mut updated_at, &mut has_silent_error);
    }

    if let Some(loaded) = &voyage {
        updated_at = max_voyage_updated_at(updated_at, loaded);
    }

    let runtime = resolve_trajectory_runtime(meta, voyage.as_ref(), kind);
    let status = meta.and_then(|m| m.status).unwrap_or("recorded").to_string();
    let raw_title = meta.and_then(|m| m.title.as_deref()).unwrap_or(id);
    let title = redactor.redact_str(raw_title, redacted_count);

    Some(DebugTrajectorySummary {
        id: id.to_string(),
        kind,
        title,
        runtime,
        status,
        updated_at,
        event_count: event_count.max(voyage_record_count),
        has_voyage_record,
        has_silent_error,
        tokens: total_tokens,
    })
}

pub(crate) async fn list_summaries_async(
    home: &Path,
    index: &StateTrajectoryIndex,
    sources: &dyn DebugDataSource,
    redactor: &Redactor,
    orchestrator_ids: &[String],
    redacted_count: &mut u32,
) -> Vec<DebugTrajectorySummary> {
    let mut ids = index.known_ids.clone();
    for id in orchestrator_ids {
        ids.insert(id.clone());
    }
    for id in sources.open_trajectory_ids() {
        ids.insert(id);
    }
    for id in scan_record_ids_async(home).await {
        ids.insert(id);
    }

    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let meta = index.sessions.get(&id);
        if let Some(summary) = build_summary_async(home, &id, meta, sources, redactor, orchestrator_ids, redacted_count).await {
            out.push(summary);
        }
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| a.id.cmp(&b.id)));
    out
}

#[derive(Serialize)]
pub(crate) struct TrajectoryExport {
    summaries: Vec<DebugTrajectorySummary>,
    details: BTreeMap<String, DebugTrajectoryDetail>,
}

pub(crate) async fn export_snapshot_async(
    home: &Path,
    index: &StateTrajectoryIndex,
    sources: &dyn DebugDataSource,
    redactor: &Redactor,
    orchestrator_ids: &[String],
    redacted_count: &mut u32,
) -> TrajectoryExport {
    let summaries = list_summaries_async(home, index, sources, redactor, orchestrator_ids, redacted_count).await;
    let mut details = BTreeMap::new();
    for summary in summaries.iter().take(20) {
        let req = DebugTrajectoryGetRequest {
            id: summary.id.clone(),
            kind: Some(summary.kind),
        };
        let meta = index.sessions.get(&summary.id);
        if let Ok(detail) = build_detail_async(home, meta, sources, redactor, &req, orchestrator_ids, redacted_count).await {
            details.insert(summary.id.clone(), detail);
        }
    }
    TrajectoryExport { summaries, details }
}

async fn redact_jsonl_tree_async(root: &Path, redactor: &Redactor) -> Result<(), ApiError> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().is_some_and(|e| e == "jsonl")
                && let Ok(raw) = tokio::fs::read_to_string(&path).await
            {
                let mut count = 0u32;
                let clean = redactor.redact_owned(raw, &mut count);
                if count > 0 {
                    tokio::fs::write(&path, clean)
                        .await
                        .map_err(|e| ApiError::new(BizCode::InternalError, format!("redact export {}: {e}", path.display())))?;
                }
            }
        }
    }
    Ok(())
}

fn turn_prompt_for_replay(detail: &DebugTrajectoryDetail) -> String {
    detail
        .turns
        .iter()
        .rev()
        .find_map(|t| t.prompt.as_deref().map(str::trim).filter(|p| !p.is_empty()))
        .unwrap_or("Continue from the exported trajectory state.")
        .to_string()
}

pub(crate) async fn export_bundle_async(
    home: &Path,
    meta: Option<&SessionStateMeta>,
    sources: &dyn DebugDataSource,
    redactor: &Redactor,
    req: &DebugTrajectoryExportRequest,
    orchestrator_ids: &[String],
) -> Result<DebugTrajectoryExportResult, ApiError> {
    let get_req = DebugTrajectoryGetRequest {
        id: req.id.clone(),
        kind: req.kind,
    };
    let mut redacted_count = 0u32;
    let detail = build_detail_async(home, meta, sources, redactor, &get_req, orchestrator_ids, &mut redacted_count).await?;
    let safe_id = detail.summary.id.clone();
    let dest_dir = match req.out_dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(custom) => PathBuf::from(custom),
        None => home
            .join("debug-exports")
            .join(format!("trajectory-{safe_id}-{}", detail.summary.updated_at.max(0))),
    };
    tokio::fs::create_dir_all(&dest_dir)
        .await
        .map_err(|e| ApiError::new(BizCode::InternalError, format!("create export dir: {e}")))?;

    let (conv_id, source_kind, entries_exported, tasks_exported, conversations_exported, at_seq) =
        if let Some(durable) = sources.export_durable_conversation_async(&safe_id, &dest_dir).await? {
            redact_jsonl_tree_async(&dest_dir, redactor).await?;
            let ro = Store::open_any_read_only(&dest_dir)
                .await
                .map_err(|e| ApiError::new(BizCode::InternalError, format!("verify exported store: {e}")))?;
            let target_conv = durable.conversation_id.clone();
            let seq = ro
                .read_async(move |r| Box::pin(async move { Ok(r.conversation_async(&target_conv).await.map(|c| (c.next_seq - 1).max(0)).unwrap_or(0)) }))
                .await
                .unwrap_or(0);
            let _ = ro.close().await;
            (
                durable.conversation_id,
                "durable".to_string(),
                durable.entries_exported,
                durable.tasks_exported,
                durable.conversations_exported,
                seq,
            )
        } else {
            let store = Store::jsonl(&dest_dir).map_err(|e| ApiError::new(BizCode::InternalError, format!("open jsonl export store: {e}")))?;
            let root_conv = safe_id.clone();
            let detail_clone = detail.clone();
            let (entries_exported, tasks_exported, conversations_exported, at_seq) = store
                .write_with_async((root_conv.clone(), detail_clone), |tx, (conv_id, detail)| {
                    Box::pin(async move {
                        tx.create_conversation_async(conv_id, &detail.summary.runtime).await?;
                        let mut convs = 1u32;
                        let mut entries = 0u32;
                        let mut tasks = 0u32;
                        if let Some(sys) = &detail.system_prompt
                            && !sys.trim().is_empty()
                        {
                            tx.append_entry_async(conv_id, "pi.system", &json!({ "text": sys })).await?;
                            entries += 1;
                        }
                        for turn in &detail.turns {
                            if let Some(prompt) = &turn.prompt
                                && !prompt.trim().is_empty()
                            {
                                tx.append_entry_async(conv_id, "pi.user", &json!({ "text": prompt })).await?;
                                entries += 1;
                            }
                            if !turn.events.is_empty() {
                                for ev in &turn.events {
                                    match ev.r#type {
                                        SessionEventType::AssistantMessage => {
                                            tx.append_entry_async(conv_id, "pi.assistant", &json!({ "text": ev.text })).await?;
                                            entries += 1;
                                        }
                                        SessionEventType::ToolCall => {
                                            let tool_name = ev.tool.as_deref().unwrap_or("tool");
                                            tx.append_entry_async(
                                                conv_id,
                                                "pi.assistant",
                                                &json!({
                                                    "text": "",
                                                    "toolCalls": [{
                                                        "id": format!("call-{}-{}", turn.index, ev.seq),
                                                        "toolName": tool_name,
                                                        "argsJson": ev.input.as_deref().unwrap_or("{}"),
                                                    }]
                                                }),
                                            )
                                            .await?;
                                            entries += 1;
                                        }
                                        SessionEventType::ToolResult => {
                                            let tool_name = ev.tool.as_deref().unwrap_or("tool");
                                            tx.append_entry_async(
                                                conv_id,
                                                "pi.tool_result",
                                                &json!({
                                                    "toolCallId": format!("call-{}-{}", turn.index, ev.seq),
                                                    "toolName": tool_name,
                                                    "ok": ev.ok.unwrap_or(true),
                                                    "output": ev.output.as_deref().unwrap_or(&ev.text),
                                                }),
                                            )
                                            .await?;
                                            entries += 1;
                                        }
                                        SessionEventType::RunError => {
                                            tx.append_entry_async(conv_id, "pi.error", &json!({ "text": ev.text })).await?;
                                            entries += 1;
                                        }
                                        _ => {}
                                    }
                                }
                            } else if !turn.raw_entries.is_empty() {
                                for raw in &turn.raw_entries {
                                    tx.append_entry_async(
                                        conv_id,
                                        "pi.assistant",
                                        &json!({
                                            "text": raw.summary,
                                            "frameType": raw.frame_type,
                                            "agentPath": raw.agent_path,
                                        }),
                                    )
                                    .await?;
                                    entries += 1;
                                }
                            }
                        }
                        for (idx, node) in detail.subagent_nodes.iter().enumerate() {
                            let child_conv = format!("subagent:{}", node.id);
                            let task_id = format!("task-subagent-{idx}");
                            let mut task = Task::new("subagent", node.status.as_deref().unwrap_or("done"));
                            task.id = task_id.clone();
                            task.conversation_id = conv_id.clone();
                            task.status = TaskStatus::Terminal;
                            task.terminal_reason = node.status.clone().unwrap_or_else(|| "done".into());
                            task.memo = json!({
                                "threadId": node.id,
                                "parentId": node.parent_id,
                                "path": node.path,
                                "label": node.label,
                            });
                            tx.create_task_async(task).await?;
                            tasks += 1;
                            tx.create_owned_conversation_async(&child_conv, &detail.summary.runtime, &task_id).await?;
                            tx.append_entry_async(
                                &child_conv,
                                "pi.assistant",
                                &json!({
                                    "text": format!("subagent {} ({})", node.label, node.path),
                                    "turnCount": node.turn_count,
                                    "eventCount": node.event_count,
                                }),
                            )
                            .await?;
                            convs += 1;
                            entries += 1;
                        }
                        let head = tx.conversation_async(conv_id).await.map(|c| (c.next_seq - 1).max(0)).unwrap_or(0);
                        Ok((entries, tasks, convs, head))
                    })
                })
                .await
                .map_err(|e| ApiError::new(BizCode::InternalError, format!("write trajectory jsonl bundle: {e}")))?;
            store
                .close()
                .await
                .map_err(|e| ApiError::new(BizCode::InternalError, format!("flush trajectory export store: {e}")))?;
            (
                root_conv,
                "trajectory".to_string(),
                entries_exported,
                tasks_exported,
                conversations_exported,
                at_seq,
            )
        };

    let replay_spec_path = dest_dir.join("replay.json");
    let spec = ReplaySpec {
        source_path: dest_dir.clone(),
        conversation_id: Some(conv_id.clone()),
        at_seq,
        prompt: turn_prompt_for_replay(&detail),
        workspace: None,
        profile: EvalProfile::default(),
        graders: Vec::new(),
        timeout_secs: 120,
    };
    let spec_json = serde_json::to_string_pretty(&spec).map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))?;
    tokio::fs::write(&replay_spec_path, spec_json)
        .await
        .map_err(|e| ApiError::new(BizCode::InternalError, format!("write replay spec: {e}")))?;

    let dir_str = dest_dir.display().to_string();
    let replay_str = replay_spec_path.display().to_string();
    Ok(DebugTrajectoryExportResult {
        dir: dir_str.clone(),
        replay_spec_path: replay_str.clone(),
        conversation_id: conv_id,
        source_kind,
        entries_exported,
        tasks_exported,
        conversations_exported,
        inspect_cmd: format!("vibevalley-eval inspect {dir_str}"),
        replay_cmd: format!("vibevalley-eval replay {replay_str}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_turn_splitting_respects_run_start_and_preamble_rules() {
        assert!(should_start_session_turn(SessionEventType::AssistantMessage, None));
        let empty_flags = TurnFlags {
            has_prompt: false,
            has_run_end: false,
            has_non_preamble: false,
        };
        assert!(!should_start_session_turn(SessionEventType::RunStart, Some(empty_flags)));
        assert!(!should_start_session_turn(SessionEventType::UserMessage, Some(empty_flags)));
        assert!(should_start_session_turn(
            SessionEventType::UserMessage,
            Some(TurnFlags {
                has_non_preamble: true,
                ..empty_flags
            })
        ));
        assert!(should_start_session_turn(
            SessionEventType::RunStart,
            Some(TurnFlags {
                has_run_end: true,
                ..empty_flags
            })
        ));
        assert!(!should_start_session_turn(
            SessionEventType::ToolCall,
            Some(TurnFlags {
                has_prompt: true,
                has_run_end: true,
                has_non_preamble: true,
            })
        ));
    }

    #[test]
    fn find_turn_index_matches_latest_span_else_timestamp_floor() {
        let runs = [Some("r1"), Some("r2"), Some("r2")];
        let starts = [100_i64, 200, 300];
        assert_eq!(find_turn_index(3, "r2", |i| runs[i] == Some("r2"), |i| starts[i], 150), 2);
        assert_eq!(find_turn_index(3, "missing", |i| runs[i] == Some("missing"), |i| starts[i], 250), 1);
        assert_eq!(find_turn_index(3, "", |_| false, |i| starts[i], 50), 0);
    }
}
