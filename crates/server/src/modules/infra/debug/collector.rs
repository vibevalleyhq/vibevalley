//! Fixed-capacity per-lane diagnostic ring buffers (`core_apply`, `bridge_rpc`,
//! `oar_wire`, `gpui_frame`) plus the fault-injection gate for Lab & Overrides.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use parking_lot::{Mutex, RwLock};
use serde_json::{Value, json};
use vibevalley_core::{SliceMask, Transition};
use vibevalley_protocol::{DebugCacheStat, DebugOverrideConfig, DebugTimelineEvent, DebugTimelineLane, DebugTimelinePage, DebugTimelineQuery, Fact};
use vibevalley_runtime::oar::{Event as OarEvent, EventKind as OarEventKind, OarObserver};

use super::redact::{Redactor, contains_ascii_ci};
use crate::modules::infra::setting::Setting;
use crate::now;
use crate::transport::api::{CallerContext, FaultGate, InvokeObserver};

pub const LANE_CAPACITY: usize = 512;
pub const MAX_PAYLOAD_BYTES: usize = 4096;
const MAX_IN_FLIGHT: usize = 512;
const MAX_DELAY_MS: u32 = 30_000;
const SLOW_RPC_US: u64 = 50_000;
const SLOW_FRAME_US: u64 = 16_000;

#[derive(Default)]
struct LaneRing {
    events: VecDeque<DebugTimelineEvent>,
    dropped: i64,
}

impl LaneRing {
    fn push(&mut self, event: DebugTimelineEvent) {
        if self.events.len() >= LANE_CAPACITY {
            self.events.pop_front();
            self.dropped += 1;
        }
        self.events.push_back(event);
    }

    fn clear(&mut self) {
        self.events.clear();
        self.dropped = 0;
    }
}

#[derive(Default)]
struct LaneState {
    core_apply: LaneRing,
    bridge_rpc: LaneRing,
    oar_wire: LaneRing,
    gpui_frame: LaneRing,
    last_host_frame_seq: u64,
}

impl LaneState {
    fn ring(&self, lane: DebugTimelineLane) -> &LaneRing {
        match lane {
            DebugTimelineLane::CoreApply => &self.core_apply,
            DebugTimelineLane::BridgeRpc => &self.bridge_rpc,
            DebugTimelineLane::OarWire => &self.oar_wire,
            DebugTimelineLane::GpuiFrame => &self.gpui_frame,
        }
    }

    fn ring_mut(&mut self, lane: DebugTimelineLane) -> &mut LaneRing {
        match lane {
            DebugTimelineLane::CoreApply => &mut self.core_apply,
            DebugTimelineLane::BridgeRpc => &mut self.bridge_rpc,
            DebugTimelineLane::OarWire => &mut self.oar_wire,
            DebugTimelineLane::GpuiFrame => &mut self.gpui_frame,
        }
    }
}

pub struct DebugCollector {
    setting: Arc<Setting>,
    lanes: Mutex<LaneState>,
    next_id: AtomicI64,
    in_flight: Mutex<HashMap<(u64, String), Value>>,
    overrides: RwLock<DebugOverrideConfig>,
}

impl DebugCollector {
    pub fn new(setting: Arc<Setting>) -> Arc<Self> {
        Arc::new(Self {
            setting,
            lanes: Mutex::default(),
            next_id: AtomicI64::new(1),
            in_flight: Mutex::default(),
            overrides: RwLock::new(DebugOverrideConfig::default()),
        })
    }

    fn next_event_id(&self) -> i64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn push(&self, mut event: DebugTimelineEvent) {
        if let Some(detail) = event.detail.take() {
            event.detail = Some(cap_json_bytes(detail, MAX_PAYLOAD_BYTES));
        }
        // Assign the id under the lane lock so every ring remains strictly sorted by id.
        let mut state = self.lanes.lock();
        event.id = self.next_event_id();
        state.ring_mut(event.lane).push(event);
    }

    /// Ingests GPUI frame samples published by `apps/mac`'s `ShellDebugHandle`,
    /// deduplicating strictly by monotonic `seq`.
    pub fn ingest_host_frames(&self, host_snapshot: &Value) {
        let mut count = 0u32;
        self.ingest_host_frames_inner(host_snapshot, None, &mut count);
    }

    pub(crate) fn ingest_host_frames_with(&self, host_snapshot: &Value, redactor: &Redactor, count: &mut u32) {
        self.ingest_host_frames_inner(host_snapshot, Some(redactor), count);
    }

    fn ingest_host_frames_inner(&self, host_snapshot: &Value, shared_redactor: Option<&Redactor>, count: &mut u32) {
        let Some(frames) = host_snapshot.get("frames").and_then(Value::as_array) else {
            return;
        };
        if frames.is_empty() {
            return;
        }
        let last_seq = self.lanes.lock().last_host_frame_seq;
        let mut items: Vec<(u64, &Value)> = frames
            .iter()
            .filter_map(|item| item.get("seq").and_then(Value::as_u64).map(|seq| (seq, item)))
            .filter(|(seq, _)| *seq > last_seq)
            .collect();
        if items.is_empty() {
            return;
        }
        items.sort_by_key(|(seq, _)| *seq);

        let owned_redactor = if shared_redactor.is_none() {
            Some(Redactor::from_setting(&self.setting))
        } else {
            None
        };
        let redactor = shared_redactor.or(owned_redactor.as_ref()).expect("redactor initialized");

        let mut prepared = Vec::with_capacity(items.len());
        let mut prev_seq = last_seq;
        for (seq, frame) in items {
            if seq <= prev_seq {
                continue;
            }
            prev_seq = seq;
            let time = frame.get("time").and_then(Value::as_i64).unwrap_or_else(now);
            let duration_us = frame.get("durationUs").and_then(Value::as_i64);
            let slow = frame
                .get("slow")
                .and_then(Value::as_bool)
                .or_else(|| duration_us.map(|us| us >= SLOW_FRAME_US as i64));
            let raw_summary = frame.get("summary").and_then(Value::as_str).unwrap_or("Shell::render");
            let summary = redactor.redact_str(raw_summary, count);
            let detail = cap_json_bytes(
                json!({
                    "seq": seq,
                    "durationUs": duration_us,
                    "slow": slow,
                    "summary": summary,
                }),
                MAX_PAYLOAD_BYTES,
            );
            prepared.push((
                seq,
                DebugTimelineEvent {
                    id: 0,
                    time,
                    lane: DebugTimelineLane::GpuiFrame,
                    kind: "gpui_frame".into(),
                    trace_id: None,
                    duration_us,
                    summary,
                    detail: Some(detail),
                    slow,
                },
            ));
        }

        let mut state = self.lanes.lock();
        for (seq, mut ev) in prepared {
            if seq <= state.last_host_frame_seq {
                continue;
            }
            state.last_host_frame_seq = seq;
            ev.id = self.next_event_id();
            state.gpui_frame.push(ev);
        }
    }

    pub fn query(&self, q: &DebugTimelineQuery) -> DebugTimelinePage {
        let search = q.search.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_ascii_lowercase);
        let lanes: &[DebugTimelineLane] = match &q.lane {
            Some(lane) => std::slice::from_ref(lane),
            None => &DebugTimelineLane::ALL,
        };
        let limit = q.limit.unwrap_or(200).clamp(1, 2048) as usize;

        // Walk each sorted ring from newest to oldest so small limits only clone
        // the `<= limit` matching events instead of copying all 2048 ring entries.
        let (mut events, latest_id, dropped) = {
            let state = self.lanes.lock();
            let mut dropped = 0i64;
            let mut cursors = [0usize; DebugTimelineLane::ALL.len()];
            for (i, &lane) in lanes.iter().enumerate() {
                let ring = state.ring(lane);
                dropped += ring.dropped;
                cursors[i] = ring.events.len();
            }

            let mut picked = Vec::with_capacity(limit.min(256));
            while picked.len() < limit {
                let mut best: Option<(usize, i64)> = None;
                for (i, &lane) in lanes.iter().enumerate() {
                    let idx = cursors[i];
                    if idx == 0 {
                        continue;
                    }
                    let ev = &state.ring(lane).events[idx - 1];
                    if q.after_id.is_some_and(|after| ev.id <= after) {
                        cursors[i] = 0;
                        continue;
                    }
                    if best.is_none_or(|(_, best_id)| ev.id > best_id) {
                        best = Some((i, ev.id));
                    }
                }
                let Some((lane_idx, _)) = best else {
                    break;
                };
                cursors[lane_idx] -= 1;
                let ev = &state.ring(lanes[lane_idx]).events[cursors[lane_idx]];
                if let Some(needle) = &search
                    && !matches_search(ev, needle)
                {
                    continue;
                }
                picked.push(ev.clone());
            }
            let latest_id = self.next_id.load(Ordering::Relaxed).saturating_sub(1);
            (picked, latest_id, dropped)
        };

        events.reverse();
        DebugTimelinePage { events, latest_id, dropped }
    }

    pub fn recent(&self, limit: usize) -> Vec<DebugTimelineEvent> {
        self.query(&DebugTimelineQuery {
            lane: None,
            after_id: None,
            limit: Some(limit.min(2048) as u32),
            search: None,
        })
        .events
    }

    pub fn all_events(&self) -> Vec<DebugTimelineEvent> {
        self.query(&DebugTimelineQuery {
            lane: None,
            after_id: None,
            limit: Some((LANE_CAPACITY * DebugTimelineLane::ALL.len()) as u32),
            search: None,
        })
        .events
    }

    pub fn clear(&self) {
        let mut state = self.lanes.lock();
        state.core_apply.clear();
        state.bridge_rpc.clear();
        state.oar_wire.clear();
        state.gpui_frame.clear();
        self.in_flight.lock().clear();
    }

    pub fn overrides(&self) -> DebugOverrideConfig {
        self.overrides.read().clone()
    }

    pub fn set_overrides(&self, cfg: DebugOverrideConfig) -> DebugOverrideConfig {
        let normalized = DebugOverrideConfig {
            rpc_delay_ms: cfg.rpc_delay_ms.min(MAX_DELAY_MS),
            slice_delay_ms: cfg.slice_delay_ms.min(MAX_DELAY_MS),
            target_filter: cfg.target_filter.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            disconnect_topic: cfg.disconnect_topic.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        };
        *self.overrides.write() = normalized.clone();
        normalized
    }

    pub fn cache_stats(&self) -> Vec<DebugCacheStat> {
        let state = self.lanes.lock();
        DebugTimelineLane::ALL
            .into_iter()
            .map(|lane| {
                let ring = state.ring(lane);
                DebugCacheStat {
                    name: format!("timeline:{}", lane.as_str()),
                    entries: ring.events.len() as u32,
                    detail: Some(format!("cap={LANE_CAPACITY}, dropped={}", ring.dropped)),
                }
            })
            .collect()
    }
}

impl InvokeObserver for DebugCollector {
    fn on_call_start(&self, ctx: &CallerContext, op: &str, payload: &Value) {
        if op.starts_with("debug.") {
            return;
        }
        let clean = if value_needs_redaction(payload) {
            let redactor = Redactor::from_setting(&self.setting);
            let mut count = 0u32;
            cap_json_bytes(redactor.redact_value(payload.clone(), &mut count), MAX_PAYLOAD_BYTES)
        } else {
            payload.clone()
        };
        let mut in_flight = self.in_flight.lock();
        if in_flight.len() >= MAX_IN_FLIGHT {
            in_flight.clear();
        }
        in_flight.insert((ctx.trace_id, op.to_string()), clean);
    }

    fn on_call_end(&self, ctx: &CallerContext, op: &str, biz_code: u32, duration_us: u64) {
        if op.starts_with("debug.") {
            return;
        }
        let payload = self.in_flight.lock().remove(&(ctx.trace_id, op.to_string()));
        let client = ctx.client.as_ref().map(|c| {
            let redactor = Redactor::from_setting(&self.setting);
            let mut count = 0u32;
            json!({
                "id": redactor.redact_str(&c.id, &mut count),
                "kind": c.kind.as_str(),
                "label": redactor.redact_str(&c.label, &mut count),
            })
        });
        let detail = json!({
            "op": op,
            "bizCode": biz_code,
            "caller": format!("{:?}", ctx.caller),
            "client": client,
            "payload": payload,
        });
        let ms = duration_us as f64 / 1000.0;
        self.push(DebugTimelineEvent {
            id: 0,
            time: now(),
            lane: DebugTimelineLane::BridgeRpc,
            kind: op.to_string(),
            trace_id: (ctx.trace_id != 0).then_some(ctx.trace_id as i64),
            duration_us: Some(duration_us as i64),
            summary: format!("{op} -> {biz_code} ({ms:.1}ms)"),
            detail: Some(detail),
            slow: Some(duration_us >= SLOW_RPC_US),
        });
    }

    fn on_apply(&self, seq: i64, dirty: SliceMask, transitions: &[Transition], duration_us: u64) {
        let dirty_slices: Vec<&'static str> = dirty.kinds().map(|k| k.as_str()).collect();
        let facts: Vec<&'static str> = transitions.iter().map(|t| fact_kind(&t.fact)).collect();
        let detail = json!({
            "seq": seq,
            "dirty": dirty_slices,
            "transitionCount": transitions.len(),
            "facts": facts,
        });
        let summary = format!("seq #{seq}: {} transitions [{}]", transitions.len(), dirty_slices.join(","));
        self.push(DebugTimelineEvent {
            id: 0,
            time: now(),
            lane: DebugTimelineLane::CoreApply,
            kind: format!("apply#{seq}"),
            trace_id: None,
            duration_us: Some(duration_us as i64),
            summary,
            detail: Some(detail),
            slow: Some(duration_us >= SLOW_FRAME_US),
        });
    }
}

impl OarObserver for DebugCollector {
    fn on_event(&self, session_id: &str, event: &OarEvent) {
        let redactor = Redactor::from_setting(&self.setting);
        let mut count = 0u32;
        let (kind, raw_note) = oar_event_summary(&event.kind);
        let note = redactor.redact_cow(&raw_note, &mut count);
        let summary = if note.is_empty() {
            format!("[{session_id}] {kind}")
        } else {
            let (snippet, clipped) = clip_utf8(&note, 180);
            if clipped {
                format!("[{session_id}] {kind}: {snippet}…")
            } else {
                format!("[{session_id}] {kind}: {snippet}")
            }
        };
        let raw_event_val = serde_json::to_value(&event.kind).unwrap_or(Value::Null);
        let clean_event_val = redactor.redact_value(raw_event_val, &mut count);
        let detail = json!({
            "sessionId": session_id,
            "seq": event.seq,
            "agentPath": event.agent_path,
            "event": clean_event_val,
        });
        self.push(DebugTimelineEvent {
            id: 0,
            time: i64::try_from(event.at_ms).unwrap_or_else(|_| now()),
            lane: DebugTimelineLane::OarWire,
            kind: kind.to_string(),
            trace_id: None,
            duration_us: None,
            summary,
            detail: Some(detail),
            slow: None,
        });
    }
}

impl FaultGate for DebugCollector {
    fn delay_ms(&self, target: &str) -> u64 {
        if target.starts_with("debug.") {
            return 0;
        }
        let cfg = self.overrides.read();
        if let Some(filter) = cfg.target_filter.as_deref()
            && !target.contains(filter)
        {
            return 0;
        }
        if target.starts_with("slice:") {
            u64::from(cfg.slice_delay_ms)
        } else {
            u64::from(cfg.rpc_delay_ms)
        }
    }

    fn should_disconnect(&self, topic: &str) -> bool {
        {
            let cfg = self.overrides.read();
            let Some(target) = cfg.disconnect_topic.as_deref() else {
                return false;
            };
            if !disconnect_matches(target, topic) {
                return false;
            }
        }
        // One-shot consume so clients reconnect cleanly after simulating a drop.
        let mut cfg = self.overrides.write();
        let matched = cfg.disconnect_topic.as_deref().is_some_and(|target| disconnect_matches(target, topic));
        if matched {
            cfg.disconnect_topic = None;
        }
        matched
    }
}

fn disconnect_matches(target: &str, topic: &str) -> bool {
    let target = target.trim();
    !target.is_empty() && (target == "*" || target == "all" || target == topic || topic.contains(target))
}

fn value_needs_redaction(val: &Value) -> bool {
    match val {
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
        Value::String(s) => !s.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

fn matches_search(ev: &DebugTimelineEvent, needle_lower: &str) -> bool {
    if needle_lower.is_ascii() {
        let needle = needle_lower.as_bytes();
        if contains_ascii_ci(ev.kind.as_bytes(), needle) || contains_ascii_ci(ev.summary.as_bytes(), needle) {
            return true;
        }
        return ev.detail.as_ref().is_some_and(|d| contains_ascii_ci(d.to_string().as_bytes(), needle));
    }
    if ev.kind.to_ascii_lowercase().contains(needle_lower) || ev.summary.to_ascii_lowercase().contains(needle_lower) {
        return true;
    }
    ev.detail.as_ref().is_some_and(|d| d.to_string().to_ascii_lowercase().contains(needle_lower))
}

pub(crate) fn clip_utf8(text: &str, max_bytes: usize) -> (&str, bool) {
    if text.len() <= max_bytes {
        return (text, false);
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (&text[..end], true)
}

fn json_upper_bound_bytes(val: &Value, limit: usize) -> usize {
    match val {
        Value::Null => 4,
        Value::Bool(_) => 5,
        Value::Number(_) => 32,
        Value::String(s) => s.len().saturating_mul(6).saturating_add(2),
        Value::Array(items) => {
            let mut total = 2usize;
            for item in items {
                total = total.saturating_add(json_upper_bound_bytes(item, limit)).saturating_add(1);
                if total > limit {
                    return total;
                }
            }
            total
        }
        Value::Object(map) => {
            let mut total = 2usize;
            for (k, v) in map {
                total = total
                    .saturating_add(k.len().saturating_mul(6))
                    .saturating_add(4)
                    .saturating_add(json_upper_bound_bytes(v, limit));
                if total > limit {
                    return total;
                }
            }
            total
        }
    }
}

pub(crate) fn cap_json_bytes(val: Value, max_bytes: usize) -> Value {
    if json_upper_bound_bytes(&val, max_bytes) <= max_bytes {
        return val;
    }
    let serialized = serde_json::to_string(&val).unwrap_or_default();
    if serialized.len() <= max_bytes {
        return val;
    }
    let preview_budget = max_bytes.saturating_sub(128);
    let (preview, _) = clip_utf8(&serialized, preview_budget);
    json!({
        "_truncated": true,
        "originalBytes": serialized.len(),
        "preview": preview,
    })
}

fn fact_kind(fact: &Fact) -> &'static str {
    match fact {
        Fact::CallChanged(_) => "callChanged",
        Fact::SessionToolChanged(_) => "sessionToolChanged",
        Fact::SessionToolsReset(_) => "sessionToolsReset",
        Fact::SessionSubagentsChanged(_) => "sessionSubagentsChanged",
        Fact::SessionPhaseChanged(_) => "sessionPhaseChanged",
        Fact::MessageChanged(_) => "messageChanged",
        Fact::ChannelChanged(_) => "channelChanged",
        Fact::UserMentionsChanged(_) => "userMentionsChanged",
        Fact::SessionChanged(_) => "sessionChanged",
        Fact::SessionReported(_) => "sessionReported",
        Fact::SessionLeft(_) => "sessionLeft",
        Fact::ProgressChanged(_) => "progressChanged",
        Fact::IssueChanged(_) => "issueChanged",
        Fact::IssueRemoved(_) => "issueRemoved",
        Fact::ChannelRemoved(_) => "channelRemoved",
        Fact::CronChanged(_) => "cronChanged",
        Fact::CronRemoved(_) => "cronRemoved",
        Fact::ConnectorChanged(_) => "connectorChanged",
        Fact::MachineChanged(_) => "machineChanged",
        Fact::MediaChanged(_) => "mediaChanged",
        Fact::RuntimeInboxChanged(_) => "runtimeInboxChanged",
    }
}

fn oar_event_summary(kind: &OarEventKind) -> (&'static str, String) {
    match kind {
        OarEventKind::SessionStarted { model, .. } => ("session_started", model.clone().unwrap_or_default()),
        OarEventKind::TurnStarted { prompt } => ("turn_started", prompt.clone()),
        OarEventKind::TextDelta { text } => ("text_delta", text.clone()),
        OarEventKind::ThinkingDelta { text } => ("thinking_delta", text.clone()),
        OarEventKind::ToolCallStarted { name, .. } => ("tool_call_started", name.clone()),
        OarEventKind::ToolCallFinished { id, ok, .. } => ("tool_call_finished", format!("{id} ok={ok}")),
        OarEventKind::SubagentSpawned { thread_id, agent_name, .. } => {
            ("subagent_spawned", format!("{} ({})", thread_id, agent_name.as_deref().unwrap_or("subagent")))
        }
        OarEventKind::SubagentWait { thread_id, waiting, .. } => ("subagent_wait", format!("{thread_id} waiting={waiting}")),
        OarEventKind::SubagentMessage { thread_id, text, .. } => ("subagent_message", format!("{thread_id}: {text}")),
        OarEventKind::SubagentPlanUpdated { thread_id, steps, .. } => ("subagent_plan_updated", format!("{thread_id} steps={}", steps.len())),
        OarEventKind::SubagentStatusChanged { thread_id, status, .. } => ("subagent_status_changed", format!("{thread_id} {status:?}")),
        OarEventKind::FileChanged { path, change } => ("file_changed", format!("{change:?} {}", path.display())),
        OarEventKind::PermissionRequested { tool, summary, .. } => ("permission_requested", format!("{tool}: {summary}")),
        OarEventKind::PermissionResolved { request_id, .. } => ("permission_resolved", request_id.clone()),
        OarEventKind::InteractionRequested { question, .. } => ("interaction_requested", question.clone()),
        OarEventKind::InteractionResolved { request_id, .. } => ("interaction_resolved", request_id.clone()),
        OarEventKind::Question { text } => ("question", text.clone()),
        OarEventKind::TurnFinished { reason, .. } => ("turn_finished", format!("{reason:?}")),
        OarEventKind::Error { message } => ("error", message.clone()),
        OarEventKind::SessionEnded => ("session_ended", String::new()),
    }
}
