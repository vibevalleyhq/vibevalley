//! Read-only sidecar readers for Antigravity native `/swarm` directories and
//! bounded child/worker `transcript.jsonl` logs.
//!
//! Both `/swarm` worker drill-down and regular `invoke_subagent` sessions share
//! `read_child_transcript`, which enforces hard byte/text/step caps and
//! `symlink_metadata` traversal checks on every path segment.

use std::collections::{BTreeMap, VecDeque};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Deserialize;
use serde_json::Value;

use crate::acp::antigravity::strip_inline_data_images;
use crate::acp::antigravity_db::{check_non_symlink_chain, is_safe_segment};
use crate::{ChildToolCall, ChildTranscriptStep, SwarmMember, SwarmMemberState, SwarmMessage, SwarmPlan, SwarmPlanThread, SwarmSnapshot};

pub(crate) const TRANSCRIPT_BYTE_CAP: usize = 256 * 1024;
pub(crate) const STEP_TEXT_CAP: usize = 4_000;
pub(crate) const MAX_STEPS: usize = 30;
pub(crate) const BOARD_WINDOW_CAP: usize = 200;
const TOOL_SUMMARY_CAP: usize = 200;
const BOARD_READ_CAP: usize = 4 * 1024 * 1024;

type FileStamp = (Option<SystemTime>, u64);

fn file_stamp(path: &Path) -> Option<FileStamp> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return None;
    }
    Some((meta.modified().ok(), meta.len()))
}

fn clamp_text(raw: &str, max_chars: usize) -> Option<String> {
    let cleaned = strip_inline_data_images(raw);
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut chars = trimmed.chars();
    let head: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() { Some(format!("{head}…")) } else { Some(head) }
}

fn value_to_text(value: Option<Value>, max_chars: usize) -> Option<String> {
    match value? {
        Value::Null => None,
        Value::String(s) => clamp_text(&s, max_chars),
        Value::Object(map) => {
            if let Some(msg) = map.get("message").and_then(Value::as_str) {
                clamp_text(msg, max_chars)
            } else {
                clamp_text(&Value::Object(map).to_string(), max_chars)
            }
        }
        other => clamp_text(&other.to_string(), max_chars),
    }
}

fn summarize_tool_args(args: Option<Value>) -> Option<String> {
    match args? {
        Value::Null => None,
        Value::String(s) => clamp_text(&s, TOOL_SUMMARY_CAP),
        Value::Object(map) => {
            for key in [
                "CommandLine",
                "command",
                "Path",
                "path",
                "Query",
                "query",
                "text",
                "brief",
                "action",
                "name",
                "prompt",
            ] {
                if let Some(val) = map.get(key).and_then(Value::as_str)
                    && let Some(s) = clamp_text(val, TOOL_SUMMARY_CAP)
                {
                    return Some(s);
                }
            }
            if map.is_empty() {
                None
            } else {
                clamp_text(&Value::Object(map).to_string(), TOOL_SUMMARY_CAP)
            }
        }
        other => clamp_text(&other.to_string(), TOOL_SUMMARY_CAP),
    }
}

#[derive(Debug, Deserialize)]
struct RawTranscriptToolCall {
    #[serde(default)]
    name: String,
    #[serde(default)]
    args: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct RawTranscriptLine {
    #[serde(default)]
    step_index: u64,
    #[serde(default)]
    source: String,
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    input_tokens: Option<u64>,
    #[serde(default)]
    cache_read_tokens: Option<u64>,
    #[serde(default)]
    output_tokens: Option<u64>,
    #[serde(default)]
    thinking: Option<Value>,
    #[serde(default)]
    content: Option<Value>,
    #[serde(default)]
    error: Option<Value>,
    #[serde(default)]
    tool_calls: Vec<RawTranscriptToolCall>,
}

/// Reads up to `limit.min(MAX_STEPS)` recent steps from
/// `<base>/brain/<conversation_id>/.system_generated/logs/transcript.jsonl`.
///
/// Tail-seeks to at most `TRANSCRIPT_BYTE_CAP` (256 KiB), drops any partial
/// first line after seeking, clamps text fields to `STEP_TEXT_CAP` (4,000 chars),
/// rejects symlinks and traversal segments, and silently ignores malformed lines.
pub(crate) fn read_child_transcript(base: &Path, conversation_id: &str, limit: usize) -> Vec<ChildTranscriptStep> {
    if !is_safe_segment(conversation_id) {
        return Vec::new();
    }
    let Some(path) = check_non_symlink_chain(base, &["brain", conversation_id, ".system_generated", "logs", "transcript.jsonl"], true) else {
        return Vec::new();
    };
    let Ok(before) = std::fs::symlink_metadata(&path) else {
        return Vec::new();
    };
    let Ok(mut file) = File::open(&path) else {
        return Vec::new();
    };
    let Ok(meta) = file.metadata() else {
        return Vec::new();
    };
    if before.dev() != meta.dev() || before.ino() != meta.ino() {
        return Vec::new();
    }

    let len = meta.len();
    let truncated_head = len > TRANSCRIPT_BYTE_CAP as u64;
    if truncated_head && file.seek(SeekFrom::Start(len - TRANSCRIPT_BYTE_CAP as u64)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::new();
    if file.take(TRANSCRIPT_BYTE_CAP as u64).read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    let slice = if truncated_head {
        match buf.iter().position(|&b| b == b'\n') {
            Some(pos) => &buf[pos + 1..],
            None => return Vec::new(),
        }
    } else {
        &buf[..]
    };

    let cap = if limit == 0 { MAX_STEPS } else { limit.min(MAX_STEPS) };
    let text = String::from_utf8_lossy(slice);
    let mut ring = VecDeque::with_capacity(cap + 1);
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(raw) = serde_json::from_str::<RawTranscriptLine>(trimmed) else {
            continue;
        };
        let tool_calls = raw
            .tool_calls
            .into_iter()
            .filter(|tc| !tc.name.trim().is_empty())
            .map(|tc| ChildToolCall {
                name: tc.name.trim().to_string(),
                summary: summarize_tool_args(tc.args),
            })
            .collect();
        let step = ChildTranscriptStep {
            step_index: raw.step_index,
            source: raw.source,
            kind: raw.kind,
            status: raw.status.filter(|s| !s.trim().is_empty()),
            created_at: raw.created_at.filter(|s| !s.trim().is_empty()),
            model: raw.model.filter(|s| !s.trim().is_empty()),
            input_tokens: raw.input_tokens,
            cache_read_tokens: raw.cache_read_tokens,
            output_tokens: raw.output_tokens,
            thinking: value_to_text(raw.thinking, STEP_TEXT_CAP),
            content: value_to_text(raw.content, STEP_TEXT_CAP),
            error: value_to_text(raw.error, STEP_TEXT_CAP),
            tool_calls,
        };
        if ring.len() == cap {
            ring.pop_front();
        }
        ring.push_back(step);
    }
    ring.into_iter().collect()
}

// ---- Native `/swarm` directory reader ---------------------------------------

#[derive(Debug, Default, Deserialize)]
struct RawSwarmMeta {
    #[serde(default)]
    swarm_id: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RawMembersFile {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    members: BTreeMap<String, RawMember>,
}

#[derive(Debug, Default, Deserialize)]
struct RawMember {
    #[serde(default)]
    conversation_id: String,
    #[serde(default)]
    role: String,
    #[serde(default)]
    phase: String,
    #[serde(default)]
    wake_mode: Option<String>,
    #[serde(default)]
    wait_since: Option<u64>,
    #[serde(default)]
    last_read_seq: Option<u64>,
    #[serde(default)]
    killed: bool,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    desired_model: Option<String>,
    #[serde(default)]
    applied_model: Option<String>,
    #[serde(default)]
    workspace_mode: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RawPlanGoal {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    line: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RawPlanThread {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    goal: Option<String>,
    #[serde(default)]
    tasks: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RawPlanFile {
    #[serde(default)]
    goal: Option<RawPlanGoal>,
    #[serde(default)]
    tasks: BTreeMap<String, String>,
    #[serde(default)]
    threads: Vec<RawPlanThread>,
}

#[derive(Debug, Deserialize)]
struct RawBoardLine {
    seq: u64,
    #[serde(default)]
    agent: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    time: String,
    #[serde(default)]
    kind: Option<String>,
}

fn derive_member_state(raw: &RawMember) -> SwarmMemberState {
    if raw.killed || raw.phase.eq_ignore_ascii_case("KILLED") {
        SwarmMemberState::Killed
    } else if !raw.phase.eq_ignore_ascii_case("RUNNING") {
        SwarmMemberState::Stopped
    } else if raw.wake_mode.as_deref() == Some("working") {
        SwarmMemberState::Working
    } else {
        SwarmMemberState::Waiting
    }
}

fn non_empty(opt: Option<String>) -> Option<String> {
    opt.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub(crate) struct SwarmReader {
    base_dir: PathBuf,
    session_id: String,
    swarm_id: Option<String>,
    created_at: Option<String>,
    swarm_stamp: Option<FileStamp>,
    members_stamp: Option<FileStamp>,
    plan_stamp: Option<FileStamp>,
    title: Option<String>,
    members: Vec<SwarmMember>,
    plan: Option<SwarmPlan>,
    board_offset: u64,
    board_identity: Option<(u64, u64)>,
    board_head: Vec<u8>,
    board_messages: VecDeque<SwarmMessage>,
    board_total: u64,
}

impl SwarmReader {
    pub(crate) fn new(base_dir: PathBuf, session_id: String) -> Self {
        Self {
            base_dir,
            session_id,
            swarm_id: None,
            created_at: None,
            swarm_stamp: None,
            members_stamp: None,
            plan_stamp: None,
            title: None,
            members: Vec::new(),
            plan: None,
            board_offset: 0,
            board_identity: None,
            board_head: Vec::new(),
            board_messages: VecDeque::new(),
            board_total: 0,
        }
    }

    fn reset_board(&mut self) {
        self.board_offset = 0;
        self.board_identity = None;
        self.board_head.clear();
        self.board_messages.clear();
        self.board_total = 0;
    }

    fn swarm_file(&self, name: &str) -> Option<PathBuf> {
        check_non_symlink_chain(&self.base_dir, &["brain", &self.session_id, ".system_generated", "swarm", name], true)
    }

    pub(crate) fn has_swarm_file(&self) -> bool {
        self.swarm_file("swarm.json").is_some()
    }

    fn refresh_meta(&mut self, path: &Path) {
        let Some(stamp) = file_stamp(path) else { return };
        if self.swarm_stamp == Some(stamp) {
            return;
        }
        let Ok(raw_text) = std::fs::read_to_string(path) else { return };
        let Ok(parsed) = serde_json::from_str::<RawSwarmMeta>(&raw_text) else {
            return;
        };
        self.swarm_id = non_empty(parsed.swarm_id);
        self.created_at = non_empty(parsed.created_at);
        self.swarm_stamp = Some(stamp);
    }

    fn refresh_members(&mut self) {
        let Some(path) = self.swarm_file("members.json") else {
            self.members.clear();
            self.title = None;
            self.members_stamp = None;
            return;
        };
        let Some(stamp) = file_stamp(&path) else { return };
        if self.members_stamp == Some(stamp) {
            return;
        }
        let Ok(raw_text) = std::fs::read_to_string(&path) else { return };
        let Ok(parsed) = serde_json::from_str::<RawMembersFile>(&raw_text) else {
            return;
        };
        let mut list: Vec<SwarmMember> = parsed
            .members
            .into_iter()
            .map(|(name, m)| {
                let state = derive_member_state(&m);
                let model = non_empty(m.applied_model).or_else(|| non_empty(m.model)).or_else(|| non_empty(m.desired_model));
                let role = if m.role.trim().is_empty() {
                    if name == "coordinator" { "coordinator".into() } else { "worker".into() }
                } else {
                    m.role.trim().to_string()
                };
                SwarmMember {
                    name,
                    conversation_id: m.conversation_id,
                    role,
                    state,
                    wake_mode: non_empty(m.wake_mode),
                    wait_since: m.wait_since,
                    last_read_seq: m.last_read_seq,
                    model,
                    workspace_mode: non_empty(m.workspace_mode),
                    task: None,
                }
            })
            .collect();
        list.sort_by(|a, b| {
            let a_coord = a.role == "coordinator";
            let b_coord = b.role == "coordinator";
            b_coord.cmp(&a_coord).then_with(|| a.name.cmp(&b.name))
        });
        self.title = non_empty(parsed.title);
        self.members = list;
        self.members_stamp = Some(stamp);
    }

    fn refresh_plan(&mut self) {
        let Some(path) = self.swarm_file("plan.json") else {
            self.plan = None;
            self.plan_stamp = None;
            return;
        };
        let Some(stamp) = file_stamp(&path) else { return };
        if self.plan_stamp == Some(stamp) {
            return;
        }
        let Ok(raw_text) = std::fs::read_to_string(&path) else { return };
        let Ok(parsed) = serde_json::from_str::<RawPlanFile>(&raw_text) else { return };
        let goal_title = parsed.goal.as_ref().and_then(|g| non_empty(g.title.clone()));
        let goal_line = parsed.goal.as_ref().and_then(|g| non_empty(g.line.clone()));
        let tasks = parsed
            .tasks
            .into_iter()
            .filter_map(|(k, v)| clamp_text(&v, STEP_TEXT_CAP).map(|t| (k, t)))
            .collect();
        let threads = parsed
            .threads
            .into_iter()
            .map(|t| SwarmPlanThread {
                id: t.id,
                title: t.title,
                goal: non_empty(t.goal),
                tasks: t.tasks,
            })
            .collect();
        self.plan = Some(SwarmPlan {
            goal_title,
            goal_line,
            tasks,
            threads,
        });
        self.plan_stamp = Some(stamp);
    }

    fn refresh_board(&mut self) {
        let Some(path) = self.swarm_file("board.jsonl") else {
            self.reset_board();
            return;
        };
        let Ok(meta) = std::fs::symlink_metadata(&path) else { return };
        if meta.file_type().is_symlink() || !meta.is_file() {
            return;
        }
        let identity = (meta.dev(), meta.ino());
        let len = meta.len();
        if self.board_identity.is_some_and(|prev| prev != identity) || len < self.board_offset {
            self.reset_board();
        }
        if len == self.board_offset && self.board_identity == Some(identity) {
            return;
        }
        let Ok(mut file) = File::open(&path) else { return };
        let Ok(open_meta) = file.metadata() else { return };
        if (open_meta.dev(), open_meta.ino()) != identity {
            return;
        }
        if !self.board_head.is_empty() {
            let mut probe = vec![0u8; self.board_head.len()];
            if file.read_exact(&mut probe).is_err() || probe != self.board_head {
                self.reset_board();
            }
        }
        if file.seek(SeekFrom::Start(self.board_offset)).is_err() {
            return;
        }
        let mut buf = Vec::new();
        if file.take(BOARD_READ_CAP as u64).read_to_end(&mut buf).is_err() {
            return;
        }
        if self.board_offset == 0 {
            self.board_head = buf.iter().take(64).copied().collect();
        }
        self.board_identity = Some(identity);

        let mut pos = 0usize;
        while pos < buf.len() {
            if let Some(rel_nl) = buf[pos..].iter().position(|&b| b == b'\n') {
                let line_slice = &buf[pos..pos + rel_nl];
                pos += rel_nl + 1;
                self.absorb_board_line(line_slice);
            } else {
                // Trailing bytes without `\n`: accept if already complete JSON, else
                // pause `board_offset` here so the next poll reads the finished line.
                let tail = &buf[pos..];
                if self.absorb_board_line(tail) {
                    pos = buf.len();
                }
                break;
            }
        }
        self.board_offset += pos as u64;
    }

    fn absorb_board_line(&mut self, bytes: &[u8]) -> bool {
        let text = String::from_utf8_lossy(bytes);
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return true;
        }
        let Ok(raw) = serde_json::from_str::<RawBoardLine>(trimmed) else {
            return false;
        };
        let msg = SwarmMessage {
            seq: raw.seq,
            agent: raw.agent,
            text: clamp_text(&raw.text, STEP_TEXT_CAP).unwrap_or_default(),
            time: raw.time,
            kind: non_empty(raw.kind),
        };
        self.board_total += 1;
        if self.board_messages.len() == BOARD_WINDOW_CAP {
            self.board_messages.pop_front();
        }
        self.board_messages.push_back(msg);
        true
    }

    pub(crate) fn poll_snapshot(&mut self) -> Option<SwarmSnapshot> {
        let meta_path = self.swarm_file("swarm.json")?;
        self.refresh_meta(&meta_path);
        self.refresh_members();
        self.refresh_plan();
        self.refresh_board();

        let mut members = self.members.clone();
        if let Some(plan) = &self.plan {
            for member in &mut members {
                if let Some(task) = plan.tasks.get(&member.name) {
                    member.task = Some(task.clone());
                }
            }
        }

        let mut working_count = 0u32;
        let mut waiting_count = 0u32;
        let mut stopped_count = 0u32;
        let mut killed_count = 0u32;
        for m in &members {
            match m.state {
                SwarmMemberState::Working => working_count += 1,
                SwarmMemberState::Waiting => waiting_count += 1,
                SwarmMemberState::Stopped => stopped_count += 1,
                SwarmMemberState::Killed => killed_count += 1,
            }
        }

        Some(SwarmSnapshot {
            swarm_id: self.swarm_id.clone().unwrap_or_else(|| self.session_id.clone()),
            title: self.title.clone(),
            created_at: self.created_at.clone(),
            members,
            working_count,
            waiting_count,
            stopped_count,
            killed_count,
            plan: self.plan.clone(),
            messages: self.board_messages.iter().cloned().collect(),
            total_messages: self.board_total,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_swarm_dir(base: &Path, session_id: &str) -> PathBuf {
        let dir = base.join("brain").join(session_id).join(".system_generated").join("swarm");
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn make_logs_dir(base: &Path, conv_id: &str) -> PathBuf {
        let dir = base.join("brain").join(conv_id).join(".system_generated").join("logs");
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn swarm_reader_derives_states_sorts_members_and_tails_board_incrementally() {
        let dir = tempfile::tempdir().unwrap();
        let mut reader = SwarmReader::new(dir.path().to_path_buf(), "sess-root".into());
        assert_eq!(reader.poll_snapshot(), None);

        let swarm = make_swarm_dir(dir.path(), "sess-root");
        std::fs::write(
            swarm.join("swarm.json"),
            r#"{"version":1,"backend":"local","swarm_id":"sw-42","created_at":"2026-11-22T01:00:00Z"}"#,
        )
        .unwrap();
        std::fs::write(
            swarm.join("members.json"),
            r#"{
                "title": "Swarm V1",
                "members": {
                    "zebra": {"conversation_id":"c-z","role":"worker","phase":"RUNNING","wake_mode":"mentions","wait_since":3,"last_read_seq":3,"killed":false,"model":"gemini-3-pro","workspace_mode":"inherit"},
                    "coordinator": {"conversation_id":"c-coord","role":"coordinator","phase":"RUNNING","wake_mode":"working","killed":false,"applied_model":"gemini-4-neon","workspace_mode":"inherit"},
                    "alpha": {"conversation_id":"c-a","role":"worker","phase":"STOPPED","wake_mode":"mentions","killed":false,"desired_model":"gemini-3-flash","workspace_mode":"share"},
                    "old": {"conversation_id":"c-o","role":"worker","phase":"RUNNING","wake_mode":"working","killed":true,"workspace_mode":"branch"}
                }
            }"#,
        )
        .unwrap();
        std::fs::write(
            swarm.join("plan.json"),
            r#"{
                "goal": {"title": "Ship Swarm V1", "line": "Zero DB tables"},
                "tasks": {"zebra": "Implement OAR layer"},
                "threads": [{"id": "t1", "title": "Layer 1+2", "goal": "OAR sidecar", "tasks": ["zebra"]}]
            }"#,
        )
        .unwrap();

        // Write 1 complete line + 1 half-written trailing line.
        let board_path = swarm.join("board.jsonl");
        std::fs::write(
            &board_path,
            "{\"seq\":1,\"agent\":\"coordinator\",\"text\":\"@zebra start\",\"time\":\"13:00:00\",\"kind\":\"brief\"}\n{\"seq\":2,\"agent\":\"zeb",
        )
        .unwrap();

        let snap1 = reader.poll_snapshot().expect("snapshot present");
        assert_eq!(snap1.swarm_id, "sw-42");
        assert_eq!(snap1.title.as_deref(), Some("Swarm V1"));
        assert_eq!(snap1.working_count, 1);
        assert_eq!(snap1.waiting_count, 1);
        assert_eq!(snap1.stopped_count, 1);
        assert_eq!(snap1.killed_count, 1);

        let names: Vec<&str> = snap1.members.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["coordinator", "alpha", "old", "zebra"]);
        assert_eq!(snap1.members[0].state, SwarmMemberState::Working);
        assert_eq!(snap1.members[0].model.as_deref(), Some("gemini-4-neon"));
        assert_eq!(snap1.members[1].state, SwarmMemberState::Stopped);
        assert_eq!(snap1.members[2].state, SwarmMemberState::Killed);
        assert_eq!(snap1.members[3].state, SwarmMemberState::Waiting);
        assert_eq!(snap1.members[3].task.as_deref(), Some("Implement OAR layer"));
        assert_eq!(snap1.messages.len(), 1);
        assert_eq!(snap1.messages[0].seq, 1);
        assert_eq!(snap1.messages[0].kind.as_deref(), Some("brief"));
        assert_eq!(snap1.total_messages, 1);

        // Finish writing line 2 + append line 3; incremental tail must pick up both.
        let mut f = std::fs::OpenOptions::new().append(true).open(&board_path).unwrap();
        write!(
            f,
            "ra\",\"text\":\"[done] finished\",\"time\":\"13:01:00\"}}\n{{\"seq\":3,\"agent\":\"coordinator\",\"text\":\"@all nice\",\"time\":\"13:02:00\"}}\n"
        )
        .unwrap();
        drop(f);

        let snap2 = reader.poll_snapshot().expect("snapshot after tail");
        assert_eq!(snap2.messages.len(), 3);
        assert_eq!(snap2.messages[1].seq, 2);
        assert_eq!(snap2.messages[1].agent, "zebra");
        assert_eq!(snap2.messages[2].seq, 3);
        assert_eq!(snap2.total_messages, 3);

        // Shrink / rewrite board.jsonl -> offset resets cleanly.
        std::fs::write(&board_path, "{\"seq\":10,\"agent\":\"coordinator\",\"text\":\"fresh\",\"time\":\"14:00:00\"}\n").unwrap();
        let snap3 = reader.poll_snapshot().expect("snapshot after shrink");
        assert_eq!(snap3.messages.len(), 1);
        assert_eq!(snap3.messages[0].seq, 10);
        assert_eq!(snap3.total_messages, 1);

        // Window cap at BOARD_WINDOW_CAP (200) while preserving total_messages.
        let mut bulk = String::new();
        for seq in 1..=230u64 {
            bulk.push_str(&format!("{{\"seq\":{seq},\"agent\":\"w\",\"text\":\"msg {seq}\",\"time\":\"14:00\"}}\n"));
        }
        std::fs::write(&board_path, bulk).unwrap();
        let snap4 = reader.poll_snapshot().expect("snapshot capped");
        assert_eq!(snap4.total_messages, 230);
        assert_eq!(snap4.messages.len(), BOARD_WINDOW_CAP);
        assert_eq!(snap4.messages.first().unwrap().seq, 31);
        assert_eq!(snap4.messages.last().unwrap().seq, 230);
    }

    #[test]
    fn read_child_transcript_enforces_256kib_tail_4000_char_cap_and_safety() {
        let dir = tempfile::tempdir().unwrap();
        let logs = make_logs_dir(dir.path(), "conv-big");
        let path = logs.join("transcript.jsonl");

        // Write > 300 KiB of steps, with a > 4500-char content field + inline data image + malformed trailing line.
        let mut out = String::new();
        let filler = "a".repeat(3_500);
        for i in 1..=95u64 {
            out.push_str(&format!(
                "{{\"step_index\":{i},\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"status\":\"DONE\",\"created_at\":\"13:00\",\"model\":\"gemini-4\",\"input_tokens\":100,\"cache_read_tokens\":50,\"output_tokens\":25,\"thinking\":\"plan {i}\",\"content\":\"{filler}\",\"tool_calls\":[{{\"name\":\"read_file\",\"args\":{{\"Path\":\"src/lib.rs\"}}}}]}}\n"
            ));
        }
        let huge = format!("BEGIN-{} data:image/png;base64,AAAABBBB", "z".repeat(4_500));
        out.push_str(&format!(
            "{{\"step_index\":96,\"source\":\"MODEL\",\"type\":\"ERROR_MESSAGE\",\"error\":{{\"message\":\"boom\"}},\"content\":\"{huge}\"}}\n"
        ));
        out.push_str("{\"step_index\":97,\"source\":\"MODEL\""); // truncated trailing line
        assert!(out.len() > TRANSCRIPT_BYTE_CAP);
        std::fs::write(&path, out).unwrap();

        let steps = read_child_transcript(dir.path(), "conv-big", 100);
        assert_eq!(steps.len(), MAX_STEPS);
        let last = steps.last().unwrap();
        assert_eq!(last.step_index, 96);
        assert_eq!(last.error.as_deref(), Some("boom"));
        let content = last.content.as_deref().unwrap();
        assert!(content.chars().count() <= STEP_TEXT_CAP + 1);
        assert!(content.ends_with('…'));

        let prev = &steps[steps.len() - 2];
        assert_eq!(prev.step_index, 95);
        assert_eq!(prev.tool_calls.len(), 1);
        assert_eq!(prev.tool_calls[0].name, "read_file");
        assert_eq!(prev.tool_calls[0].summary.as_deref(), Some("src/lib.rs"));

        // Explicit smaller limit respected.
        let small = read_child_transcript(dir.path(), "conv-big", 5);
        assert_eq!(small.len(), 5);
        assert_eq!(small.first().unwrap().step_index, 92);

        // Traversal and symlink rejection.
        assert!(read_child_transcript(dir.path(), "../escape", 10).is_empty());
        assert!(read_child_transcript(dir.path(), "a/b", 10).is_empty());
        let linked_logs = make_logs_dir(dir.path(), "conv-link");
        std::os::unix::fs::symlink(&path, linked_logs.join("transcript.jsonl")).unwrap();
        assert!(read_child_transcript(dir.path(), "conv-link", 10).is_empty());
    }
}
