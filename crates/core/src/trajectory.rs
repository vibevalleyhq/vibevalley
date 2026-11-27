//! Session trajectory folding, step duration pairing, waterfall layout,
//! chat stream grouping, tool input parsing, and telemetry aggregation.

use std::collections::{BTreeMap, HashMap};
use std::sync::LazyLock;

use regex::Regex;
use vibevalley_protocol::{
    ActivityCommandPreview, ActivityEditedFile, ActivityStep, ActivitySummary, BoardTextToken, BoardTextTokenKind, ChatFeedItem, ChatSessionProjection,
    ChatTelemetry, ChatToolStepProjection, EventTokens, SessionEvent, SessionEventType, SessionTelemetry, SessionTrajectoryProjection, TodoChecklist, TodoStep,
    TodoStepStatus, ToolAction, ToolDetails, ToolTarget, TrajectoryLaneSpan, TrajectoryRunView, TrajectoryStepDuration, TrajectoryStepMeta, TrajectorySummary,
    TrajectoryWaterfall, TrajectoryWaterfallLane,
};

pub const DEFAULT_STEP_LIMIT: usize = 240;
const WATERFALL_RATIO_THRESHOLD: f64 = 8.0;
const WATERFALL_MIN_RUN_PX: f64 = 44.0;
const TOOL_INPUT_PATH_KEYS: [&str; 6] = ["path", "file_path", "filePath", "TargetFile", "AbsolutePath", "file"];
const TOOL_INPUT_LINE_KEYS: [&str; 5] = ["line", "start_line", "StartLine", "lineNumber", "offset"];

static WHITESPACE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").expect("valid whitespace regex"));
static PROMPT_SCAFFOLDING_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|\n)(?:【现在】|【现状】|【现状变了】|【群聊】|【输入事件】|\[来源：|这期间群聊里的汇报)").expect("valid scaffold regex")
});
static CHAT_BLOCK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)【群聊】([^\n]*?)里有给你的话：\n(.*?)(?:\n\n你的回答会发在[^\n]*|$)").expect("valid chat block regex"));
static EVENT_BLOCK_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)【输入事件】\n(.*?)(?:\n\n原始载荷用[^\n]*|$)").expect("valid event block regex"));
static SOURCE_HEAD_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[来源：([^\]）]+)\]").expect("valid source head regex"));
static PARENTHETICAL_HINT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^（(?:用户在对话框里选定了|用户选定了仓库：|这句话是用户用语音说的)").expect("valid paren hint regex"));
static ENVELOPE_LINE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\[(?:target=[^\]]+|input=[^\]]+)\s+from=([^\]]+)\](?:（改过）)?\s*(.*)$").expect("valid envelope line regex"));
static BOARD_TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(@[a-zA-Z0-9_-]+|#[0-9]+|\[(?:done|stall)\])").expect("valid board token regex"));

fn collapse_whitespace(s: &str) -> String {
    WHITESPACE_RE.replace_all(s, " ").into_owned()
}

fn is_default_hidden(t: SessionEventType) -> bool {
    matches!(t, SessionEventType::ToolResult | SessionEventType::RunStart | SessionEventType::RunEnd)
}

fn is_chat_hidden(t: SessionEventType) -> bool {
    matches!(
        t,
        SessionEventType::RunStart
            | SessionEventType::ToolResult
            | SessionEventType::PermissionRequest
            | SessionEventType::PermissionResolved
            | SessionEventType::InteractionRequest
            | SessionEventType::RunEnd
    )
}

/// Merges `incoming` events into `log` by `seq` and `revision`, independent of
/// arrival order, capping to `limit` when provided.
pub fn merge_steps(mut log: Vec<SessionEvent>, incoming: &[SessionEvent], limit: Option<usize>, replace_same_revision: bool) -> Vec<SessionEvent> {
    if incoming.is_empty() {
        return log;
    }
    if incoming.len() == 1 {
        let s = &incoming[0];
        if let Some(last) = log.last_mut() {
            if s.seq > last.seq {
                if let Some(cap) = limit
                    && log.len() >= cap
                {
                    let drain_n = log.len() - cap + 1;
                    log.drain(0..drain_n);
                }
                log.push(s.clone());
                return log;
            }
            if s.seq == last.seq {
                let stale = if replace_same_revision {
                    s.revision < last.revision
                } else {
                    s.revision <= last.revision
                };
                if !stale {
                    *last = s.clone();
                }
                return log;
            }
        } else {
            return vec![s.clone()];
        }
    }

    let mut by_seq: BTreeMap<i64, SessionEvent> = log.into_iter().map(|s| (s.seq, s)).collect();
    for s in incoming {
        let replace = by_seq.get(&s.seq).is_none_or(|before| {
            if replace_same_revision {
                s.revision >= before.revision
            } else {
                s.revision > before.revision
            }
        });
        if replace {
            by_seq.insert(s.seq, s.clone());
        }
    }
    let mut all: Vec<SessionEvent> = by_seq.into_values().collect();
    if let Some(cap) = limit
        && all.len() > cap
    {
        all.drain(0..all.len() - cap);
    }
    all
}

fn filter_shown_events(log: &[SessionEvent], hidden: impl Fn(SessionEventType) -> bool) -> Vec<SessionEvent> {
    let mut results: HashMap<i64, &SessionEvent> = HashMap::new();
    for e in log {
        if e.r#type == SessionEventType::ToolResult
            && let Some(call_seq) = e.call
        {
            results.insert(call_seq, e);
        }
    }
    let mut out = Vec::with_capacity(log.len());
    for e in log {
        if hidden(e.r#type) {
            continue;
        }
        if e.r#type == SessionEventType::ToolCall
            && let Some(res) = results.get(&e.seq)
        {
            let mut merged = e.clone();
            if res.output.is_some() {
                merged.output = res.output.clone();
            }
            if res.ok.is_some() {
                merged.ok = res.ok;
            }
            out.push(merged);
            continue;
        }
        out.push(e.clone());
    }
    out
}

/// Folds `tool/result` onto its matching `tool/call` (`call == seq`) and drops run/result wrappers.
pub fn shown_events(log: &[SessionEvent]) -> Vec<SessionEvent> {
    filter_shown_events(log, is_default_hidden)
}

/// Folds `tool/result` onto its matching `tool/call` and drops non-chat lifecycle/prompt wrappers.
pub fn visible_chat_steps(steps: &[SessionEvent]) -> Vec<SessionEvent> {
    filter_shown_events(steps, is_chat_hidden)
}

/// Splits where `run` changes; the first top-level `user/message` becomes `asked`.
pub fn runs_of(steps: &[SessionEvent]) -> Vec<TrajectoryRunView> {
    let mut views: Vec<TrajectoryRunView> = Vec::new();
    for s in steps {
        let same_run = views.last().is_some_and(|v| v.run == s.run);
        if !same_run {
            views.push(TrajectoryRunView {
                run: s.run.clone(),
                asked: None,
                steps: Vec::new(),
            });
        }
        let view = views.last_mut().expect("non-empty run view");
        if view.asked.is_none() && view.steps.is_empty() && s.r#type == SessionEventType::UserMessage && s.under.is_none() {
            view.asked = Some(s.clone());
        } else {
            view.steps.push(s.clone());
        }
    }
    views
}

fn all_of(r: &TrajectoryRunView) -> Vec<&SessionEvent> {
    let mut all = Vec::with_capacity(usize::from(r.asked.is_some()) + r.steps.len());
    if let Some(asked) = &r.asked {
        all.push(asked);
    }
    all.extend(&r.steps);
    all
}

/// Per-step duration in milliseconds: pairs `tool/call` with `tool/result` (or `end_ms`
/// while running) and measures other steps until the next event in their run.
pub fn step_durations_of(log: &[SessionEvent], end_ms: i64) -> Vec<TrajectoryStepDuration> {
    let mut durations: BTreeMap<i64, i64> = BTreeMap::new();
    let shown = shown_events(log);
    let views = runs_of(&shown);

    for (idx, view) in views.iter().enumerate() {
        let all = all_of(view);
        let last_time = all.last().map_or(end_ms, |e| e.time);
        let run_end = if idx + 1 == views.len() { end_ms.max(last_time) } else { last_time };
        for (i, step) in all.iter().enumerate() {
            if matches!(
                step.r#type,
                SessionEventType::LlmUsage | SessionEventType::RunError | SessionEventType::ToolCall
            ) {
                continue;
            }
            let until = all.get(i + 1).map_or(run_end, |next| next.time);
            durations.insert(step.seq, (until - step.time).max(0));
        }
    }

    let mut open_calls: BTreeMap<i64, (i64, Option<&str>)> = BTreeMap::new();
    let mut run_ends: HashMap<Option<&str>, i64> = HashMap::new();
    for e in log {
        if matches!(e.r#type, SessionEventType::RunStart | SessionEventType::RunEnd) {
            continue;
        }
        let run_key = e.run.as_deref();
        let entry = run_ends.entry(run_key).or_insert(0);
        if e.time > *entry {
            *entry = e.time;
        }
        if e.r#type == SessionEventType::ToolCall {
            open_calls.insert(e.seq, (e.time, run_key));
        } else if e.r#type == SessionEventType::ToolResult
            && let Some(call_seq) = e.call
            && let Some((call_time, _)) = open_calls.remove(&call_seq)
        {
            durations.insert(call_seq, (e.time - call_time).max(0));
        }
    }

    let last_run = views.last().and_then(|v| v.run.as_deref());
    for (seq, (call_time, call_run)) in open_calls {
        let observed_end = run_ends.get(&call_run).copied().unwrap_or(call_time);
        let fallback_end = if call_run == last_run { end_ms.max(observed_end) } else { observed_end };
        durations.insert(seq, (fallback_end - call_time).max(0));
    }

    durations
        .into_iter()
        .map(|(seq, duration_ms)| TrajectoryStepDuration { seq, duration_ms })
        .collect()
}

/// Allocates horizontal pixel widths for waterfall runs; dampens extreme duration ratios
/// so short runs remain legible.
pub fn waterfall_widths(durations: &[f64], room: f64) -> Vec<f64> {
    if room <= 0.0 || !room.is_finite() || durations.is_empty() {
        return Vec::new();
    }
    let safe: Vec<f64> = durations.iter().map(|&d| if d.is_finite() && d > 0.0 { d } else { 0.0 }).collect();
    let total: f64 = safe.iter().sum();
    if total <= 0.0 {
        return vec![room / safe.len() as f64; safe.len()];
    }

    let positive_count = safe.iter().filter(|&&d| d > 0.0).count();
    let min_pos = safe.iter().copied().filter(|&d| d > 0.0).fold(f64::INFINITY, f64::min);
    let max_pos = safe.iter().copied().filter(|&d| d > 0.0).fold(0.0_f64, f64::max);
    if max_pos / min_pos <= WATERFALL_RATIO_THRESHOLD {
        return safe.into_iter().map(|d| (room * d) / total).collect();
    }

    let min_run_px = WATERFALL_MIN_RUN_PX.min(room / safe.len() as f64);
    let extra_room = room - (positive_count as f64) * min_run_px;
    let weights: Vec<f64> = safe.iter().map(|&d| if d > 0.0 { d.sqrt() } else { 0.0 }).collect();
    let weight_total: f64 = weights.iter().sum();
    safe.iter()
        .zip(weights.iter())
        .map(|(&d, &w)| if d > 0.0 { min_run_px + (extra_room * w) / weight_total } else { 0.0 })
        .collect()
}

/// Builds waterfall run intervals and lane spans from `log`.
pub fn waterfall_of(log: &[SessionEvent], end_ms: i64) -> TrajectoryWaterfall {
    let top: Vec<SessionEvent> = log
        .iter()
        .filter(|e| e.under.is_none() && !matches!(e.r#type, SessionEventType::RunStart | SessionEventType::RunEnd))
        .cloned()
        .collect();
    let views = runs_of(&top);
    let mut runs: Vec<[i64; 2]> = Vec::new();
    let mut spans: Vec<TrajectoryLaneSpan> = Vec::new();

    for (g, view) in views.iter().enumerate() {
        let steps = all_of(view);
        let (Some(first), Some(last)) = (steps.first(), steps.last()) else {
            continue;
        };
        let from = first.time;
        let to = if g + 1 == views.len() && end_ms > last.time { end_ms } else { last.time };
        runs.push([from, to]);

        let mut calls: BTreeMap<i64, i64> = BTreeMap::new();
        let mut waiting = from;
        let mut open: Option<(i64, i64)> = None;
        let mut prev = from;

        let close_open = |at: i64, open: &mut Option<(i64, i64)>, spans: &mut Vec<TrajectoryLaneSpan>| {
            if let Some((start, seq)) = open.take() {
                spans.push(TrajectoryLaneSpan {
                    lane: TrajectoryWaterfallLane::Model,
                    start,
                    end: if at < start { start } else { at },
                    seq,
                });
            }
        };

        for (i, e) in steps.iter().enumerate() {
            match e.r#type {
                SessionEventType::UserMessage => {
                    spans.push(TrajectoryLaneSpan {
                        lane: TrajectoryWaterfallLane::Asked,
                        start: e.time,
                        end: steps.get(i + 1).map_or(to, |next| next.time),
                        seq: e.seq,
                    });
                    waiting = e.time;
                }
                SessionEventType::AssistantThinking | SessionEventType::AssistantMessage | SessionEventType::ToolCall => {
                    if open.is_none() {
                        open = Some((waiting, e.seq));
                    }
                    if e.r#type == SessionEventType::ToolCall {
                        calls.insert(e.seq, e.time);
                    }
                }
                SessionEventType::LlmUsage | SessionEventType::RunError => {
                    close_open(e.time, &mut open, &mut spans);
                    waiting = e.time;
                }
                SessionEventType::ToolResult => {
                    close_open(prev, &mut open, &mut spans);
                    if let Some(call_seq) = e.call
                        && let Some(start) = calls.remove(&call_seq)
                    {
                        spans.push(TrajectoryLaneSpan {
                            lane: TrajectoryWaterfallLane::Tool,
                            start,
                            end: e.time,
                            seq: call_seq,
                        });
                    }
                    waiting = e.time;
                }
                SessionEventType::MemoryRecalled => {
                    if open.is_none() {
                        waiting = e.time;
                    }
                }
                SessionEventType::LlmRetry
                | SessionEventType::PermissionRequest
                | SessionEventType::PermissionResolved
                | SessionEventType::InteractionRequest
                | SessionEventType::InteractionResolved
                | SessionEventType::RunEnd
                | SessionEventType::RunStart => {}
            }
            prev = e.time;
        }
        close_open(to, &mut open, &mut spans);
        for (seq, start) in calls {
            spans.push(TrajectoryLaneSpan {
                lane: TrajectoryWaterfallLane::Tool,
                start,
                end: to,
                seq,
            });
        }
    }

    TrajectoryWaterfall { runs, spans }
}

/// Computes trajectory footer summary metrics (runs, visible non-usage steps, lane ms, token sums).
pub fn summary_of(log: &[SessionEvent], end_ms: i64) -> TrajectorySummary {
    let shown = shown_events(log);
    let fall = waterfall_of(log, end_ms);
    let sum_lane = |lane: TrajectoryWaterfallLane| -> i64 { fall.spans.iter().filter(|s| s.lane == lane).map(|s| s.end - s.start).sum() };
    let mut input = 0_i64;
    let mut cache_read = 0_i64;
    let mut output = 0_i64;
    for e in log {
        if let Some(tok) = &e.tokens {
            input += tok.input;
            cache_read += tok.cache_read;
            output += tok.output;
        }
    }
    TrajectorySummary {
        runs: runs_of(&shown).len() as i64,
        steps: shown.iter().filter(|e| e.r#type != SessionEventType::LlmUsage).count() as i64,
        model_ms: sum_lane(TrajectoryWaterfallLane::Model),
        tool_ms: sum_lane(TrajectoryWaterfallLane::Tool),
        input,
        cache_read,
        output,
    }
}

/// Formats a `tool/call`'s input: `$ <command>` when it has a JSON `command` field,
/// pretty-printed JSON for objects, otherwise raw trimmed text.
pub fn readable_input(step: &SessionEvent) -> String {
    let raw = step.input.as_deref().map_or("", str::trim);
    if raw.is_empty() {
        return String::new();
    }
    if let Ok(obj) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(raw) {
        if let Some(cmd) = obj.get("command").and_then(|v| v.as_str()) {
            return format!("$ {cmd}");
        }
        if let Ok(pretty) = serde_json::to_string_pretty(&obj) {
            return pretty;
        }
    }
    raw.to_string()
}

fn clean_envelope_line(line: &str) -> String {
    let trimmed = line.trim();
    if let Some(cap) = ENVELOPE_LINE_RE.captures(trimmed) {
        let from = cap.get(1).map_or("", |m| m.as_str()).trim();
        let text = cap.get(2).map_or("", |m| m.as_str()).trim();
        if !from.is_empty() && !text.is_empty() {
            return format!("{from}: {text}");
        }
        return if !text.is_empty() { text.to_string() } else { from.to_string() };
    }
    trimmed.to_string()
}

fn first_payload_line(block: &str) -> String {
    block
        .split('\n')
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('│'))
        .map(clean_envelope_line)
        .unwrap_or_default()
}

fn is_scaffold_block_start(line: &str) -> bool {
    line.starts_with("【现状】") || line.starts_with("【现状变了】") || line.starts_with("这期间群聊里的汇报")
}

fn is_situation_line(line: &str) -> bool {
    line.starts_with("用户的语言：")
        || line.starts_with("仓库（工作目录")
        || line.starts_with("可以派的帮工：")
        || line.starts_with("各频道里在场的帮工：")
        || line.starts_with("你正在回话的地方：")
        || line.starts_with("- ")
        || line.starts_with("+ ")
        || line.starts_with("− ")
        || line.starts_with("[target=")
        || line.starts_with('│')
}

/// Strips internal orchestrator prompt-injection scaffolding for collapsed trajectory rows.
/// Returns empty string when only scaffolding was present so callers can localize a context-update label.
pub fn collapsed_step_summary_raw(step_type: SessionEventType, body: &str) -> String {
    if step_type != SessionEventType::UserMessage || !PROMPT_SCAFFOLDING_RE.is_match(body) {
        return collapse_whitespace(body).trim().to_string();
    }
    if let Some(pos) = body.rfind("用户说：") {
        let after = &body[pos + "用户说：".len()..];
        let said = collapse_whitespace(after).trim().to_string();
        if !said.is_empty() {
            return said;
        }
    }
    if let Some(cap) = CHAT_BLOCK_RE.captures(body) {
        let target = cap.get(1).map_or("", |m| m.as_str()).trim();
        let first = first_payload_line(cap.get(2).map_or("", |m| m.as_str()));
        if !first.is_empty() {
            let one = collapse_whitespace(&first).trim().to_string();
            return if target.is_empty() { one } else { format!("{target} · {one}") };
        }
    }
    if let Some(cap) = EVENT_BLOCK_RE.captures(body) {
        let first = first_payload_line(cap.get(1).map_or("", |m| m.as_str()));
        if !first.is_empty() {
            return collapse_whitespace(&first).trim().to_string();
        }
    }

    let mut source_label = String::new();
    let mut kept: Vec<String> = Vec::new();
    let mut skipping_block = false;
    for raw_line in body.split('\n') {
        let line = raw_line.trim();
        if line.is_empty() {
            if skipping_block {
                skipping_block = false;
            }
            continue;
        }
        if line.starts_with("【现在】") {
            continue;
        }
        if is_scaffold_block_start(line) {
            skipping_block = true;
            continue;
        }
        if let Some(cap) = SOURCE_HEAD_RE.captures(line) {
            skipping_block = false;
            let kind = cap.get(1).map_or("", |m| m.as_str()).trim();
            if !kind.is_empty() && kind != "用户" && kind != "群聊" {
                source_label = kind.to_string();
            }
            continue;
        }
        if skipping_block {
            if is_situation_line(line) || raw_line.starts_with("  ") {
                continue;
            }
            skipping_block = false;
        }
        if PARENTHETICAL_HINT_RE.is_match(line) {
            continue;
        }
        kept.push(clean_envelope_line(line));
    }

    let summary = collapse_whitespace(&kept.join(" ")).trim().to_string();
    if !summary.is_empty() {
        return if source_label.is_empty() {
            summary
        } else {
            format!("{source_label} · {summary}")
        };
    }
    source_label
}

/// Projects the full trajectory payload (`shown`, `runs`, `waterfall`, `summary`, `step_durations`, `step_meta`, `telemetry`).
pub fn project_trajectory(events: &[SessionEvent], end_ms: i64) -> SessionTrajectoryProjection {
    let shown = shown_events(events);
    let runs = runs_of(&shown);
    let waterfall = waterfall_of(events, end_ms);
    let summary = summary_of(events, end_ms);
    let step_durations = step_durations_of(events, end_ms);
    let duration_map: HashMap<i64, i64> = step_durations.iter().map(|d| (d.seq, d.duration_ms)).collect();
    let step_meta = shown
        .iter()
        .map(|s| {
            let readable = readable_input(s);
            let collapsed = (s.r#type == SessionEventType::UserMessage).then(|| collapsed_step_summary_raw(s.r#type, &s.text));
            TrajectoryStepMeta {
                seq: s.seq,
                duration_ms: duration_map.get(&s.seq).copied().unwrap_or(0),
                readable_input: (!readable.is_empty()).then_some(readable),
                collapsed_summary: collapsed,
            }
        })
        .collect();
    let telemetry: SessionTelemetry = crate::projection::fold_session_telemetry(events).unwrap_or_default();
    SessionTrajectoryProjection {
        shown,
        runs,
        waterfall,
        summary,
        step_durations,
        step_meta,
        telemetry,
    }
}

fn first_string_field(obj: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> Option<String> {
    for &key in keys {
        if let Some(val) = obj.get(key).and_then(|v| v.as_str()) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn first_positive_int(obj: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> Option<i64> {
    for &key in keys {
        if let Some(val) = obj.get(key).and_then(|v| v.as_f64())
            && val.is_finite()
            && val > 0.0
        {
            return Some(val.floor() as i64);
        }
    }
    None
}

/// Extracts target file path, optional line number, and edit-diff capability from a tool step.
pub fn extract_tool_target(action: Option<ToolAction>, tool: Option<&str>, input: Option<&str>, text: &str) -> Option<ToolTarget> {
    let mut found_path: Option<String> = None;
    let mut found_line: Option<i64> = None;

    if let Some(raw) = input
        && let Ok(obj) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(raw)
    {
        found_path = first_string_field(&obj, &TOOL_INPUT_PATH_KEYS);
        found_line = first_positive_int(&obj, &TOOL_INPUT_LINE_KEYS);
    }

    if found_path.is_none()
        && matches!(action, Some(ToolAction::ReadFile | ToolAction::EditFile))
        && let Some(token) = text.split_whitespace().next()
        && (token.contains('/') || token.contains('.'))
    {
        let mut parts = token.splitn(2, ':');
        if let Some(raw_path) = parts.next().filter(|p| !p.is_empty()) {
            found_path = Some(raw_path.to_string());
        }
        if let Some(raw_line) = parts.next()
            && let Ok(n) = raw_line.parse::<f64>()
            && n.is_finite()
            && n > 0.0
        {
            found_line = Some(n.floor() as i64);
        }
    }

    let path = found_path?;
    let tool_lower = tool.unwrap_or("").to_lowercase();
    let can_diff = action == Some(ToolAction::EditFile)
        || tool_lower.contains("edit")
        || tool_lower.contains("write")
        || tool_lower.contains("replace")
        || tool_lower.contains("patch");

    Some(ToolTarget {
        path,
        line: found_line,
        can_diff,
    })
}

fn normalize_todo_status(raw: Option<&str>) -> Option<TodoStepStatus> {
    let s = raw?.trim().to_lowercase();
    match s.as_str() {
        "done" | "completed" | "complete" => Some(TodoStepStatus::Done),
        "in_progress" | "in-progress" | "working" | "running" => Some(TodoStepStatus::InProgress),
        "pending" | "todo" | "not_started" => Some(TodoStepStatus::Pending),
        "skipped" | "cancelled" | "canceled" => Some(TodoStepStatus::Skipped),
        "failed" | "error" => Some(TodoStepStatus::Failed),
        _ => None,
    }
}

/// Parses `update_steps`, `TodoWrite`, or `update_plan` payloads into a structured checklist.
pub fn parse_todo_checklist(seq: i64, event_type: SessionEventType, tool: Option<&str>, input: Option<&str>) -> Option<TodoChecklist> {
    if event_type != SessionEventType::ToolCall {
        return None;
    }
    let raw = input.map_or("", str::trim);
    if raw.is_empty() {
        return None;
    }
    let obj = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(raw).ok()?;
    let tool_lower = tool.unwrap_or("").to_lowercase();
    let is_todo_tool = tool_lower.contains("todo") || tool_lower.contains("plan") || tool_lower.contains("steps");

    let candidates = obj
        .get("steps")
        .and_then(|v| v.as_array())
        .or_else(|| is_todo_tool.then(|| obj.get("todos").and_then(|v| v.as_array())).flatten())
        .or_else(|| is_todo_tool.then(|| obj.get("plan").and_then(|v| v.as_array())).flatten())?;

    if candidates.is_empty() {
        return None;
    }

    let mut steps = Vec::new();
    for item in candidates {
        let Some(map) = item.as_object() else {
            continue;
        };
        let Some(title) = first_string_field(map, &["title", "content", "step", "label"]) else {
            continue;
        };
        let status = normalize_todo_status(map.get("status").and_then(|v| v.as_str())).unwrap_or(TodoStepStatus::Pending);
        steps.push(TodoStep { title, status });
    }
    if steps.is_empty() {
        return None;
    }

    let mut done_count = 0_i64;
    let mut in_progress_count = 0_i64;
    let mut failed_count = 0_i64;
    for s in &steps {
        match s.status {
            TodoStepStatus::Done => done_count += 1,
            TodoStepStatus::InProgress => in_progress_count += 1,
            TodoStepStatus::Failed => failed_count += 1,
            TodoStepStatus::Pending | TodoStepStatus::Skipped => {}
        }
    }
    let active_step = steps
        .iter()
        .find(|s| s.status == TodoStepStatus::InProgress)
        .or_else(|| steps.iter().find(|s| s.status == TodoStepStatus::Pending))
        .cloned();
    let total_count = steps.len() as i64;

    Some(TodoChecklist {
        seq,
        steps,
        done_count,
        in_progress_count,
        failed_count,
        total_count,
        active_step,
    })
}

/// Returns the latest todo checklist present in a transcript.
pub fn latest_session_todos(steps: &[SessionEvent]) -> Option<TodoChecklist> {
    steps
        .iter()
        .rev()
        .find_map(|s| parse_todo_checklist(s.seq, s.r#type, s.tool.as_deref(), s.input.as_deref()))
}

fn is_intermediate_step(step: &SessionEvent) -> bool {
    matches!(
        step.r#type,
        SessionEventType::AssistantThinking | SessionEventType::ToolCall | SessionEventType::MemoryRecalled
    )
}

fn extract_command_text(step: &SessionEvent) -> Option<String> {
    if step.r#type != SessionEventType::ToolCall || step.action != Some(ToolAction::RunCommand) {
        return None;
    }
    let raw = step.input.as_deref().map_or("", str::trim);
    if !raw.is_empty()
        && let Ok(obj) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(raw)
        && let Some(cmd) = first_string_field(&obj, &["command", "CommandLine", "cmd"])
    {
        return Some(collapse_whitespace(&cmd).trim().to_string());
    }
    let collapsed = collapse_whitespace(&step.text);
    let fallback = collapsed.trim().strip_prefix('$').map_or(collapsed.trim(), str::trim_start);
    (!fallback.is_empty()).then(|| fallback.to_string())
}

fn summarize_activity(run: &[ActivityStep], end_time: i64) -> ActivitySummary {
    let mut thinking_count = 0_i64;
    let mut read_count = 0_i64;
    let mut search_count = 0_i64;
    let mut edit_count = 0_i64;
    let mut command_count = 0_i64;
    let mut other_tool_count = 0_i64;
    let mut running_count = 0_i64;
    let mut failed_count = 0_i64;
    let mut edited_order: Vec<String> = Vec::new();
    let mut edited_by_path: HashMap<String, ActivityEditedFile> = HashMap::new();
    let mut latest_running_cmd: Option<ActivityCommandPreview> = None;
    let mut latest_any_cmd: Option<ActivityCommandPreview> = None;

    for ActivityStep { step, .. } in run {
        if step.r#type == SessionEventType::AssistantThinking {
            thinking_count += 1;
            continue;
        }
        if step.r#type != SessionEventType::ToolCall {
            continue;
        }
        match step.ok {
            None => running_count += 1,
            Some(false) => failed_count += 1,
            Some(true) => {}
        }

        match step.action {
            Some(ToolAction::ReadFile) => read_count += 1,
            Some(ToolAction::Search | ToolAction::Web) => search_count += 1,
            Some(ToolAction::EditFile) => edit_count += 1,
            Some(ToolAction::RunCommand) => {
                command_count += 1;
                if let Some(command) = extract_command_text(step) {
                    let preview = ActivityCommandPreview {
                        seq: step.seq,
                        command,
                        running: step.ok.is_none(),
                        failed: step.ok == Some(false),
                    };
                    if preview.running {
                        latest_running_cmd = Some(preview.clone());
                    }
                    latest_any_cmd = Some(preview);
                }
            }
            Some(ToolAction::Mcp | ToolAction::Wait | ToolAction::Other) | None => other_tool_count += 1,
        }

        if let Some(target) = extract_tool_target(step.action, step.tool.as_deref(), step.input.as_deref(), &step.text)
            && target.can_diff
        {
            if let Some(existing) = edited_by_path.get_mut(&target.path) {
                if target.line.is_some() {
                    existing.line = target.line;
                }
            } else {
                edited_order.push(target.path.clone());
                edited_by_path.insert(
                    target.path.clone(),
                    ActivityEditedFile {
                        path: target.path,
                        line: target.line,
                        can_diff: true,
                    },
                );
            }
        }
    }

    let first = run.first();
    let last = run.last();
    let started_at = first.map_or(end_time, |a| a.step.time);
    let duration_ms = match (first, last) {
        (Some(_), Some(_)) => (end_time - started_at).max(0),
        _ => 0,
    };
    let edited_files = edited_order.into_iter().filter_map(|p| edited_by_path.remove(&p)).collect();

    ActivitySummary {
        total_steps: run.len() as i64,
        thinking_count,
        read_count,
        search_count,
        edit_count,
        command_count,
        other_tool_count,
        total_tools: read_count + search_count + edit_count + command_count + other_tool_count,
        running_count,
        failed_count,
        started_at,
        duration_ms,
        edited_files,
        latest_command: latest_running_cmd.or(latest_any_cmd),
    }
}

/// Groups consecutive intermediate steps into an `Activity` cluster when 2+ appear back-to-back.
pub fn group_chat_steps(steps: &[SessionEvent]) -> Vec<ChatFeedItem> {
    let mut items: Vec<ChatFeedItem> = Vec::new();
    let mut buffer: Vec<ActivityStep> = Vec::new();
    let mut buffer_end_idx: Option<usize> = None;

    let flush = |buf: &mut Vec<ActivityStep>, end_idx: &mut Option<usize>, items: &mut Vec<ChatFeedItem>| {
        let Some(idx) = end_idx.take() else {
            buf.clear();
            return;
        };
        let (Some(first), Some(last)) = (buf.first(), buf.last()) else {
            buf.clear();
            return;
        };
        let trailing = idx + 1 == steps.len();
        if buf.len() == 1 {
            items.push(ChatFeedItem::Step {
                key: format!("s:{}", first.step.seq),
                step: first.step.clone(),
                duration_ms: first.duration_ms,
                trailing,
            });
            buf.clear();
        } else {
            let end_time = steps.get(idx + 1).map_or(last.step.time, |after| after.time);
            let moved = std::mem::take(buf);
            let first_seq = moved[0].step.seq;
            let summary = summarize_activity(&moved, end_time);
            items.push(ChatFeedItem::Activity {
                key: format!("g:{first_seq}"),
                steps: moved,
                summary,
                trailing,
            });
        }
    };

    for (i, step) in steps.iter().enumerate() {
        let duration_ms = steps.get(i + 1).map(|next| (next.time - step.time).max(0));
        if is_intermediate_step(step) {
            buffer.push(ActivityStep {
                step: step.clone(),
                duration_ms,
            });
            buffer_end_idx = Some(i);
        } else {
            flush(&mut buffer, &mut buffer_end_idx, &mut items);
            items.push(ChatFeedItem::Step {
                key: format!("s:{}", step.seq),
                step: step.clone(),
                duration_ms,
                trailing: i + 1 == steps.len(),
            });
        }
    }
    flush(&mut buffer, &mut buffer_end_idx, &mut items);
    items
}

/// Extracts scannable headline, formatted input, and output line count for a tool step.
pub fn format_tool_details(step: &SessionEvent) -> ToolDetails {
    let raw = step.input.as_deref().map_or("", str::trim);
    let obj = (!raw.is_empty())
        .then(|| serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(raw).ok())
        .flatten();
    let target = extract_tool_target(step.action, step.tool.as_deref(), step.input.as_deref(), &step.text);
    let output = step.output.as_deref().unwrap_or("");
    let output_lines = if output.is_empty() { 0 } else { output.split('\n').count() as i64 };

    let mut formatted_input = obj
        .as_ref()
        .and_then(|m| serde_json::to_string_pretty(m).ok())
        .unwrap_or_else(|| raw.to_string());

    let mut headline = target.as_ref().map(|t| t.path.clone()).unwrap_or_else(|| {
        if !step.text.is_empty() {
            step.text.clone()
        } else {
            step.tool.clone().unwrap_or_default()
        }
    });

    if let Some(todo) = parse_todo_checklist(step.seq, step.r#type, step.tool.as_deref(), step.input.as_deref()) {
        headline = match todo.active_step {
            Some(active) => format!("{}/{} · {}", todo.done_count, todo.total_count, active.title),
            None => format!("{}/{}", todo.done_count, todo.total_count),
        };
    } else if step.action == Some(ToolAction::RunCommand)
        && let Some(m) = &obj
        && let Some(cmd) = first_string_field(m, &["command", "CommandLine", "cmd"])
    {
        headline = format!("$ {cmd}");
        let cwd = first_string_field(m, &["cwd", "Cwd", "workdir", "WorkDir"]);
        formatted_input = match cwd {
            Some(c) => format!("$ {cmd}\ncwd: {c}"),
            None => format!("$ {cmd}"),
        };
    } else if step.action == Some(ToolAction::Search)
        && let Some(m) = &obj
        && let Some(query) = first_string_field(m, &["query", "Query", "pattern", "Pattern"])
    {
        let in_path = first_string_field(m, &["path", "SearchPath", "directory", "dir", "Directory"]);
        headline = match in_path {
            Some(p) => format!("{query} in {p}"),
            None => query,
        };
    } else if matches!(step.action, Some(ToolAction::ReadFile | ToolAction::EditFile))
        && let Some(t) = &target
    {
        let start_line = t
            .line
            .or_else(|| obj.as_ref().and_then(|m| first_positive_int(m, &["StartLine", "start_line", "line"])));
        let end_line = obj.as_ref().and_then(|m| first_positive_int(m, &["EndLine", "end_line"]));
        headline = match (start_line, end_line) {
            (Some(s), Some(e)) if e > s => format!("{}:{s}-{e}", t.path),
            (Some(s), _) => format!("{}:{s}", t.path),
            _ => t.path.clone(),
        };
    } else if step.action == Some(ToolAction::Web)
        && let Some(m) = &obj
        && let Some(web_target) = first_string_field(m, &["url", "Url", "query", "Query"])
    {
        headline = web_target;
    }

    ToolDetails {
        headline,
        formatted_input,
        output_lines,
    }
}

/// Aggregates token usage, context fill, turns, and tool counts across session steps.
pub fn compute_telemetry(steps: &[SessionEvent], latest_tokens: Option<&EventTokens>, default_window: i64) -> ChatTelemetry {
    let mut cached_read = 0_i64;
    let mut total_input = 0_i64;
    let mut output = 0_i64;
    let mut reasoning = 0_i64;
    let mut context_used = 0_i64;
    let mut context_window = default_window;
    let mut turns = 0_i64;
    let mut tool_count = 0_i64;
    let mut has_data = false;

    let mut fold = |tok: &EventTokens| {
        cached_read += tok.cache_read.max(0);
        let step_total_in = tok.input.max(tok.cache_read);
        total_input += step_total_in;
        output += tok.output.max(0);
        reasoning += tok.reasoning.unwrap_or(0).max(0);
        context_used = match tok.context_used {
            Some(used) if used > 0 => used,
            _ => step_total_in,
        };
        if let Some(win) = tok.context_window
            && win > 0
        {
            context_window = win;
        }
    };

    for step in steps {
        if step.r#type == SessionEventType::UserMessage && step.under.is_none() {
            turns += 1;
        }
        if step.r#type == SessionEventType::ToolCall {
            tool_count += 1;
        }
        if let Some(tok) = &step.tokens {
            has_data = true;
            fold(tok);
        }
    }

    if !has_data {
        if let Some(tok) = latest_tokens {
            has_data = true;
            fold(tok);
        }
    } else if let Some(tok) = latest_tokens {
        if let Some(used) = tok.context_used
            && used > 0
        {
            context_used = used;
        }
        if let Some(win) = tok.context_window
            && win > 0
        {
            context_window = win;
        }
    }

    let uncached_input = (total_input - cached_read).max(0);
    let effective_window = context_window.max(1);
    let context_pct = (((context_used as f64 / effective_window as f64) * 100.0).round() as i64).min(100);
    let cache_hit_pct = if total_input > 0 {
        (((cached_read as f64 / total_input as f64) * 100.0).round() as i64).min(100)
    } else {
        0
    };

    ChatTelemetry {
        cached_read,
        uncached_input,
        total_input,
        output,
        reasoning,
        context_used,
        context_window: effective_window,
        context_pct,
        cache_hit_pct,
        turns,
        tool_count,
        has_data,
    }
}

/// Splits swarm message text into plain text, `@mention`, `#seq`, and `[done]`/`[stall]` tokens.
pub fn parse_board_tokens(text: &str) -> Vec<BoardTextToken> {
    let mut tokens = Vec::new();
    let mut cursor = 0usize;
    for m in BOARD_TOKEN_RE.find_iter(text) {
        if m.start() > cursor {
            tokens.push(BoardTextToken {
                kind: BoardTextTokenKind::Text,
                value: text[cursor..m.start()].to_string(),
            });
        }
        let hit = m.as_str();
        let kind = if hit.starts_with('@') {
            BoardTextTokenKind::Mention
        } else if hit.starts_with('#') {
            BoardTextTokenKind::Seq
        } else {
            BoardTextTokenKind::Tag
        };
        tokens.push(BoardTextToken { kind, value: hit.to_string() });
        cursor = m.end();
    }
    if cursor < text.len() {
        tokens.push(BoardTextToken {
            kind: BoardTextTokenKind::Text,
            value: text[cursor..].to_string(),
        });
    }
    if tokens.is_empty() {
        tokens.push(BoardTextToken {
            kind: BoardTextTokenKind::Text,
            value: text.to_string(),
        });
    }
    tokens
}

/// Computes the complete workspace chat projection from event history and optional snapshot tokens.
pub fn project_chat_session(events: &[SessionEvent], latest_tokens: Option<&EventTokens>, default_window: i64) -> ChatSessionProjection {
    let visible_steps = visible_chat_steps(events);
    let feed_items = group_chat_steps(&visible_steps);
    let latest_todos = latest_session_todos(&visible_steps);
    let telemetry = compute_telemetry(events, latest_tokens, default_window);
    let tool_entries = visible_steps
        .iter()
        .filter(|s| s.r#type == SessionEventType::ToolCall)
        .map(|s| ChatToolStepProjection {
            seq: s.seq,
            target: extract_tool_target(s.action, s.tool.as_deref(), s.input.as_deref(), &s.text),
            details: format_tool_details(s),
            todo: parse_todo_checklist(s.seq, s.r#type, s.tool.as_deref(), s.input.as_deref()),
        })
        .collect();
    ChatSessionProjection {
        visible_steps,
        feed_items,
        latest_todos,
        telemetry,
        tool_entries,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(seq: i64, r#type: SessionEventType) -> SessionEvent {
        SessionEvent {
            seq,
            revision: 1,
            time: 1_700_000_000_000 + seq * 1_000,
            r#type,
            run: None,
            call: None,
            under: None,
            thread_id: None,
            text: String::new(),
            action: None,
            action_text: None,
            tool: None,
            input: None,
            output: None,
            ok: None,
            tokens: None,
            connection: None,
            permission: None,
            interaction: None,
            interaction_resolution: None,
        }
    }

    #[test]
    fn waterfall_widths_handles_empty_zero_mild_and_extreme_ratios() {
        assert!(waterfall_widths(&[], 400.0).is_empty());
        assert!(waterfall_widths(&[100.0, 200.0], 0.0).is_empty());
        assert!(waterfall_widths(&[100.0, 200.0], -10.0).is_empty());

        assert_eq!(waterfall_widths(&[0.0, 0.0, 0.0], 300.0), vec![100.0, 100.0, 100.0]);
        assert_eq!(waterfall_widths(&[-5.0, 0.0], 200.0), vec![100.0, 100.0]);

        let mild = waterfall_widths(&[10_000.0, 40_000.0, 30_000.0], 800.0);
        assert!((mild[0] - 100.0).abs() < 1e-6);
        assert!((mild[1] - 400.0).abs() < 1e-6);
        assert!((mild[2] - 300.0).abs() < 1e-6);

        let eleven_seconds = 11_000.0;
        let seven_hours = ((7 * 60 + 36) * 60_000) as f64;
        let widths = waterfall_widths(&[eleven_seconds, seven_hours], 560.0);
        assert_eq!(widths.len(), 2);
        assert!(widths[0] >= 44.0);
        assert!(widths[1] > widths[0]);
        assert!((widths.iter().sum::<f64>() - 560.0).abs() < 1e-6);

        let with_zero = waterfall_widths(&[0.0, eleven_seconds, seven_hours], 560.0);
        assert_eq!(with_zero[0], 0.0);
        assert!(with_zero[1] >= 44.0);
        assert!(with_zero[2] > with_zero[1]);
        assert!((with_zero.iter().sum::<f64>() - 560.0).abs() < 1e-6);

        let tight = waterfall_widths(&[1_000.0, 1_000_000.0], 60.0);
        assert!(tight[0] >= 30.0);
        assert!((tight.iter().sum::<f64>() - 60.0).abs() < 1e-6);
    }

    #[test]
    fn collapsed_step_summary_strips_orchestrator_scaffolding() {
        let user_prompt = [
            "【现在】2026-11-26 21:00",
            "【现状】",
            "用户的语言：zh（你说的话、写给用户和帮工的都用它）",
            "仓库（工作目录 /var/folders/xx/work 下的文件夹）：app",
            "[来源：用户]",
            "用户说：帮我把登录超时修一下",
        ]
        .join("\n");
        assert_eq!(collapsed_step_summary_raw(SessionEventType::UserMessage, &user_prompt), "帮我把登录超时修一下");

        let chat_prompt = [
            "【现在】2026-11-26 21:05",
            "【现状变了】",
            "+ - 小林（在忙）",
            "[来源：群聊]（帮工写的是它的汇报）",
            "【群聊】#general 里有给你的话：",
            "[target=#general msg=12 from=小林] 所有单元测试都通过了",
            "  │ [附件 log.txt：/tmp/log.txt]",
            "",
            "你的回答会发在 #general。",
        ]
        .join("\n");
        assert_eq!(
            collapsed_step_summary_raw(SessionEventType::UserMessage, &chat_prompt),
            "#general · 小林: 所有单元测试都通过了"
        );

        let cron_prompt = [
            "【现在】2026-11-26 09:00",
            "【现状】",
            "仓库（工作目录 /var/folders/xx/work 下的文件夹）：app",
            "",
            "[来源：定时]",
            "每天九点跑一遍回归测试",
        ]
        .join("\n");
        assert_eq!(
            collapsed_step_summary_raw(SessionEventType::UserMessage, &cron_prompt),
            "定时 · 每天九点跑一遍回归测试"
        );

        let scaffolding_only = "【现在】2026-11-26 09:00\n【现状】\n用户的语言：zh\n仓库（工作目录 /var/folders/xx 下的文件夹）：（还没有）";
        assert_eq!(collapsed_step_summary_raw(SessionEventType::UserMessage, scaffolding_only), "");
        assert_eq!(
            collapsed_step_summary_raw(SessionEventType::UserMessage, "Fix login timeout"),
            "Fix login timeout"
        );
    }

    #[test]
    fn step_durations_pair_tool_calls_with_results() {
        let mut s1 = step(1, SessionEventType::UserMessage);
        s1.run = Some("r1".into());
        s1.time = 1_000;
        let mut s2 = step(2, SessionEventType::AssistantThinking);
        s2.run = Some("r1".into());
        s2.time = 1_500;
        let mut s3 = step(3, SessionEventType::ToolCall);
        s3.run = Some("r1".into());
        s3.time = 2_000;
        let mut s4 = step(4, SessionEventType::ToolCall);
        s4.run = Some("r1".into());
        s4.time = 2_200;
        let mut s5 = step(5, SessionEventType::ToolResult);
        s5.run = Some("r1".into());
        s5.call = Some(3);
        s5.time = 2_800;
        let mut s6 = step(6, SessionEventType::ToolResult);
        s6.run = Some("r1".into());
        s6.call = Some(4);
        s6.time = 3_700;
        let mut s7 = step(7, SessionEventType::AssistantMessage);
        s7.run = Some("r1".into());
        s7.time = 4_000;
        let mut s8 = step(8, SessionEventType::ToolCall);
        s8.run = Some("r2".into());
        s8.time = 5_000;

        let map: BTreeMap<i64, i64> = step_durations_of(&[s1, s2, s3, s4, s5, s6, s7, s8], 7_500)
            .into_iter()
            .map(|d| (d.seq, d.duration_ms))
            .collect();
        assert_eq!(map[&1], 500);
        assert_eq!(map[&2], 500);
        assert_eq!(map[&3], 800);
        assert_eq!(map[&4], 1_500);
        assert_eq!(map[&7], 0);
        assert_eq!(map[&8], 2_500);
    }

    #[test]
    fn extracts_tool_targets_telemetry_board_tokens_and_chat_groups() {
        let target1 = extract_tool_target(
            Some(ToolAction::ReadFile),
            Some("read_file"),
            Some(r#"{"file_path":"crates/runtime/src/oar/acp/mod.rs","start_line":136}"#),
            "",
        );
        assert_eq!(
            target1,
            Some(ToolTarget {
                path: "crates/runtime/src/oar/acp/mod.rs".into(),
                line: Some(136),
                can_diff: false,
            })
        );

        let target2 = extract_tool_target(
            Some(ToolAction::EditFile),
            Some("replace_file_content"),
            Some(r#"{"TargetFile":"apps/mac/src/panes.rs","StartLine":42}"#),
            "",
        );
        assert_eq!(
            target2,
            Some(ToolTarget {
                path: "apps/mac/src/panes.rs".into(),
                line: Some(42),
                can_diff: true,
            })
        );

        let target3 = extract_tool_target(Some(ToolAction::ReadFile), None, None, "apps/mac/ui/workspace/ChatPane.tsx:88");
        assert_eq!(
            target3,
            Some(ToolTarget {
                path: "apps/mac/ui/workspace/ChatPane.tsx".into(),
                line: Some(88),
                can_diff: false,
            })
        );

        assert!(extract_tool_target(Some(ToolAction::RunCommand), None, Some(r#"{"command":"cargo test"}"#), "").is_none());

        let mut u = step(1, SessionEventType::UserMessage);
        u.text = "Upgrade ACP".into();
        let mut tc = step(2, SessionEventType::ToolCall);
        tc.action = Some(ToolAction::ReadFile);
        let mut tr = step(3, SessionEventType::ToolResult);
        tr.call = Some(2);
        tr.ok = Some(true);
        let mut lu = step(4, SessionEventType::LlmUsage);
        lu.tokens = Some(EventTokens {
            input: 76_000,
            cache_read: 62_400,
            output: 6_800,
            cache_write: None,
            reasoning: Some(2_100),
            context_used: Some(76_000),
            context_window: Some(200_000),
        });
        let tel = compute_telemetry(&[u, tc, tr, lu], None, 200_000);
        assert!(tel.has_data);
        assert_eq!(tel.turns, 1);
        assert_eq!(tel.tool_count, 1);
        assert_eq!(tel.cached_read, 62_400);
        assert_eq!(tel.uncached_input, 13_600);
        assert_eq!(tel.output, 6_800);
        assert_eq!(tel.reasoning, 2_100);
        assert_eq!(tel.context_pct, 38);
        assert_eq!(tel.cache_hit_pct, 82);

        let tokens = parse_board_tokens("@verifier [done] Verified #185 with @all");
        assert_eq!(
            tokens,
            vec![
                BoardTextToken {
                    kind: BoardTextTokenKind::Mention,
                    value: "@verifier".into(),
                },
                BoardTextToken {
                    kind: BoardTextTokenKind::Text,
                    value: " ".into(),
                },
                BoardTextToken {
                    kind: BoardTextTokenKind::Tag,
                    value: "[done]".into(),
                },
                BoardTextToken {
                    kind: BoardTextTokenKind::Text,
                    value: " Verified ".into(),
                },
                BoardTextToken {
                    kind: BoardTextTokenKind::Seq,
                    value: "#185".into(),
                },
                BoardTextToken {
                    kind: BoardTextTokenKind::Text,
                    value: " with ".into(),
                },
                BoardTextToken {
                    kind: BoardTextTokenKind::Mention,
                    value: "@all".into(),
                },
            ]
        );
    }

    #[test]
    fn groups_chat_steps_and_parses_todo_checklists() {
        let mut s5 = step(5, SessionEventType::AssistantThinking);
        s5.text = "Planning edits".into();
        let mut s6 = step(6, SessionEventType::ToolCall);
        s6.action = Some(ToolAction::ReadFile);
        s6.input = Some(r#"{"path":"src/a.rs","start_line":10}"#.into());
        s6.ok = Some(true);
        let mut s7 = step(7, SessionEventType::ToolCall);
        s7.action = Some(ToolAction::Search);
        s7.input = Some(r#"{"query":"Handshake","path":"src"}"#.into());
        s7.ok = Some(true);
        let mut s8 = step(8, SessionEventType::ToolCall);
        s8.action = Some(ToolAction::EditFile);
        s8.tool = Some("replace_file_content".into());
        s8.input = Some(r#"{"path":"src/a.rs","StartLine":15}"#.into());
        s8.ok = Some(true);
        let mut s9 = step(9, SessionEventType::ToolCall);
        s9.action = Some(ToolAction::EditFile);
        s9.tool = Some("replace_file_content".into());
        s9.input = Some(r#"{"path":"src/a.rs","StartLine":42}"#.into());
        s9.ok = Some(true);
        let mut s10 = step(10, SessionEventType::ToolCall);
        s10.action = Some(ToolAction::RunCommand);
        s10.input = Some(r#"{"command":"cargo test"}"#.into());
        s10.ok = Some(false);

        let items = group_chat_steps(&[
            step(1, SessionEventType::UserMessage),
            step(2, SessionEventType::AssistantThinking),
            step(3, SessionEventType::AssistantMessage),
            step(4, SessionEventType::UserMessage),
            s5,
            s6,
            s7,
            s8,
            s9,
            s10,
        ]);
        assert_eq!(items.len(), 5);
        match &items[4] {
            ChatFeedItem::Activity { key, summary, trailing, .. } => {
                assert_eq!(key, "g:5");
                assert!(*trailing);
                assert_eq!(summary.total_steps, 6);
                assert_eq!(summary.thinking_count, 1);
                assert_eq!(summary.read_count, 1);
                assert_eq!(summary.search_count, 1);
                assert_eq!(summary.edit_count, 2);
                assert_eq!(summary.command_count, 1);
                assert_eq!(summary.total_tools, 5);
                assert_eq!(summary.failed_count, 1);
                assert_eq!(summary.duration_ms, 5_000);
                assert_eq!(
                    summary.edited_files,
                    vec![ActivityEditedFile {
                        path: "src/a.rs".into(),
                        line: Some(42),
                        can_diff: true,
                    }]
                );
                assert_eq!(
                    summary.latest_command,
                    Some(ActivityCommandPreview {
                        seq: 10,
                        command: "cargo test".into(),
                        running: false,
                        failed: true,
                    })
                );
            }
            other => panic!("expected activity cluster, got {other:?}"),
        }

        let todo_step = SessionEvent {
            tool: Some("update_steps".into()),
            action: Some(ToolAction::Other),
            input: Some(
                r#"{"steps":[{"status":"done","title":"Step 1"},{"status":"in_progress","title":"Step 2"},{"status":"failed","title":"Step 3"}]}"#.into(),
            ),
            ..step(1, SessionEventType::ToolCall)
        };
        let checklist = parse_todo_checklist(todo_step.seq, todo_step.r#type, todo_step.tool.as_deref(), todo_step.input.as_deref()).expect("todo checklist");
        assert_eq!(checklist.done_count, 1);
        assert_eq!(checklist.in_progress_count, 1);
        assert_eq!(checklist.failed_count, 1);
        assert_eq!(checklist.total_count, 3);
        assert_eq!(format_tool_details(&todo_step).headline, "1/3 · Step 2");
    }

    #[test]
    fn merge_steps_handles_ascending_appends_stale_revisions_and_limit_eviction() {
        let mut e1 = step(1, SessionEventType::AssistantMessage);
        e1.revision = 1;
        let mut e2 = step(2, SessionEventType::AssistantMessage);
        e2.revision = 1;

        let initial = merge_steps(vec![], &[e1, e2], Some(DEFAULT_STEP_LIMIT), false);
        assert_eq!(initial.iter().map(|s| s.seq).collect::<Vec<_>>(), vec![1, 2]);

        let mut e2_rev2 = step(2, SessionEventType::AssistantMessage);
        e2_rev2.revision = 2;
        let replaced = merge_steps(initial, &[e2_rev2.clone()], Some(DEFAULT_STEP_LIMIT), false);
        assert_eq!(replaced.last().map(|s| s.revision), Some(2));

        let same_rev = merge_steps(replaced.clone(), &[e2_rev2], Some(DEFAULT_STEP_LIMIT), false);
        assert_eq!(same_rev.last().map(|s| s.revision), Some(2));

        let mut e2_rev1 = step(2, SessionEventType::AssistantMessage);
        e2_rev1.revision = 1;
        let stale_rev = merge_steps(replaced.clone(), &[e2_rev1], Some(DEFAULT_STEP_LIMIT), false);
        assert_eq!(stale_rev.last().map(|s| s.revision), Some(2));

        let e3 = step(3, SessionEventType::AssistantMessage);
        let with_three = merge_steps(replaced, &[e3], Some(DEFAULT_STEP_LIMIT), false);
        let with_mid = merge_steps(with_three, &[step(0, SessionEventType::UserMessage)], Some(DEFAULT_STEP_LIMIT), false);
        assert_eq!(with_mid.iter().map(|s| s.seq).collect::<Vec<_>>(), vec![0, 1, 2, 3]);

        let mut log = Vec::new();
        for i in 1..=260 {
            log = merge_steps(log, &[step(i, SessionEventType::ToolCall)], Some(DEFAULT_STEP_LIMIT), false);
        }
        assert_eq!(log.len(), DEFAULT_STEP_LIMIT);
        assert_eq!(log.first().map(|s| s.seq), Some(21));
        assert_eq!(log.last().map(|s| s.seq), Some(260));
    }
}
