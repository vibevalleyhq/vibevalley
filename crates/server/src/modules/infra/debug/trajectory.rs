//! Read-only trajectory inspector across IssueSession, WorkspaceChat, and
//! Orchestrator trajectories, joining SQLite `session_event` rows, live
//! `SpaceState`, and on-disk `oar-voyage/3` JSONL records.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use vibevalley_protocol::{
    ApiError, BizCode, DebugTrajectoryDetail, DebugTrajectoryGetRequest, DebugTrajectoryKind, DebugTrajectoryRawEntry, DebugTrajectorySummary,
    DebugTrajectoryTurn, EventTokens, Issue, ORCHESTRATOR_RUNTIME, Phase, Session, SessionController, SessionEvent, SessionEventType, SpaceState,
};
use vibevalley_runtime::oar::voyage::{Header as VoyageHeader, Kind as VoyageKind, Reader as VoyageReader, Record as VoyageRecord};
use vibevalley_runtime::oar::{EventKind as OarEventKind, StopReason, Usage as OarUsage};

use super::DebugDataSource;
use super::collector::clip_utf8;
use super::redact::Redactor;

const RAW_PAYLOAD_MAX_BYTES: usize = 4096;
const SILENT_ERROR_MARKERS: [&str; 6] = [
    "QUOTA_EXHAUSTED",
    "INVALID_THINKING_SIGNATURE",
    "RESOURCE_EXHAUSTED",
    "RATE_LIMIT_EXCEEDED",
    "OVERLOADED_ERROR",
    "CONTEXT_LENGTH_EXCEEDED",
];

fn is_safe_id(id: &str) -> bool {
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

pub(crate) fn classify_session(
    id: &str,
    session: Option<&Session>,
    issues: &[Issue],
    orchestrator_ids: &[String],
    voyage_header: Option<&VoyageHeader>,
) -> DebugTrajectoryKind {
    if session.is_some_and(|s| s.is_orchestrator() || s.controller == SessionController::Orchestrator)
        || orchestrator_ids.iter().any(|o| o == id)
        || voyage_header.is_some_and(|h| h.runtime == ORCHESTRATOR_RUNTIME)
    {
        return DebugTrajectoryKind::Orchestrator;
    }
    if session.is_some_and(|s| s.is_board_worker() || s.issue_id().is_some()) || issues.iter().any(|i| i.executions().any(|e| e.session() == id)) {
        return DebugTrajectoryKind::IssueSession;
    }
    DebugTrajectoryKind::WorkspaceChat
}

fn voyage_record_path(home: &Path, id: &str) -> Option<PathBuf> {
    if !is_safe_id(id) {
        return None;
    }
    let candidates = [
        home.join("records").join(format!("{id}.jsonl")),
        home.join("issues").join("records").join(format!("{id}.jsonl")),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

fn scan_record_ids(home: &Path) -> Vec<String> {
    let mut ids = Vec::new();
    for dir in [home.join("records"), home.join("issues").join("records")] {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
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

fn load_voyage(home: &Path, id: &str) -> Option<LoadedVoyage> {
    let path = voyage_record_path(home, id)?;
    let file = File::open(&path).ok()?;
    let mut reader = VoyageReader::new(BufReader::new(file)).ok()?;
    let header = reader.header.clone();
    let mut records = Vec::new();
    while let Ok(Some(rec)) = reader.read() {
        records.push(rec);
    }
    Some(LoadedVoyage { header, records })
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

fn tokens_from_oar_usage(usage: &OarUsage) -> Option<EventTokens> {
    if usage.input_tokens.is_none()
        && usage.output_tokens.is_none()
        && usage.cache_read_tokens.is_none()
        && usage.cache_write_tokens.is_none()
        && usage.reasoning_tokens.is_none()
        && usage.context_used_tokens.is_none()
        && usage.context_window_tokens.is_none()
    {
        return None;
    }
    let to_i64 = |v: Option<u64>| v.and_then(|n| i64::try_from(n).ok());
    Some(EventTokens {
        input: to_i64(usage.input_tokens).unwrap_or(0),
        cache_read: to_i64(usage.cache_read_tokens).unwrap_or(0),
        output: to_i64(usage.output_tokens).unwrap_or(0),
        cache_write: to_i64(usage.cache_write_tokens),
        reasoning: to_i64(usage.reasoning_tokens),
        context_used: to_i64(usage.context_used_tokens),
        context_window: to_i64(usage.context_window_tokens),
    })
}

fn tokens_from_voyage_record(rec: &VoyageRecord) -> Option<EventTokens> {
    let mut total: Option<EventTokens> = None;
    for native in &rec.native_events {
        if let OarEventKind::TurnFinished { usage, .. } = &native.kind
            && let Some(t) = tokens_from_oar_usage(usage)
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

fn detect_text_silent_errors(text: &str, redactor: &Redactor, count: &mut u32, out: &mut Vec<String>) {
    if text.is_empty() {
        return;
    }
    let clean = redactor.redact_str(text, count);
    if contains_step_type_17(&clean) {
        push_unique_error(out, "step_type=17 error step detected".into());
    }
    let upper = clean.to_ascii_uppercase();
    for marker in SILENT_ERROR_MARKERS {
        if upper.contains(marker) {
            let (snippet, _) = clip_utf8(&clean, 160);
            push_unique_error(out, format!("{marker}: {snippet}"));
        }
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

fn detect_session_event_errors(ev: &SessionEvent, redactor: &Redactor, count: &mut u32, out: &mut Vec<String>) {
    match ev.r#type {
        SessionEventType::RunError => {
            let msg = if ev.text.trim().is_empty() {
                "run/error".to_string()
            } else {
                redactor.redact_str(&ev.text, count)
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
    detect_text_silent_errors(&ev.text, redactor, count, out);
    if let Some(output) = &ev.output {
        detect_text_silent_errors(output, redactor, count, out);
    }
}

fn detect_voyage_record_errors(rec: &VoyageRecord, redactor: &Redactor, count: &mut u32, out: &mut Vec<String>) {
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
        detect_text_silent_errors(&ev.to_string(), redactor, count, out);
    }
    if let Some(marker) = &rec.marker {
        if value_has_step_type_17(marker) {
            push_unique_error(out, "step_type=17 error marker detected".into());
        }
        if matches!(marker.get("name").and_then(Value::as_str), Some("error" | "silent_error")) {
            push_unique_error(out, redactor.redact_str(&marker.to_string(), count));
        }
    }
    if !rec.raw.is_empty() {
        let raw_text = String::from_utf8_lossy(&rec.raw);
        if let Ok(parsed) = serde_json::from_str::<Value>(&raw_text)
            && value_has_step_type_17(&parsed)
        {
            push_unique_error(out, "step_type=17 error frame detected".into());
        }
        detect_text_silent_errors(&raw_text, redactor, count, out);
    }
}

fn voyage_kind_str(kind: VoyageKind) -> &'static str {
    match kind {
        VoyageKind::Frame => "frame",
        VoyageKind::Control => "control",
        VoyageKind::Marker => "marker",
    }
}

fn raw_entry_of(rec: &VoyageRecord, redactor: &Redactor, count: &mut u32) -> DebugTrajectoryRawEntry {
    let raw_payload = if !rec.raw.is_empty() {
        Some(String::from_utf8_lossy(&rec.raw).into_owned())
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
        serde_json::to_string(&Value::Object(obj)).ok()
    } else {
        None
    };

    let (payload, original_bytes, truncated) = match raw_payload {
        Some(raw) => {
            let clean = redactor.redact_str(&raw, count);
            let original_bytes = u32::try_from(clean.len()).unwrap_or(u32::MAX);
            let (clipped, truncated) = clip_utf8(&clean, RAW_PAYLOAD_MAX_BYTES);
            (Some(clipped.to_string()), original_bytes, truncated)
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

fn build_turns(events: Vec<SessionEvent>, voyage: Option<&LoadedVoyage>, redactor: &Redactor, count: &mut u32) -> (Vec<DebugTrajectoryTurn>, BTreeSet<String>) {
    let mut subagent_paths = BTreeSet::new();
    let mut turns: Vec<DebugTrajectoryTurn> = Vec::new();
    let mut turn_runs: Vec<Option<String>> = Vec::new();

    if !events.is_empty() {
        for raw_ev in events {
            let ev = redactor.redact_session_event(raw_ev, count);
            if let Some(tid) = &ev.thread_id
                && !tid.is_empty()
            {
                subagent_paths.insert(redactor.redact_str(tid, count));
            }
            let start_new = match ev.r#type {
                SessionEventType::RunStart => {
                    turns.is_empty()
                        || turns
                            .last()
                            .is_some_and(|t| t.prompt.is_some() || t.events.iter().any(|e| e.r#type == SessionEventType::RunEnd))
                }
                SessionEventType::UserMessage => {
                    turns.is_empty()
                        || turns.last().is_some_and(|t| {
                            t.prompt.is_some()
                                || t.events
                                    .iter()
                                    .any(|e| !matches!(e.r#type, SessionEventType::RunStart | SessionEventType::MemoryRecalled))
                        })
                }
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
                | SessionEventType::RunEnd => turns.is_empty(),
            };
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
                });
                turn_runs.push(ev.run.clone());
            } else if ev.r#type == SessionEventType::UserMessage
                && let Some(cur) = turns.last_mut()
                && cur.prompt.is_none()
            {
                cur.prompt = Some(ev.text.clone());
            }
            if let Some(cur) = turns.last_mut() {
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
                detect_session_event_errors(&ev, redactor, count, &mut cur.silent_errors);
                cur.events.push(ev);
            }
        }
    }

    if let Some(loaded) = voyage {
        if turns.is_empty() {
            // Pure voyage-only trajectory (no SessionEvents in SQLite yet).
            let mut active_span: Option<String> = None;
            for rec in &loaded.records {
                if !rec.agent_path.is_empty() {
                    subagent_paths.insert(redactor.redact_str(&rec.agent_path.join("/"), count));
                }
                let prompt = voyage_turn_prompt(rec).map(|p| redactor.redact_str(&p, count));
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
                    });
                    if !rec.span_id.is_empty() {
                        active_span = Some(rec.span_id.clone());
                    }
                } else if !rec.span_id.is_empty() && active_span.is_none() {
                    active_span = Some(rec.span_id.clone());
                }
                if let Some(cur) = turns.last_mut() {
                    let t = rec.received_at as i64;
                    cur.ended_at = Some(cur.ended_at.map_or(t, |end| end.max(t)));
                    if let Some(tokens) = tokens_from_voyage_record(rec) {
                        merge_tokens(&mut cur.tokens, &tokens);
                    }
                    detect_voyage_record_errors(rec, redactor, count, &mut cur.silent_errors);
                    cur.raw_entries.push(raw_entry_of(rec, redactor, count));
                }
            }
        } else {
            // Attach voyage records to the best-matching SessionEvent turn by span_id or timestamp.
            for rec in &loaded.records {
                if !rec.agent_path.is_empty() {
                    subagent_paths.insert(redactor.redact_str(&rec.agent_path.join("/"), count));
                }
                let idx = if !rec.span_id.is_empty()
                    && let Some(pos) = turn_runs.iter().rposition(|r| r.as_deref() == Some(rec.span_id.as_str()))
                {
                    pos
                } else {
                    let ts = rec.received_at as i64;
                    turns.iter().rposition(|t| t.started_at <= ts).unwrap_or(0)
                };
                if let Some(cur) = turns.get_mut(idx) {
                    if cur.tokens.is_none()
                        && let Some(tokens) = tokens_from_voyage_record(rec)
                    {
                        merge_tokens(&mut cur.tokens, &tokens);
                    }
                    detect_voyage_record_errors(rec, redactor, count, &mut cur.silent_errors);
                    cur.raw_entries.push(raw_entry_of(rec, redactor, count));
                }
            }
        }
    }

    for turn in &mut turns {
        turn.duration_ms = turn.ended_at.map(|end| (end - turn.started_at).max(0));
    }
    (turns, subagent_paths)
}

fn title_for(id: &str, session: Option<&Session>, issues: &[Issue]) -> String {
    if let Some(s) = session {
        if let Some(issue_id) = s.issue_id()
            && let Some(issue) = issues.iter().find(|i| i.id == issue_id)
        {
            return format!("#{} {}", issue.number, issue.title);
        }
        if !s.name.trim().is_empty() {
            return s.name.clone();
        }
    }
    if let Some(issue) = issues.iter().find(|i| i.executions().any(|e| e.session() == id)) {
        return format!("#{} {}", issue.number, issue.title);
    }
    id.to_string()
}

pub fn build_detail(
    home: &Path,
    state: &SpaceState,
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
    let session = state.sessions.iter().find(|s| s.id == id);
    let events = sources.trajectory_events(id);
    let voyage = load_voyage(home, id);
    let is_orchestrator_profile = orchestrator_ids.iter().any(|o| o == id);
    let in_issue_history = state.issues.iter().any(|i| i.executions().any(|e| e.session() == id));
    if session.is_none() && events.is_empty() && voyage.is_none() && !is_orchestrator_profile && !in_issue_history {
        return Err(ApiError::new(BizCode::SessionNotFound, format!("trajectory not found: {id}")));
    }

    let kind = req
        .kind
        .unwrap_or_else(|| classify_session(id, session, &state.issues, orchestrator_ids, voyage.as_ref().map(|v| &v.header)));
    let event_count = events.len() as u32;
    let voyage_record_count = voyage.as_ref().map(|v| v.records.len() as u32).unwrap_or(0);
    let has_voyage_record = voyage.is_some();

    let raw_system_prompt = sources
        .system_prompt(id, kind)
        .or_else(|| voyage.as_ref().and_then(extract_voyage_system_prompt));
    let system_prompt = redactor.redact_opt_str(raw_system_prompt, redacted_count);

    let (turns, subagent_set) = build_turns(events, voyage.as_ref(), redactor, redacted_count);

    let mut total_tokens: Option<EventTokens> = None;
    let mut updated_at = session.map(|s| s.last_run.as_ref().map_or(s.hired_at, |r| r.at.max(s.hired_at))).unwrap_or(0);
    for turn in &turns {
        if let Some(tokens) = &turn.tokens {
            merge_tokens(&mut total_tokens, tokens);
        }
        updated_at = updated_at.max(turn.ended_at.unwrap_or(turn.started_at));
    }
    if let Some(loaded) = &voyage {
        updated_at = updated_at.max(loaded.header.created_at as i64);
        if let Some(last) = loaded.records.last() {
            updated_at = updated_at.max(last.received_at as i64);
        }
    }

    let runtime = session
        .map(|s| s.runtime.clone())
        .or_else(|| voyage.as_ref().map(|v| v.header.runtime.clone()).filter(|r| !r.is_empty()))
        .unwrap_or_else(|| {
            if kind == DebugTrajectoryKind::Orchestrator {
                ORCHESTRATOR_RUNTIME.to_string()
            } else {
                "unknown".to_string()
            }
        });
    let status = session.map(|s| phase_status_str(&s.phase)).unwrap_or("recorded").to_string();
    let title = redactor.redact_str(&title_for(id, session, &state.issues), redacted_count);
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
        voyage_record_count,
    })
}

pub fn list_summaries(
    home: &Path,
    state: &SpaceState,
    sources: &dyn DebugDataSource,
    redactor: &Redactor,
    orchestrator_ids: &[String],
    redacted_count: &mut u32,
) -> Vec<DebugTrajectorySummary> {
    let mut ids = BTreeSet::new();
    for s in &state.sessions {
        ids.insert(s.id.clone());
    }
    for issue in &state.issues {
        for exec in issue.executions() {
            ids.insert(exec.session().to_string());
        }
    }
    for id in orchestrator_ids {
        ids.insert(id.clone());
    }
    for id in sources.open_trajectory_ids() {
        ids.insert(id);
    }
    for id in scan_record_ids(home) {
        ids.insert(id);
    }

    let mut out = Vec::new();
    for id in ids {
        let req = DebugTrajectoryGetRequest { id, kind: None };
        if let Ok(detail) = build_detail(home, state, sources, redactor, &req, orchestrator_ids, redacted_count) {
            out.push(detail.summary);
        }
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| a.id.cmp(&b.id)));
    out
}

pub fn export_snapshot(
    home: &Path,
    state: &SpaceState,
    sources: &dyn DebugDataSource,
    redactor: &Redactor,
    orchestrator_ids: &[String],
    redacted_count: &mut u32,
) -> Value {
    let summaries = list_summaries(home, state, sources, redactor, orchestrator_ids, redacted_count);
    let mut details = BTreeMap::new();
    for summary in summaries.iter().take(20) {
        let req = DebugTrajectoryGetRequest {
            id: summary.id.clone(),
            kind: Some(summary.kind),
        };
        if let Ok(detail) = build_detail(home, state, sources, redactor, &req, orchestrator_ids, redacted_count) {
            details.insert(summary.id.clone(), detail);
        }
    }
    json!({
        "summaries": summaries,
        "details": details,
    })
}
