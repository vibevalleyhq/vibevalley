//! Synchronous pure-Rust domain computation and projection bridge exported on `"vibevalley/rich"`.
//!
//! Decodes JSON wire inputs once at the boundary, delegates to `vibevalley_core`,
//! and serializes canonical protocol projections for live UI updates.

use nsh_core::prelude::module;
use vibevalley_core::{compare, note, schedule, trajectory};
use vibevalley_protocol::{CompareSpec, EventTokens, Issue, SessionEvent, SessionEventType};

/// Synchronous core computation and projection helpers exported on `"vibevalley/rich"`.
#[module]
pub struct VvCore;

#[module(flat)]
impl VvCore {
    /// Parses and validates raw JSON from a fenced `compare` block into canonical JSON.
    pub fn parse_compare_spec(raw: String) -> Option<String> {
        let spec = compare::parse_compare_spec(&raw)?;
        serde_json::to_string(&spec).ok()
    }

    /// Splits Markdown text around valid fenced ` ```compare ` blocks, returning `CompareMarkdownSegment[]` JSON.
    pub fn split_compare_blocks(text: String) -> String {
        let segments = compare::split_markdown_compare_blocks(&text);
        serde_json::to_string(&segments).unwrap_or_else(|_| "[]".to_string())
    }

    /// Serializes a validated `CompareSpec` JSON string into a fenced ` ```compare ` Markdown block.
    pub fn format_compare_block(spec_json: String) -> Option<String> {
        let spec: CompareSpec = serde_json::from_str(&spec_json).ok()?;
        Some(compare::format_compare_block(&spec))
    }

    /// Computes hierarchical issue schedule bounds & rollup (`BoardSchedule` JSON) from `Issue[]` JSON.
    pub fn compute_schedule(issues_json: String, now_ms: f64) -> String {
        let issues: Vec<Issue> = serde_json::from_str(&issues_json).unwrap_or_default();
        let (board_schedule, _spans) = schedule::compute_board_schedule(&issues, now_ms.floor() as i64);
        serde_json::to_string(&board_schedule).unwrap_or_else(|_| r#"{"todayDayMs":0,"scheduled":[],"unscheduledIds":[]}"#.to_string())
    }

    /// Computes full trajectory projection (`SessionTrajectoryProjection` JSON) from `SessionEvent[]` JSON.
    pub fn project_trajectory(events_json: String, end_ms: f64) -> String {
        let events: Vec<SessionEvent> = serde_json::from_str(&events_json).unwrap_or_default();
        let projection = trajectory::project_trajectory(&events, end_ms.floor() as i64);
        serde_json::to_string(&projection).unwrap_or_else(|_| {
            r#"{"shown":[],"runs":[],"waterfall":{"runs":[],"spans":[]},"summary":{"runs":0,"steps":0,"modelMs":0,"toolMs":0,"input":0,"cacheRead":0,"output":0},"stepDurations":[],"stepMeta":[],"telemetry":{"inputTokens":0,"cacheReadTokens":0,"outputTokens":0,"llmRetries":0,"runErrors":0}}"#.to_string()
        })
    }

    /// Allocates damped waterfall horizontal pixel widths (`number[]` JSON) from `durations` JSON and room width.
    pub fn waterfall_widths(durations_json: String, room: f64) -> String {
        let durations: Vec<f64> = serde_json::from_str(&durations_json).unwrap_or_default();
        let widths = trajectory::waterfall_widths(&durations, room);
        serde_json::to_string(&widths).unwrap_or_else(|_| "[]".to_string())
    }

    /// Projects workspace chat visible steps, grouped feed items, todo checklist, and telemetry (`ChatSessionProjection` JSON).
    pub fn project_chat_session(events_json: String, tokens_json: Option<String>, default_window: f64) -> String {
        let events: Vec<SessionEvent> = serde_json::from_str(&events_json).unwrap_or_default();
        let tokens: Option<EventTokens> = tokens_json.as_deref().and_then(|s| serde_json::from_str(s).ok());
        let win = if default_window.is_finite() && default_window > 0.0 {
            default_window.floor() as i64
        } else {
            200_000
        };
        let projection = trajectory::project_chat_session(&events, tokens.as_ref(), win);
        serde_json::to_string(&projection).unwrap_or_else(|_| {
            r#"{"visibleSteps":[],"feedItems":[],"telemetry":{"cachedRead":0,"uncachedInput":0,"totalInput":0,"output":0,"reasoning":0,"contextUsed":0,"contextWindow":200000,"contextPct":0,"cacheHitPct":0,"turns":0,"toolCount":0,"hasData":false},"toolEntries":[]}"#.to_string()
        })
    }

    /// Parses swarm board message tokens (`BoardTextToken[]` JSON).
    pub fn parse_board_tokens(text: String) -> String {
        let tokens = trajectory::parse_board_tokens(&text);
        serde_json::to_string(&tokens).unwrap_or_else(|_| "[]".to_string())
    }

    /// Extracts file path, optional line number, and edit-diff flag (`ToolTarget` JSON) from a `SessionEvent` JSON string.
    pub fn extract_tool_target(step_json: String) -> Option<String> {
        let step: SessionEvent = serde_json::from_str(&step_json).ok()?;
        let target = trajectory::extract_tool_target(step.action, step.tool.as_deref(), step.input.as_deref(), &step.text)?;
        serde_json::to_string(&target).ok()
    }

    /// Extracts tool headline, formatted input, and output line count (`ToolDetails` JSON) from a `SessionEvent` JSON string.
    pub fn format_tool_details(step_json: String) -> String {
        let Ok(step) = serde_json::from_str::<SessionEvent>(&step_json) else {
            return r#"{"headline":"","formattedInput":"","outputLines":0}"#.to_string();
        };
        let details = trajectory::format_tool_details(&step);
        serde_json::to_string(&details).unwrap_or_else(|_| r#"{"headline":"","formattedInput":"","outputLines":0}"#.to_string())
    }

    /// Parses `update_steps` / `TodoWrite` / `update_plan` payloads (`TodoChecklist` JSON) from a `SessionEvent` JSON string.
    pub fn parse_todo_checklist(step_json: String) -> Option<String> {
        let step: SessionEvent = serde_json::from_str(&step_json).ok()?;
        let checklist = trajectory::parse_todo_checklist(step.seq, step.r#type, step.tool.as_deref(), step.input.as_deref())?;
        serde_json::to_string(&checklist).ok()
    }

    /// Strips internal orchestrator prompt-injection scaffolding for collapsed trajectory rows.
    pub fn collapsed_step_summary(step_type: String, body: String) -> String {
        let parsed: SessionEventType = serde_json::from_value(serde_json::Value::String(step_type)).unwrap_or(SessionEventType::UserMessage);
        trajectory::collapsed_step_summary_raw(parsed, &body)
    }

    /// Formats a `tool/call` input into `$ cmd`, pretty-printed JSON, or raw text.
    pub fn readable_input(step_json: String) -> String {
        let Ok(step) = serde_json::from_str::<SessionEvent>(&step_json) else {
            return String::new();
        };
        trajectory::readable_input(&step)
    }

    /// Merges incoming `SessionEvent[]` JSON into existing `SessionEvent[]` JSON by `(seq, revision)`.
    pub fn merge_steps(log_json: String, incoming_json: String, limit: Option<f64>, replace_same_revision: bool) -> String {
        let log: Vec<SessionEvent> = serde_json::from_str(&log_json).unwrap_or_default();
        let incoming: Vec<SessionEvent> = serde_json::from_str(&incoming_json).unwrap_or_default();
        let cap = limit.and_then(|n| (n.is_finite() && n >= 0.0).then_some(n.floor() as usize));
        let merged = trajectory::merge_steps(log, &incoming, cap, replace_same_revision);
        serde_json::to_string(&merged).unwrap_or_else(|_| "[]".to_string())
    }

    /// Converts Markdown text into a canonical `DocBlock[]` JSON array via `vibevalley_core::note::doc::markdown_to_blocks`.
    pub fn markdown_to_blocks(markdown: String) -> String {
        let blocks = note::doc::markdown_to_blocks(&markdown);
        serde_json::to_string(&blocks).unwrap_or_else(|_| "[]".to_string())
    }
}
