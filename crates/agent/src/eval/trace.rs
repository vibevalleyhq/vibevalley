//! Read-only trajectory analysis, compact timelines, and self-contained HTML export
//! over SQLite or JSONL durable stores (`Store::open_any_read_only`).

use std::collections::{BTreeMap, HashSet};
use std::fmt::Write as _;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::core::doc::{CONVERSATION_SCOPE, GovernanceDoc, UsageDoc, UsageTotals, read_doc};
use crate::durable::{Entry, Error, Result, Store, TaskStatus, TelemetryEvent, read_telemetry_jsonl};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceMetrics {
    pub conversation_id: String,
    pub entry_count: usize,
    pub turns: usize,
    pub user_messages: usize,
    pub compactions: usize,
    pub tool_calls_total: usize,
    pub tool_calls_by_name: BTreeMap<String, usize>,
    pub tool_errors_total: usize,
    pub tool_error_rate: f64,
    pub repeated_tool_loops: usize,
    pub usage: UsageTotals,
    pub cost_usd: f64,
    pub task_total: usize,
    pub task_completed: usize,
    pub task_failed: usize,
    pub task_aborted: usize,
    pub max_restart_count: u32,
    pub subagent_conversations: usize,
    pub rubric_verdicts: usize,
    pub final_rubric_satisfied: Option<bool>,
    pub duration_ms: i64,
    pub phase_counts: BTreeMap<String, usize>,
    pub phase_duration_ms: BTreeMap<String, i64>,
}

/// Picks an explicit conversation ID, or the first top-level non-grader conversation in the store.
pub async fn resolve_root_conversation(store: &Store, conv_id: Option<&str>) -> Result<String> {
    let conv_id = conv_id.map(str::to_owned);
    store
        .read_async(move |r| {
            Box::pin(async move {
                if let Some(id) = conv_id {
                    r.conversation_async(&id).await?;
                    return Ok(id);
                }
                let convs = r.conversations_async().await?;
                if let Some(root) = convs.iter().find(|c| c.owner_task_id.is_empty() && !c.id.contains(":grader:")) {
                    return Ok(root.id.clone());
                }
                convs
                    .into_iter()
                    .next()
                    .map(|c| c.id)
                    .ok_or_else(|| Error::Missing("no conversations found".into()))
            })
        })
        .await
}

/// Computes trajectory, usage, task-graph, and telemetry metrics from an open `Store`.
pub async fn analyze_store(store: &Store, conv_id: &str, telemetry: &[TelemetryEvent]) -> Result<TraceMetrics> {
    let entries = collect_full_entries(store, conv_id).await?;
    let graph = store.task_graph(Some(conv_id)).await?;

    let mut conv_ids = HashSet::from([conv_id.to_owned()]);
    let mut subagent_convs = HashSet::new();
    let mut task_ids = HashSet::new();
    let mut task_completed = 0usize;
    let mut task_failed = 0usize;
    let mut task_aborted = 0usize;
    let mut max_restart_count = 0u32;

    for node in &graph.nodes {
        task_ids.insert(node.id.clone());
        conv_ids.insert(node.conversation_id.clone());
        if node.conversation_id != conv_id {
            subagent_convs.insert(node.conversation_id.clone());
        }
        for owned in &node.owned_conversations {
            conv_ids.insert(owned.clone());
            if owned != conv_id {
                subagent_convs.insert(owned.clone());
            }
        }
        max_restart_count = max_restart_count.max(node.restart_count);
        if node.aborted {
            task_aborted += 1;
        } else if node.status == TaskStatus::Terminal {
            if node.terminal_reason == "completed" {
                task_completed += 1;
            } else {
                task_failed += 1;
            }
        }
    }

    let conv_ids_read = conv_ids.clone();
    let task_ids_read = task_ids.clone();
    let conv_id_read = conv_id.to_owned();
    let (usage, gov) = store
        .read_async(move |r| {
            Box::pin(async move {
                let mut total = UsageTotals::default();
                for cid in &conv_ids_read {
                    let u = read_doc::<UsageDoc>(r, CONVERSATION_SCOPE, cid).await?;
                    total.add(u);
                }
                for tid in &task_ids_read {
                    let u = read_doc::<UsageDoc>(r, crate::core::doc::TASK_SCOPE, tid).await?;
                    total.add(u);
                }
                let gov = read_doc::<GovernanceDoc>(r, CONVERSATION_SCOPE, &conv_id_read).await?;
                Ok((total, gov))
            })
        })
        .await?;

    let mut turns = 0usize;
    let mut user_messages = 0usize;
    let mut compactions = 0usize;
    let mut tool_calls_total = 0usize;
    let mut tool_calls_by_name: BTreeMap<String, usize> = BTreeMap::new();
    let mut tool_errors_total = 0usize;
    let mut repeated_tool_loops = 0usize;
    let mut prev_call: Option<(String, String)> = None;
    let mut min_ts: Option<i64> = None;
    let mut max_ts: Option<i64> = None;

    for entry in &entries {
        if entry.created_at_ms > 0 {
            min_ts = Some(min_ts.map_or(entry.created_at_ms, |m| m.min(entry.created_at_ms)));
            max_ts = Some(max_ts.map_or(entry.created_at_ms, |m| m.max(entry.created_at_ms)));
        }
        match entry.kind.as_str() {
            "pi.user" => user_messages += 1,
            "pi.compaction" => compactions += 1,
            "pi.assistant" => {
                turns += 1;
                if let Some(calls) = entry.payload.get("toolCalls").and_then(Value::as_array) {
                    for call in calls {
                        let name = call["toolName"].as_str().unwrap_or("unknown").to_owned();
                        tool_calls_total += 1;
                        *tool_calls_by_name.entry(name.clone()).or_default() += 1;
                        let canonical_args = canonical_call_args(call);
                        let sig = (name, canonical_args);
                        if prev_call.as_ref() == Some(&sig) {
                            repeated_tool_loops += 1;
                        }
                        prev_call = Some(sig);
                    }
                }
            }
            "pi.tool_result" if entry.payload["ok"] == Value::Bool(false) => {
                tool_errors_total += 1;
            }
            _ => {}
        }
    }

    for node in &graph.nodes {
        if node.created_at_ms > 0 {
            min_ts = Some(min_ts.map_or(node.created_at_ms, |m| m.min(node.created_at_ms)));
        }
        if node.updated_at_ms > 0 {
            max_ts = Some(max_ts.map_or(node.updated_at_ms, |m| m.max(node.updated_at_ms)));
        }
    }

    let mut phase_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut phase_duration_ms: BTreeMap<String, i64> = BTreeMap::new();
    let mut tel_min_ts: Option<i64> = None;
    let mut tel_max_ts: Option<i64> = None;

    for ev in telemetry {
        let (matches_conv, at_ms) = match ev {
            TelemetryEvent::Submit { conversation_id, at_ms, .. } => (conv_ids.contains(conversation_id), *at_ms),
            TelemetryEvent::Submission { conversation_id, at_ms, .. } => (conv_ids.contains(conversation_id), *at_ms),
            TelemetryEvent::Entry { conversation_id, at_ms, .. } => (conv_ids.contains(conversation_id), *at_ms),
            TelemetryEvent::Checkpoint { task_id, at_ms, .. } => (task_ids.contains(task_id), *at_ms),
            TelemetryEvent::Phase {
                task_id,
                conversation_id,
                phase,
                duration_ms,
                at_ms,
                ..
            } => {
                let matches = conv_ids.contains(conversation_id) || task_ids.contains(task_id);
                if matches {
                    *phase_counts.entry(phase.clone()).or_default() += 1;
                    *phase_duration_ms.entry(phase.clone()).or_default() += *duration_ms;
                }
                (matches, *at_ms)
            }
        };
        if matches_conv && at_ms > 0 {
            tel_min_ts = Some(tel_min_ts.map_or(at_ms, |m| m.min(at_ms)));
            tel_max_ts = Some(tel_max_ts.map_or(at_ms, |m| m.max(at_ms)));
        }
    }

    let duration_ms = match (min_ts, max_ts, tel_min_ts, tel_max_ts) {
        (Some(a), Some(b), Some(ta), Some(tb)) => (b - a).max(tb - ta).max(0),
        (_, _, Some(ta), Some(tb)) => (tb - ta).max(0),
        (Some(a), Some(b), _, _) => (b - a).max(0),
        _ => 0,
    };

    let tool_error_rate = if tool_calls_total > 0 {
        tool_errors_total as f64 / tool_calls_total as f64
    } else {
        0.0
    };
    let cost_usd = usage.cost_micros.unwrap_or(0) as f64 / 1_000_000.0;
    let final_rubric_satisfied = gov.last_rubric_verdict.as_ref().or_else(|| gov.rubric_history.last()).map(|v| v.satisfied);

    Ok(TraceMetrics {
        conversation_id: conv_id.to_owned(),
        entry_count: entries.len(),
        turns,
        user_messages,
        compactions,
        tool_calls_total,
        tool_calls_by_name,
        tool_errors_total,
        tool_error_rate,
        repeated_tool_loops,
        usage,
        cost_usd,
        task_total: graph.nodes.len(),
        task_completed,
        task_failed,
        task_aborted,
        max_restart_count,
        subagent_conversations: subagent_convs.len(),
        rubric_verdicts: gov.rubric_history.len(),
        final_rubric_satisfied,
        duration_ms,
        phase_counts,
        phase_duration_ms,
    })
}

/// Opens any SQLite database file or JSONL directory in read-only mode and analyzes it.
pub async fn analyze_path(path: &Path, conv_id: Option<&str>) -> Result<TraceMetrics> {
    let store = Store::open_any_read_only(path).await?;
    let conv = resolve_root_conversation(&store, conv_id).await?;
    let telemetry = if path.is_dir() {
        read_telemetry_jsonl(&path.join("telemetry.jsonl"))?
    } else {
        Vec::new()
    };
    let metrics = analyze_store(&store, &conv, &telemetry).await?;
    let _ = store.close().await;
    Ok(metrics)
}

/// Renders a compact terminal-friendly line-by-line timeline for quick human inspection.
pub async fn render_timeline(store: &Store, conv_id: &str) -> Result<String> {
    let entries = collect_full_entries(store, conv_id).await?;
    let graph = store.task_graph(Some(conv_id)).await?;
    let mut out = String::new();
    let _ = writeln!(out, "Conversation: {conv_id} ({} entries, {} tasks)", entries.len(), graph.nodes.len());
    for entry in &entries {
        match entry.kind.as_str() {
            "pi.system" => {
                let text = preview(entry.payload["text"].as_str().unwrap_or_default(), 80);
                let _ = writeln!(out, "  #{:<3} [system] {text}", entry.seq);
            }
            "pi.user" => {
                let text = entry.payload.as_str().or_else(|| entry.payload["text"].as_str()).unwrap_or_default();
                let _ = writeln!(out, "  #{:<3} [user] {}", entry.seq, preview(text, 100));
            }
            "pi.compaction" => {
                let cut = entry.payload["cutSeq"].as_i64().unwrap_or_default();
                let tokens = entry.payload["tokenCount"].as_i64().unwrap_or_default();
                let _ = writeln!(out, "  #{:<3} [compaction] cutSeq={cut} tokens={tokens}", entry.seq);
            }
            "pi.assistant" => {
                let text = preview(entry.payload["text"].as_str().unwrap_or_default(), 80);
                let calls: Vec<String> = entry.payload["toolCalls"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|c| {
                        let name = c["toolName"].as_str().unwrap_or("?");
                        let args = preview(&canonical_call_args(c), 50);
                        format!("{name}({args})")
                    })
                    .collect();
                if calls.is_empty() {
                    let _ = writeln!(out, "  #{:<3} [assistant] {text}", entry.seq);
                } else if text.is_empty() {
                    let _ = writeln!(out, "  #{:<3} [assistant] calls=[{}]", entry.seq, calls.join(", "));
                } else {
                    let _ = writeln!(out, "  #{:<3} [assistant] {text} calls=[{}]", entry.seq, calls.join(", "));
                }
            }
            "pi.tool_result" => {
                let name = entry.payload["toolName"].as_str().unwrap_or("?");
                let ok = entry.payload["ok"].as_bool().unwrap_or(true);
                let body = if ok {
                    entry.payload["output"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| entry.payload["output"].to_string())
                } else {
                    entry.payload["error"].as_str().unwrap_or_default().to_owned()
                };
                let status = if ok { "ok" } else { "ERR" };
                let _ = writeln!(out, "  #{:<3} [tool:{status}] {name} -> {}", entry.seq, preview(&body, 90));
            }
            other => {
                let _ = writeln!(out, "  #{:<3} [{other}] {}", entry.seq, preview(&entry.payload.to_string(), 90));
            }
        }
    }
    if !graph.nodes.is_empty() {
        out.push_str("Tasks:\n");
        for node in &graph.nodes {
            let _ = writeln!(
                out,
                "  {} kind={} phase={} status={} reason={} restarts={}",
                node.id,
                node.kind,
                node.phase,
                node.status.as_str(),
                if node.terminal_reason.is_empty() { "-" } else { &node.terminal_reason },
                node.restart_count
            );
        }
    }
    Ok(out)
}

/// Generates a self-contained offline HTML inspection report (`eval inspect --html`).
pub async fn export_html(store: &Store, conv_id: &str, telemetry: &[TelemetryEvent]) -> Result<String> {
    let entries = collect_full_entries(store, conv_id).await?;
    let graph = store.task_graph(Some(conv_id)).await?;
    let metrics = analyze_store(store, conv_id, telemetry).await?;

    let mut html = String::with_capacity(4096);
    html.push_str("<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">");
    let _ = write!(html, "<title>VibeValley Trace - {}</title>", html_escape(conv_id));
    html.push_str(
        "<style>\
        body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;background:#faf8f4;color:#222;margin:24px auto;max-width:980px;padding:0 16px;line-height:1.5}\
        h1,h2{margin:0 0 12px}h2{margin-top:24px;font-size:16px;border-bottom:1px solid #e2ddd3;padding-bottom:6px}\
        .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:14px 0}\
        .card{background:#fff;border:1px solid #e2ddd3;border-radius:8px;padding:10px 12px}\
        .label{font-size:12px;color:#666}.val{font-size:18px;font-weight:600;margin-top:2px}\
        details{background:#fff;border:1px solid #e2ddd3;border-radius:8px;margin-bottom:8px;padding:8px 12px}\
        summary{cursor:pointer;font-weight:500}pre{white-space:pre-wrap;word-break:break-word;background:#f5f2eb;padding:10px;border-radius:6px;font-size:12px;overflow:auto}\
        table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2ddd3;font-size:13px}\
        th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #eee}\
        .err{color:#b42318;font-weight:600}\
        </style></head><body>",
    );

    let _ = write!(html, "<h1>Conversation Trace: <code>{}</code></h1>", html_escape(conv_id));
    html.push_str("<div class=\"cards\">");
    push_card(&mut html, "Turns", &metrics.turns.to_string());
    push_card(&mut html, "Entries", &metrics.entry_count.to_string());
    push_card(
        &mut html,
        "Tool Calls / Errors",
        &format!("{} / {}", metrics.tool_calls_total, metrics.tool_errors_total),
    );
    push_card(&mut html, "Repeated Loops", &metrics.repeated_tool_loops.to_string());
    push_card(&mut html, "Compactions", &metrics.compactions.to_string());
    push_card(&mut html, "Cost (USD)", &format!("${:.6}", metrics.cost_usd));
    push_card(&mut html, "Duration", &format!("{} ms", metrics.duration_ms));
    push_card(&mut html, "Subagents", &metrics.subagent_conversations.to_string());
    html.push_str("</div>");

    html.push_str("<h2>Transcript Entries</h2>");
    for entry in &entries {
        let is_err = entry.kind == "pi.tool_result" && entry.payload["ok"] == Value::Bool(false);
        let title = if is_err {
            format!("#{} {} (ERROR)", entry.seq, entry.kind)
        } else {
            format!("#{} {}", entry.seq, entry.kind)
        };
        let pretty = serde_json::to_string_pretty(&entry.payload).unwrap_or_else(|_| entry.payload.to_string());
        let cls = if is_err { " class=\"err\"" } else { "" };
        let _ = write!(
            html,
            "<details><summary{cls}>{}</summary><pre>{}</pre></details>",
            html_escape(&title),
            html_escape(&pretty)
        );
    }

    if !graph.nodes.is_empty() {
        html.push_str(
            "<h2>Task Graph</h2><table><thead><tr><th>Task</th><th>Kind</th><th>Phase</th><th>Status</th><th>Reason</th><th>Restarts</th></tr></thead><tbody>",
        );
        for node in &graph.nodes {
            let _ = write!(
                html,
                "<tr><td><code>{}</code></td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
                html_escape(&node.id),
                html_escape(&node.kind),
                html_escape(&node.phase),
                html_escape(node.status.as_str()),
                html_escape(&node.terminal_reason),
                node.restart_count
            );
        }
        html.push_str("</tbody></table>");
    }

    if !metrics.phase_counts.is_empty() {
        html.push_str("<h2>Durable Phase Telemetry</h2><table><thead><tr><th>Phase</th><th>Invocations</th><th>Total Duration (ms)</th></tr></thead><tbody>");
        for (phase, count) in &metrics.phase_counts {
            let dur = metrics.phase_duration_ms.get(phase).copied().unwrap_or_default();
            let _ = write!(html, "<tr><td><code>{}</code></td><td>{}</td><td>{}</td></tr>", html_escape(phase), count, dur);
        }
        html.push_str("</tbody></table>");
    }

    html.push_str("</body></html>");
    Ok(html)
}

fn push_card(html: &mut String, label: &str, value: &str) {
    let _ = write!(
        html,
        "<div class=\"card\"><div class=\"label\">{}</div><div class=\"val\">{}</div></div>",
        html_escape(label),
        html_escape(value)
    );
}

async fn collect_full_entries(store: &Store, conv_id: &str) -> Result<Vec<Entry>> {
    let conv_id = conv_id.to_owned();
    store
        .read_async(move |r| {
            Box::pin(async move {
                let mut current = r.conversation_async(&conv_id).await?;
                let mut limit = current.next_seq - 1;
                let mut segments = Vec::new();
                let mut seen = HashSet::new();
                loop {
                    if !seen.insert(current.id.clone()) {
                        return Err(Error::Invalid("conversation fork cycle".into()));
                    }
                    let seg = if limit >= 1 {
                        r.ops.entries_within_async(&current.id, 1, limit).await?
                    } else {
                        Vec::new()
                    };
                    segments.push(seg);
                    if current.parent_id.is_empty() {
                        break;
                    }
                    limit = limit.min(current.fork_entry_seq);
                    current = r.conversation_async(&current.parent_id).await?;
                }
                Ok(segments.into_iter().rev().flatten().collect())
            })
        })
        .await
}

fn canonical_call_args(call: &Value) -> String {
    if let Some(raw) = call.get("rawArguments").and_then(Value::as_str) {
        if let Ok(parsed) = serde_json::from_str::<Value>(raw) {
            return canonical_json(&parsed);
        }
        return raw.to_owned();
    }
    canonical_json(&call["argsJson"])
}

fn canonical_json(v: &Value) -> String {
    match v {
        Value::Object(map) => {
            let sorted: BTreeMap<_, _> = map.iter().map(|(k, val)| (k.clone(), normalize_value(val))).collect();
            serde_json::to_string(&sorted).unwrap_or_default()
        }
        other => serde_json::to_string(&normalize_value(other)).unwrap_or_default(),
    }
}

fn normalize_value(v: &Value) -> Value {
    match v {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            for k in keys {
                out.insert(k.clone(), normalize_value(&map[k]));
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(normalize_value).collect()),
        other => other.clone(),
    }
}

fn preview(s: &str, max_chars: usize) -> String {
    let flat: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = flat.chars();
    let taken: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() { format!("{taken}...") } else { taken }
}

fn html_escape(s: &str) -> String {
    quick_xml::escape::escape(s).into_owned()
}
