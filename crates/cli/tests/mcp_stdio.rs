//! End-to-end stdio MCP tests for `vibevalley mcp`:
//! spawns the real CLI binary over piped stdin/stdout against a mock VibeValley HTTP server
//! and a mock loopback VDP WebSocket server, verifying JSON-RPC 2.0 framing, Issues CRUD,
//! VDP live inspection + screenshot image content block, error resilience, and zero token leakage.

use std::collections::{BTreeMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Arc;

use axum::Router;
use axum::extract::ws::{Message as AxumWsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use base64::Engine;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_util::sync::{CancellationToken, DropGuard};
use vibevalley_core::artifact::{apply_json_merge_patch, infer_mime, type_spec};
use vibevalley_protocol::{
    Applied, AppliedIssue, Artifact, ArtifactFileContent, ArtifactFileDeleteRequest, ArtifactFileDeleteResult, ArtifactFileEncoding, ArtifactFileGetRequest,
    ArtifactFileListRequest, ArtifactFileListResult, ArtifactFileMeta, ArtifactFileWriteRequest, ArtifactFileWriteResult, ArtifactGetInput,
    ArtifactListRequest, ArtifactRequest, ArtifactSaid, ArtifactSuggestionAcceptInput, ArtifactSuggestionCreateInput, ArtifactSuggestionListInput,
    ArtifactVersion, ArtifactVersionRequest, Assignment, Attachment, AttachmentUpload, Deliverable, Issue, IssueCommentCreateInput, IssueConversationGetInput,
    IssueFilter, IssueGetInput, IssueMandate, IssueRequest, IssueStage, IssueStageKind, IssueStatus, IssueStatusUpdateInput, IssueUpdateInput, MandateStrength,
    Priority, SayRequest, Suggestion, SuggestionChange, SuggestionStatus, VDP_PROTOCOL_VERSION, VdpCommand, VdpEndpointInfo, VdpError, VdpInputResult,
    VdpRequest, VdpResponse, VdpScreenshotResult, VdpTarget, VdpTargetKind, VdpTargetListResult, VdpUiBounds, VdpUiNode, VdpUiPressResult, VdpUiQueryResult,
    VdpVersionInfo, home,
};

// ---------------------------------------------------------------------------
// Mock VibeValley HTTP RPC Server (Issues + Artifacts + Attachments + Channel)
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct MockFileEntry {
    content: String,
    encoding: ArtifactFileEncoding,
    mime: String,
    hash: String,
    updated_at: i64,
}

#[derive(Clone)]
struct MockArtifactRecord {
    wire: Artifact,
    files: BTreeMap<String, MockFileEntry>,
    version_snapshots: BTreeMap<i64, BTreeMap<String, MockFileEntry>>,
    human_touched: HashSet<String>,
    commits: Vec<(i64, Option<String>, Vec<String>)>,
    suggestions: Vec<Suggestion>,
}

fn mock_hash(content: &str) -> String {
    let mut h1: u64 = 0xcbf29ce484222325;
    let mut h2: u64 = 0x84222325cbf29ce4;
    for &b in content.as_bytes() {
        h1 ^= b as u64;
        h1 = h1.wrapping_mul(0x100000001b3);
        h2 = h2.wrapping_mul(31).wrapping_add(b as u64);
    }
    format!("{h1:016x}{h2:016x}")
}

fn mock_file_entry(path: &str, content: String, encoding: Option<ArtifactFileEncoding>, mime: Option<String>, ts: i64) -> MockFileEntry {
    let enc = encoding.unwrap_or(ArtifactFileEncoding::Utf8);
    let m = mime.unwrap_or_else(|| infer_mime(path).to_owned());
    let hash = mock_hash(&content);
    MockFileEntry {
        content,
        encoding: enc,
        mime: m,
        hash,
        updated_at: ts,
    }
}

fn file_meta(path: &str, entry: &MockFileEntry) -> ArtifactFileMeta {
    ArtifactFileMeta {
        path: path.to_owned(),
        mime: entry.mime.clone(),
        size: entry.content.len() as i64,
        hash: entry.hash.clone(),
        updated_at: entry.updated_at,
    }
}

#[derive(Clone)]
struct MockIssueState {
    issues: Arc<Mutex<Vec<Issue>>>,
    comments: Arc<Mutex<Vec<(String, String)>>>,
    channel_messages: Arc<Mutex<Vec<SayRequest>>>,
    attachments: Arc<Mutex<Vec<Attachment>>>,
    artifacts: Arc<Mutex<Vec<MockArtifactRecord>>>,
    next_number: Arc<Mutex<i64>>,
    next_suggestion: Arc<Mutex<i64>>,
}

impl MockIssueState {
    fn new() -> Self {
        Self {
            issues: Arc::new(Mutex::new(Vec::new())),
            comments: Arc::new(Mutex::new(Vec::new())),
            channel_messages: Arc::new(Mutex::new(Vec::new())),
            attachments: Arc::new(Mutex::new(Vec::new())),
            artifacts: Arc::new(Mutex::new(Vec::new())),
            next_number: Arc::new(Mutex::new(1)),
            next_suggestion: Arc::new(Mutex::new(1)),
        }
    }

    fn make_issue(&self, req: IssueRequest) -> Issue {
        let mut next = self.next_number.lock();
        let number = *next;
        *next += 1;
        let id = format!("iss-{number}");
        let assignments = req
            .agent
            .map(|agent| {
                vec![Assignment {
                    id: format!("asg-{number}"),
                    issue: id.clone(),
                    agent,
                    assigned_at: 1_700_000_000_000,
                    ended_at: None,
                    executions: Vec::new(),
                }]
            })
            .unwrap_or_default();
        Issue {
            constraints: req.constraints,
            id,
            number,
            title: req.title,
            description: req.description.unwrap_or_default(),
            mandate: IssueMandate {
                origin_trigger_id: None,
                strength: MandateStrength::Explicit,
                max_bot_review_rounds: 0,
                auto_submit_pr: false,
                pause: None,
            },
            conflict: None,
            repo: req.repo,
            machine_id: req.machine_id,
            assignments,
            priority: req.priority.unwrap_or(Priority::Medium),
            rank: Some(number),
            created_at: 1_700_000_000_000,
            queued_at: None,
            closed_at: None,
            delivered: None,
            canceled: None,
            parent: req.parent,
            blocked_by: req.blocked_by.unwrap_or_default(),
            relations: req.relations.unwrap_or_default(),
            cron: None,
            status: IssueStatus::Backlog,
            moves: vec![IssueStatus::Todo, IssueStatus::Canceled],
            pull_request: None,
            deliver: req.deliver.unwrap_or(Deliverable::Change),
            reviewed_at: None,
            delivery_evidence: None,
            findings: Vec::new(),
            questions: Vec::new(),
            criteria: req.criteria.unwrap_or_default(),
            checks: Vec::new(),
            refining: None,
            last_run: None,
            answer: None,
            stage: IssueStage {
                state: IssueStageKind::Draft,
                since: None,
                stuck: None,
                lead: None,
                acts: Vec::new(),
            },
            attachments: Vec::new(),
            tags: req.tags.unwrap_or_default(),
            start_at: req.start_at,
            due_at: req.due_at,
            owner: req.owner.or_else(|| Some(vibevalley_protocol::ActorRef::self_user())),
        }
    }
}

fn ok_envelope(data: impl serde::Serialize) -> (StatusCode, axum::Json<Value>) {
    (
        StatusCode::OK,
        axum::Json(json!({
            "bizCode": 0,
            "message": "ok",
            "data": data,
        })),
    )
}

fn err_envelope(status: StatusCode, biz_code: u32, message: &str) -> (StatusCode, axum::Json<Value>) {
    (
        status,
        axum::Json(json!({
            "bizCode": biz_code,
            "message": message,
        })),
    )
}

fn find_issue_index(issues: &[Issue], id_or_num: &str) -> Option<usize> {
    let key = id_or_num.trim_start_matches('#');
    issues.iter().position(|i| i.id == key || i.number.to_string() == key)
}

async fn handle_issue_list(State(state): State<MockIssueState>, axum::Json(filter): axum::Json<IssueFilter>) -> impl IntoResponse {
    let issues = state.issues.lock();
    let mut matched: Vec<Issue> = issues
        .iter()
        .filter(|i| filter.status.is_none_or(|s| i.status == s))
        .filter(|i| filter.repo.as_deref().is_none_or(|r| i.repo.as_deref() == Some(r)))
        .filter(|i| filter.text.as_deref().is_none_or(|t| i.title.contains(t) || i.description.contains(t)))
        .cloned()
        .collect();
    if let Some(limit) = filter.limit {
        matched.truncate(limit.max(0) as usize);
    }
    ok_envelope(matched)
}

async fn handle_issue_get(State(state): State<MockIssueState>, axum::Json(input): axum::Json<IssueGetInput>) -> impl IntoResponse {
    let issues = state.issues.lock();
    match find_issue_index(&issues, &input.id) {
        Some(idx) => ok_envelope(issues[idx].clone()).into_response(),
        None => err_envelope(StatusCode::NOT_FOUND, 1004, &format!("issue not found: {}", input.id)).into_response(),
    }
}

async fn handle_issue_create(State(state): State<MockIssueState>, axum::Json(req): axum::Json<IssueRequest>) -> impl IntoResponse {
    let issue = state.make_issue(req);
    state.issues.lock().push(issue.clone());
    ok_envelope(AppliedIssue::from_issue(issue, 1))
}

async fn handle_issue_update(State(state): State<MockIssueState>, axum::Json(input): axum::Json<IssueUpdateInput>) -> impl IntoResponse {
    let mut issues = state.issues.lock();
    let Some(idx) = find_issue_index(&issues, &input.id) else {
        return err_envelope(StatusCode::NOT_FOUND, 1004, &format!("issue not found: {}", input.id)).into_response();
    };
    let issue = &mut issues[idx];
    if let Some(title) = input.title {
        issue.title = title;
    }
    if let Some(description) = input.description {
        issue.description = description;
    }
    if let Some(priority) = input.priority {
        issue.priority = priority;
    }
    if let Some(repo) = input.repo {
        issue.repo = Some(repo);
    }
    if let Some(criteria) = input.criteria {
        issue.criteria = criteria;
    }
    if let Some(owner) = input.owner {
        issue.owner = if owner.id().trim().is_empty() { None } else { Some(owner) };
    }
    ok_envelope(AppliedIssue::from_issue(issue.clone(), 2)).into_response()
}

async fn handle_issue_status_update(State(state): State<MockIssueState>, axum::Json(input): axum::Json<IssueStatusUpdateInput>) -> impl IntoResponse {
    let mut issues = state.issues.lock();
    let Some(idx) = find_issue_index(&issues, &input.id) else {
        return err_envelope(StatusCode::NOT_FOUND, 1004, &format!("issue not found: {}", input.id)).into_response();
    };
    let issue = &mut issues[idx];
    if let Some(edit) = input.edit {
        if let Some(title) = edit.title {
            issue.title = title;
        }
        if let Some(description) = edit.description {
            issue.description = description;
        }
        if let Some(priority) = edit.priority {
            issue.priority = priority;
        }
        if let Some(owner) = edit.owner {
            issue.owner = if owner.id().trim().is_empty() { None } else { Some(owner) };
        }
    }
    issue.status = input.status;
    ok_envelope(AppliedIssue::from_issue(issue.clone(), 3)).into_response()
}

async fn handle_issue_comment_create(State(state): State<MockIssueState>, axum::Json(input): axum::Json<IssueCommentCreateInput>) -> impl IntoResponse {
    let issues = state.issues.lock();
    let Some(idx) = find_issue_index(&issues, &input.id) else {
        return err_envelope(StatusCode::NOT_FOUND, 1004, &format!("issue not found: {}", input.id)).into_response();
    };
    let issue = issues[idx].clone();
    state.comments.lock().push((issue.id.clone(), input.text));
    ok_envelope(Applied { seq: 4 }).into_response()
}

async fn handle_issue_conversation_get(State(state): State<MockIssueState>, axum::Json(input): axum::Json<IssueConversationGetInput>) -> impl IntoResponse {
    let issues = state.issues.lock();
    let Some(idx) = find_issue_index(&issues, &input.id) else {
        return err_envelope(StatusCode::NOT_FOUND, 1004, &format!("issue not found: {}", input.id)).into_response();
    };
    ok_envelope(Some(format!("thread-{}", issues[idx].id))).into_response()
}

async fn handle_channel_message_send(State(state): State<MockIssueState>, axum::Json(req): axum::Json<SayRequest>) -> impl IntoResponse {
    state.channel_messages.lock().push(req);
    ok_envelope(Value::Null)
}

async fn handle_attachment_create(State(state): State<MockIssueState>, axum::Json(req): axum::Json<AttachmentUpload>) -> impl IntoResponse {
    let bytes = base64::engine::general_purpose::STANDARD.decode(req.data.trim()).unwrap_or_default();
    let mut list = state.attachments.lock();
    let att = Attachment {
        id: format!("att-{}", list.len() + 1),
        name: req.name,
        r#type: req.r#type,
        size: bytes.len() as i64,
    };
    list.push(att.clone());
    ok_envelope(att)
}

async fn handle_artifact_list(State(state): State<MockIssueState>, axum::Json(req): axum::Json<ArtifactListRequest>) -> impl IntoResponse {
    let list: Vec<Artifact> = state
        .artifacts
        .lock()
        .iter()
        .filter(|rec| req.artifact_type.is_none_or(|t| rec.wire.artifact_type == t))
        .filter(|rec| req.channel.as_deref().is_none_or(|c| rec.wire.channel.as_deref() == Some(c)))
        .filter(|rec| req.issue.as_deref().is_none_or(|i| rec.wire.issue.as_deref() == Some(i)))
        .map(|rec| rec.wire.clone())
        .collect();
    ok_envelope(list)
}

async fn handle_artifact_get(State(state): State<MockIssueState>, axum::Json(req): axum::Json<ArtifactGetInput>) -> impl IntoResponse {
    let artifacts = state.artifacts.lock();
    match artifacts.iter().find(|rec| rec.wire.id == req.id) {
        Some(rec) => ok_envelope(rec.wire.clone()).into_response(),
        None => err_envelope(StatusCode::NOT_FOUND, 1004, &format!("artifact not found: {}", req.id)).into_response(),
    }
}

async fn handle_artifact_create(State(state): State<MockIssueState>, axum::Json(req): axum::Json<ArtifactRequest>) -> impl IntoResponse {
    let mut artifacts = state.artifacts.lock();
    let idx = artifacts.len() + 1;
    let id = format!("art-{idx}");
    let spec = type_spec(req.artifact_type);
    let ts = 1_700_000_000_000 + idx as i64;
    let mut files = BTreeMap::new();
    let manifest = json!({
        "id": id,
        "artifactType": req.artifact_type,
        "title": req.title,
        "entry": spec.entry_path,
    })
    .to_string();
    files.insert(
        "manifest.json".to_owned(),
        mock_file_entry("manifest.json", manifest, Some(ArtifactFileEncoding::Utf8), Some("application/json".into()), ts),
    );
    let default_entry = if req.artifact_type == vibevalley_protocol::ArtifactType::Docs {
        format!("# {}\n", req.title)
    } else {
        json!({ "title": req.title, "nodes": [] }).to_string()
    };
    let entry_body = req.content.unwrap_or(default_entry);
    files.insert(
        spec.entry_path.to_owned(),
        mock_file_entry(spec.entry_path, entry_body, Some(ArtifactFileEncoding::Utf8), Some(spec.entry_mime.into()), ts),
    );
    if let Some(extra) = req.files {
        for item in extra {
            files.insert(item.path.clone(), mock_file_entry(&item.path, item.content, item.encoding, item.mime, ts));
        }
    }
    let ver1 = ArtifactVersion {
        version: 1,
        size: files.values().map(|f| f.content.len() as i64).sum(),
        note: req.note.clone().unwrap_or_default(),
        by: "agent:mcp".into(),
        by_name: "mcp".into(),
        at: ts,
        channel: req.channel.clone().unwrap_or_default(),
        number: req.announce.unwrap_or(false).then_some(1),
    };
    let wire = Artifact {
        id: id.clone(),
        title: req.title,
        artifact_type: req.artifact_type,
        is_default: req.is_default.unwrap_or(false),
        channel: req.channel.clone(),
        said: req.channel.map(|ch| ArtifactSaid { channel: ch, number: 1 }),
        issue: req.issue,
        by: "agent:mcp".into(),
        by_name: "mcp".into(),
        version: 1,
        seq: 1,
        versions: vec![ver1],
        at: ts,
        updated: ts,
        preview: None,
        cover: None,
    };
    let mut snapshots = BTreeMap::new();
    snapshots.insert(1, files.clone());
    let paths: Vec<String> = files.keys().cloned().collect();
    artifacts.push(MockArtifactRecord {
        wire: wire.clone(),
        files,
        version_snapshots: snapshots,
        human_touched: HashSet::new(),
        commits: vec![(1, Some("agent:mcp".into()), paths)],
        suggestions: Vec::new(),
    });
    ok_envelope(wire)
}

async fn handle_artifact_version_create(State(state): State<MockIssueState>, axum::Json(req): axum::Json<ArtifactVersionRequest>) -> impl IntoResponse {
    let mut artifacts = state.artifacts.lock();
    let Some(rec) = artifacts.iter_mut().find(|r| r.wire.id == req.id) else {
        return err_envelope(StatusCode::NOT_FOUND, 1004, &format!("artifact not found: {}", req.id)).into_response();
    };
    let next_ver = rec.wire.version + 1;
    let ts = rec.wire.updated + 1000;
    rec.wire.version = next_ver;
    rec.wire.updated = ts;
    rec.wire.versions.push(ArtifactVersion {
        version: next_ver,
        size: rec.files.values().map(|f| f.content.len() as i64).sum(),
        note: req.note.unwrap_or_default(),
        by: "agent:mcp".into(),
        by_name: "mcp".into(),
        at: ts,
        channel: rec.wire.channel.clone().unwrap_or_default(),
        number: None,
    });
    rec.version_snapshots.insert(next_ver, rec.files.clone());
    ok_envelope(rec.wire.clone()).into_response()
}

async fn handle_artifact_file_list(State(state): State<MockIssueState>, axum::Json(req): axum::Json<ArtifactFileListRequest>) -> impl IntoResponse {
    let artifacts = state.artifacts.lock();
    let Some(rec) = artifacts.iter().find(|r| r.wire.id == req.id) else {
        return err_envelope(StatusCode::NOT_FOUND, 1004, &format!("artifact not found: {}", req.id)).into_response();
    };
    let files: Vec<ArtifactFileMeta> = rec
        .files
        .iter()
        .filter(|(path, _)| req.prefix.as_deref().is_none_or(|p| path.starts_with(p)))
        .map(|(path, entry)| file_meta(path, entry))
        .collect();
    ok_envelope(ArtifactFileListResult {
        artifact_id: rec.wire.id.clone(),
        seq: rec.wire.seq,
        files,
    })
    .into_response()
}

async fn handle_artifact_file_get(State(state): State<MockIssueState>, axum::Json(req): axum::Json<ArtifactFileGetRequest>) -> impl IntoResponse {
    let artifacts = state.artifacts.lock();
    let Some(rec) = artifacts.iter().find(|r| r.wire.id == req.id) else {
        return err_envelope(StatusCode::NOT_FOUND, 1004, &format!("artifact not found: {}", req.id)).into_response();
    };
    let map = match req.version {
        Some(v) => match rec.version_snapshots.get(&v) {
            Some(snap) => snap,
            None => return err_envelope(StatusCode::NOT_FOUND, 1004, &format!("version not found: {v}")).into_response(),
        },
        None => &rec.files,
    };
    let Some(entry) = map.get(&req.path) else {
        return err_envelope(StatusCode::NOT_FOUND, 1004, &format!("file not found: {}", req.path)).into_response();
    };
    ok_envelope(ArtifactFileContent {
        artifact_id: rec.wire.id.clone(),
        path: req.path,
        mime: entry.mime.clone(),
        encoding: entry.encoding,
        content: entry.content.clone(),
        size: entry.content.len() as i64,
        hash: entry.hash.clone(),
        updated_at: entry.updated_at,
    })
    .into_response()
}

async fn handle_artifact_file_write(State(state): State<MockIssueState>, axum::Json(req): axum::Json<ArtifactFileWriteRequest>) -> impl IntoResponse {
    let mut artifacts = state.artifacts.lock();
    let Some(rec) = artifacts.iter_mut().find(|r| r.wire.id == req.id) else {
        return err_envelope(StatusCode::NOT_FOUND, 1004, &format!("artifact not found: {}", req.id)).into_response();
    };
    let is_agent = req.origin.as_deref() != Some("user");
    let mut direct_items = Vec::new();
    let mut diverted = Vec::new();
    for item in req.files {
        if let Some(expected) = item.expected_hash.as_deref() {
            let current = rec.files.get(&item.path).map(|f| f.hash.as_str()).unwrap_or("");
            if current != expected {
                return err_envelope(
                    StatusCode::BAD_REQUEST,
                    1005,
                    &format!("file {} changed concurrently (expected hash {expected}, current {current})", item.path),
                )
                .into_response();
            }
        }
        if is_agent && rec.human_touched.contains(&item.path) {
            let mut next_sug = state.next_suggestion.lock();
            let sug_id = format!("sug-{}", *next_sug);
            *next_sug += 1;
            let sug = Suggestion {
                id: sug_id,
                artifact_id: rec.wire.id.clone(),
                path: item.path.clone(),
                author: req.origin.clone().unwrap_or_else(|| "agent:mcp".into()),
                base_rev: rec.wire.seq,
                base_hash: rec.files.get(&item.path).map(|f| f.hash.clone()),
                change: SuggestionChange {
                    content: Some(item.content),
                    patch: None,
                    target: None,
                    delete: None,
                    summary: req.summary.clone(),
                },
                status: SuggestionStatus::Open,
                created_at: rec.wire.updated + 100,
                resolved_at: None,
                resolved_by: None,
                cursor_start: None,
                cursor_end: None,
                start_offset: None,
                end_offset: None,
            };
            rec.suggestions.push(sug.clone());
            diverted.push(sug);
        } else {
            direct_items.push(item);
        }
    }

    if direct_items.is_empty() {
        return ok_envelope(ArtifactFileWriteResult {
            artifact_id: rec.wire.id.clone(),
            seq: rec.wire.seq,
            files: Vec::new(),
            frontiers: None,
            suggestions: (!diverted.is_empty()).then_some(diverted),
        })
        .into_response();
    }

    let ts = rec.wire.updated + 500;
    let mut written_metas = Vec::new();
    let mut written_paths = Vec::new();
    for item in direct_items {
        let entry = mock_file_entry(&item.path, item.content, item.encoding, item.mime, ts);
        written_metas.push(file_meta(&item.path, &entry));
        written_paths.push(item.path.clone());
        rec.files.insert(item.path, entry);
    }
    rec.wire.seq += 1;
    rec.wire.updated = ts;
    let frontiers = format!("frontiers-{}", rec.wire.seq);
    rec.commits.push((rec.wire.seq, req.origin.clone(), written_paths));
    ok_envelope(ArtifactFileWriteResult {
        artifact_id: rec.wire.id.clone(),
        seq: rec.wire.seq,
        files: written_metas,
        frontiers: Some(frontiers),
        suggestions: (!diverted.is_empty()).then_some(diverted),
    })
    .into_response()
}

async fn handle_artifact_file_delete(State(state): State<MockIssueState>, axum::Json(req): axum::Json<ArtifactFileDeleteRequest>) -> impl IntoResponse {
    let mut artifacts = state.artifacts.lock();
    let Some(rec) = artifacts.iter_mut().find(|r| r.wire.id == req.id) else {
        return err_envelope(StatusCode::NOT_FOUND, 1004, &format!("artifact not found: {}", req.id)).into_response();
    };
    if rec.files.remove(&req.path).is_none() {
        return err_envelope(StatusCode::NOT_FOUND, 1004, &format!("file not found: {}", req.path)).into_response();
    }
    rec.wire.seq += 1;
    rec.commits.push((rec.wire.seq, req.origin, vec![req.path.clone()]));
    ok_envelope(ArtifactFileDeleteResult {
        artifact_id: rec.wire.id.clone(),
        seq: rec.wire.seq,
        path: req.path,
        frontiers: Some(format!("frontiers-{}", rec.wire.seq)),
    })
    .into_response()
}

async fn handle_artifact_suggestion_list(State(state): State<MockIssueState>, axum::Json(req): axum::Json<ArtifactSuggestionListInput>) -> impl IntoResponse {
    let artifacts = state.artifacts.lock();
    let Some(rec) = artifacts.iter().find(|r| r.wire.id == req.id) else {
        return err_envelope(StatusCode::NOT_FOUND, 1004, &format!("artifact not found: {}", req.id)).into_response();
    };
    ok_envelope(rec.suggestions.clone()).into_response()
}

async fn handle_artifact_suggestion_create(
    State(state): State<MockIssueState>,
    axum::Json(req): axum::Json<ArtifactSuggestionCreateInput>,
) -> impl IntoResponse {
    let mut artifacts = state.artifacts.lock();
    let Some(rec) = artifacts.iter_mut().find(|r| r.wire.id == req.id) else {
        return err_envelope(StatusCode::NOT_FOUND, 1004, &format!("artifact not found: {}", req.id)).into_response();
    };
    let mut next_sug = state.next_suggestion.lock();
    let sug_id = format!("sug-{}", *next_sug);
    *next_sug += 1;
    let sug = Suggestion {
        id: sug_id,
        artifact_id: rec.wire.id.clone(),
        path: req.path.clone(),
        author: "agent:mcp".into(),
        base_rev: req.base_rev,
        base_hash: req.base_hash.or_else(|| rec.files.get(&req.path).map(|f| f.hash.clone())),
        change: req.change,
        status: SuggestionStatus::Open,
        created_at: rec.wire.updated + 200,
        resolved_at: None,
        resolved_by: None,
        cursor_start: req.cursor_start,
        cursor_end: req.cursor_end,
        start_offset: req.start_offset,
        end_offset: req.end_offset,
    };
    rec.suggestions.push(sug.clone());
    ok_envelope(sug).into_response()
}

async fn handle_artifact_suggestion_accept(
    State(state): State<MockIssueState>,
    axum::Json(req): axum::Json<ArtifactSuggestionAcceptInput>,
) -> impl IntoResponse {
    let mut artifacts = state.artifacts.lock();
    let Some(rec) = artifacts.iter_mut().find(|r| r.wire.id == req.id) else {
        return err_envelope(StatusCode::NOT_FOUND, 1004, &format!("artifact not found: {}", req.id)).into_response();
    };
    let Some(idx) = rec.suggestions.iter().position(|s| s.id == req.suggestion) else {
        return err_envelope(StatusCode::NOT_FOUND, 1004, &format!("suggestion not found: {}", req.suggestion)).into_response();
    };
    let mut sug = rec.suggestions[idx].clone();
    let ts = rec.wire.updated + 300;
    if sug.change.delete == Some(true) {
        rec.files.remove(&sug.path);
    } else if let Some(patch_raw) = sug.change.patch.as_deref() {
        let current = rec.files.get(&sug.path).map(|f| f.content.as_str());
        let merged = apply_json_merge_patch(current, patch_raw).unwrap();
        let entry = mock_file_entry(&sug.path, merged, Some(ArtifactFileEncoding::Utf8), None, ts);
        rec.files.insert(sug.path.clone(), entry);
    } else if let Some(content) = sug.change.content.clone() {
        let entry = mock_file_entry(&sug.path, content, Some(ArtifactFileEncoding::Utf8), None, ts);
        rec.files.insert(sug.path.clone(), entry);
    }
    rec.wire.seq += 1;
    sug.status = SuggestionStatus::Accepted;
    sug.resolved_at = Some(ts);
    sug.resolved_by = Some("user".into());
    rec.suggestions[idx] = sug.clone();
    ok_envelope(sug).into_response()
}

async fn handle_artifact_suggestion_reject(
    State(state): State<MockIssueState>,
    axum::Json(req): axum::Json<ArtifactSuggestionAcceptInput>,
) -> impl IntoResponse {
    let mut artifacts = state.artifacts.lock();
    let Some(rec) = artifacts.iter_mut().find(|r| r.wire.id == req.id) else {
        return err_envelope(StatusCode::NOT_FOUND, 1004, &format!("artifact not found: {}", req.id)).into_response();
    };
    let Some(sug) = rec.suggestions.iter_mut().find(|s| s.id == req.suggestion) else {
        return err_envelope(StatusCode::NOT_FOUND, 1004, &format!("suggestion not found: {}", req.suggestion)).into_response();
    };
    sug.status = SuggestionStatus::Rejected;
    sug.resolved_at = Some(rec.wire.updated + 300);
    sug.resolved_by = Some("user".into());
    ok_envelope(sug.clone()).into_response()
}

struct MockIssueServer {
    url: String,
    comments: Arc<Mutex<Vec<(String, String)>>>,
    channel_messages: Arc<Mutex<Vec<SayRequest>>>,
    attachments: Arc<Mutex<Vec<Attachment>>>,
    artifacts: Arc<Mutex<Vec<MockArtifactRecord>>>,
    _guard: DropGuard,
}

impl MockIssueServer {
    fn start() -> Self {
        let state = MockIssueState::new();
        let comments = state.comments.clone();
        let channel_messages = state.channel_messages.clone();
        let attachments = state.attachments.clone();
        let artifacts = state.artifacts.clone();
        let (url, guard) = vibevalley_runtime::rt::block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let router = Router::new()
                .route("/api/v1/issue/list", post(handle_issue_list))
                .route("/api/v1/issue/get", post(handle_issue_get))
                .route("/api/v1/issue/create", post(handle_issue_create))
                .route("/api/v1/issue/update", post(handle_issue_update))
                .route("/api/v1/issue/status/update", post(handle_issue_status_update))
                .route("/api/v1/issue/comment/create", post(handle_issue_comment_create))
                .route("/api/v1/issue/conversation/get", post(handle_issue_conversation_get))
                .route("/api/v1/channel/message/send", post(handle_channel_message_send))
                .route("/api/v1/attachment/create", post(handle_attachment_create))
                .route("/api/v1/artifact/list", post(handle_artifact_list))
                .route("/api/v1/artifact/get", post(handle_artifact_get))
                .route("/api/v1/artifact/create", post(handle_artifact_create))
                .route("/api/v1/artifact/version/create", post(handle_artifact_version_create))
                .route("/api/v1/artifact/file/list", post(handle_artifact_file_list))
                .route("/api/v1/artifact/file/get", post(handle_artifact_file_get))
                .route("/api/v1/artifact/file/write", post(handle_artifact_file_write))
                .route("/api/v1/artifact/file/delete", post(handle_artifact_file_delete))
                .route("/api/v1/artifact/suggestion/list", post(handle_artifact_suggestion_list))
                .route("/api/v1/artifact/suggestion/create", post(handle_artifact_suggestion_create))
                .route("/api/v1/artifact/suggestion/accept", post(handle_artifact_suggestion_accept))
                .route("/api/v1/artifact/suggestion/reject", post(handle_artifact_suggestion_reject))
                .with_state(state);
            let cancel = CancellationToken::new();
            let guard = cancel.clone().drop_guard();
            tokio::spawn(async move {
                let _ = axum::serve(listener, router).with_graceful_shutdown(cancel.cancelled_owned()).await;
            });
            (format!("http://{addr}"), guard)
        });
        Self {
            url,
            comments,
            channel_messages,
            attachments,
            artifacts,
            _guard: guard,
        }
    }
}

// ---------------------------------------------------------------------------
// Mock Loopback VDP WebSocket Server
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct MockVdpState {
    info: VdpEndpointInfo,
    recorded: Arc<Mutex<Vec<VdpRequest>>>,
    png_bytes: Vec<u8>,
}

#[derive(Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

fn check_vdp_auth(headers: &HeaderMap, query: &TokenQuery, expected: &str) -> bool {
    if let Some(bearer) = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        && bearer == expected
    {
        return true;
    }
    query.token.as_deref() == Some(expected)
}

async fn handle_vdp_version(State(state): State<MockVdpState>, headers: HeaderMap, Query(query): Query<TokenQuery>) -> impl IntoResponse {
    if !check_vdp_auth(&headers, &query, &state.info.token) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    let version: VdpVersionInfo = state.info.version_info();
    (StatusCode::OK, axum::Json(version)).into_response()
}

async fn handle_vdp_ws(State(state): State<MockVdpState>, headers: HeaderMap, Query(query): Query<TokenQuery>, ws: WebSocketUpgrade) -> impl IntoResponse {
    if !check_vdp_auth(&headers, &query, &state.info.token) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    ws.on_upgrade(move |socket| drive_mock_vdp(socket, state))
}

async fn send_ws_json(socket: &mut WebSocket, value: &impl serde::Serialize) {
    let text = serde_json::to_string(value).unwrap();
    let _ = socket.send(AxumWsMessage::Text(text.into())).await;
}

async fn drive_mock_vdp(mut socket: WebSocket, state: MockVdpState) {
    while let Some(Ok(msg)) = socket.recv().await {
        let AxumWsMessage::Text(text) = msg else {
            continue;
        };
        let req: VdpRequest = match serde_json::from_str(text.as_str()) {
            Ok(req) => req,
            Err(err) => {
                send_ws_json(&mut socket, &VdpResponse::err(0, VdpError::parse_error(err.to_string()), None)).await;
                continue;
            }
        };
        state.recorded.lock().push(req.clone());

        if req.method == "Custom.echo" {
            let res = VdpResponse::ok(req.id, json!({ "echo": req.params, "sessionId": req.session_id }), req.session_id);
            send_ws_json(&mut socket, &res).await;
            continue;
        }
        if req.method == "Custom.leakCheck" {
            let res = VdpResponse::err(req.id, VdpError::internal(format!("boom token={}", state.info.token)), req.session_id);
            send_ws_json(&mut socket, &res).await;
            continue;
        }

        let cmd = match req.decode_command() {
            Ok(cmd) => cmd,
            Err(err) => {
                send_ws_json(&mut socket, &VdpResponse::err(req.id, err, req.session_id)).await;
                continue;
            }
        };

        match cmd {
            VdpCommand::TargetList => {
                let res = VdpTargetListResult {
                    targets: vec![
                        VdpTarget {
                            id: "shell".into(),
                            kind: VdpTargetKind::Shell,
                            title: "VibeValley".into(),
                            url: Some("/issues".into()),
                            attached: false,
                        },
                        VdpTarget {
                            id: "view:workbench".into(),
                            kind: VdpTargetKind::View,
                            title: "Workbench".into(),
                            url: Some("/issues".into()),
                            attached: true,
                        },
                    ],
                };
                send_ws_json(&mut socket, &VdpResponse::ok(req.id, serde_json::to_value(res).unwrap(), req.session_id)).await;
            }
            VdpCommand::ShellGetState => {
                let val = json!({
                    "route": "/issues",
                    "themeDark": false,
                    "width": 1440.0,
                    "height": 900.0,
                });
                send_ws_json(&mut socket, &VdpResponse::ok(req.id, val, req.session_id)).await;
            }
            VdpCommand::ShellNavigate(p) => {
                send_ws_json(&mut socket, &VdpResponse::ok(req.id, json!({ "ok": true, "route": p.route }), req.session_id)).await;
            }
            VdpCommand::ShellResize(p) => {
                send_ws_json(
                    &mut socket,
                    &VdpResponse::ok(req.id, json!({ "ok": true, "width": p.width, "height": p.height }), req.session_id),
                )
                .await;
            }
            VdpCommand::ShellSetTheme(p) => {
                send_ws_json(&mut socket, &VdpResponse::ok(req.id, json!({ "ok": true, "dark": p.dark }), req.session_id)).await;
            }
            VdpCommand::UiQuery(p) => {
                let out = VdpUiQueryResult {
                    view: p.view.unwrap_or_else(|| "workbench".into()),
                    nodes: vec![VdpUiNode {
                        test_id: Some("nav-issues".into()),
                        role: Some("button".into()),
                        text: Some("Issues".into()),
                        bounds: Some(VdpUiBounds {
                            x: 12.0,
                            y: 64.0,
                            width: 120.0,
                            height: 36.0,
                        }),
                        pressable: Some(true),
                        children: None,
                    }],
                };
                send_ws_json(&mut socket, &VdpResponse::ok(req.id, serde_json::to_value(out).unwrap(), req.session_id)).await;
            }
            VdpCommand::UiPress(p) => {
                let out = VdpUiPressResult {
                    view: p.view.unwrap_or_else(|| "workbench".into()),
                    test_id: p.test_id,
                    pressed: true,
                };
                send_ws_json(&mut socket, &VdpResponse::ok(req.id, serde_json::to_value(out).unwrap(), req.session_id)).await;
            }
            VdpCommand::PageCaptureScreenshot(p) => {
                let shot = VdpScreenshotResult {
                    mime: "image/png".into(),
                    data: base64::engine::general_purpose::STANDARD.encode(&state.png_bytes),
                    width: p.width.unwrap_or(1280),
                    height: p.height.unwrap_or(800),
                };
                send_ws_json(&mut socket, &VdpResponse::ok(req.id, serde_json::to_value(shot).unwrap(), req.session_id)).await;
            }
            VdpCommand::InputDispatchKey(_) | VdpCommand::InputTypeText(_) | VdpCommand::InputDispatchMouse(_) => {
                let out = VdpInputResult { handled: true };
                send_ws_json(&mut socket, &VdpResponse::ok(req.id, serde_json::to_value(out).unwrap(), req.session_id)).await;
            }
            _ => {
                send_ws_json(
                    &mut socket,
                    &VdpResponse::err(req.id, VdpError::unavailable("unimplemented in mock"), req.session_id),
                )
                .await;
            }
        }
    }
}

struct MockVdpHost {
    home_dir: tempfile::TempDir,
    info: VdpEndpointInfo,
    recorded: Arc<Mutex<Vec<VdpRequest>>>,
    png_bytes: Vec<u8>,
    _debug_guard: home::DebugEndpointGuard,
    _server_guard: DropGuard,
}

impl MockVdpHost {
    fn start(token: &str) -> Self {
        let home_dir = tempfile::tempdir().unwrap();
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let png_bytes = vec![
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, b'I', b'H', b'D', b'R', 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE,
        ];

        let (guard, info) = vibevalley_runtime::rt::block_on({
            let home_path = home_dir.path().to_path_buf();
            let token = token.to_string();
            let recorded = recorded.clone();
            let png_bytes = png_bytes.clone();
            async move {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let addr = listener.local_addr().unwrap();
                let info = VdpEndpointInfo {
                    protocol_version: VDP_PROTOCOL_VERSION.into(),
                    pid: std::process::id(),
                    channel: "dev".into(),
                    app_version: "0.1.0-mcp-test".into(),
                    home: home_path.display().to_string(),
                    port: addr.port(),
                    http_url: format!("http://127.0.0.1:{}", addr.port()),
                    ws_url: format!("ws://127.0.0.1:{}/devtools", addr.port()),
                    token,
                    started_at: 1_700_000_000_000,
                };
                let state = MockVdpState {
                    info: info.clone(),
                    recorded,
                    png_bytes,
                };
                let app = Router::new()
                    .route("/json/version", get(handle_vdp_version))
                    .route("/devtools", get(handle_vdp_ws))
                    .with_state(state);
                let cancel = CancellationToken::new();
                let guard = cancel.clone().drop_guard();
                tokio::spawn(async move {
                    let _ = axum::serve(listener, app).with_graceful_shutdown(cancel.cancelled_owned()).await;
                });
                (guard, info)
            }
        });

        let debug_guard = home::write_debug_endpoint(home_dir.path(), &info).unwrap();
        Self {
            home_dir,
            info,
            recorded,
            png_bytes,
            _debug_guard: debug_guard,
            _server_guard: guard,
        }
    }
}

// ---------------------------------------------------------------------------
// Stdio MCP Process Harness
// ---------------------------------------------------------------------------

struct McpProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}

impl McpProcess {
    fn spawn(home_dir: &Path, server_url: &str, extra_args: &[&str]) -> Self {
        let mut args = vec!["--server", server_url, "mcp"];
        args.extend_from_slice(extra_args);
        let mut child = Command::new(env!("CARGO_BIN_EXE_vibevalley"))
            .args(args)
            .env("VIBEVALLEY_HOME", home_dir)
            .env_remove("VIBEVALLEY_SERVER")
            .env_remove("VIBEVALLEY_REMOTE_TOKEN")
            .env_remove("VIBEVALLEY_TOKEN")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            stdin: Some(stdin),
            stdout,
        }
    }

    fn send_raw(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().unwrap();
        writeln!(stdin, "{line}").unwrap();
        stdin.flush().unwrap();
    }

    fn send(&mut self, msg: &Value) {
        self.send_raw(&serde_json::to_string(msg).unwrap());
    }

    fn recv(&mut self) -> Value {
        let mut line = String::new();
        let n = self.stdout.read_line(&mut line).unwrap();
        assert!(n > 0, "MCP server closed stdout unexpectedly");
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("invalid JSON on MCP stdout: {e}\nline: {line:?}"))
    }

    fn request(&mut self, id: u64, method: &str, params: Value) -> Value {
        self.send(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }));
        let resp = self.recv();
        assert_eq!(resp["jsonrpc"], "2.0", "{resp}");
        assert_eq!(resp["id"], id, "{resp}");
        resp
    }

    fn call_tool(&mut self, id: u64, name: &str, arguments: Value) -> Value {
        let resp = self.request(
            id,
            "tools/call",
            json!({
                "name": name,
                "arguments": arguments,
            }),
        );
        assert!(resp.get("error").is_none(), "unexpected JSON-RPC error for {name}: {resp}");
        resp["result"].clone()
    }

    fn finish(mut self) -> i32 {
        drop(self.stdin.take());
        let status = self.child.wait().unwrap();
        status.code().unwrap_or(-1)
    }
}

#[test]
fn mcp_stdio_end_to_end_issues_vdp_screenshot_and_security() {
    let secret_token = "vdp-super-secret-token-999";
    let issue_srv = MockIssueServer::start();
    let vdp_host = MockVdpHost::start(secret_token);
    let isolated_home = tempfile::tempdir().unwrap();
    let vdp_home_str = vdp_host.home_dir.path().to_str().unwrap();

    let mut mcp = McpProcess::spawn(isolated_home.path(), &issue_srv.url, &["--home", vdp_home_str]);

    // 1. Initialize handshake & notifications/initialized (must not emit a response).
    let init = mcp.request(
        1,
        "initialize",
        json!({
            "protocolVersion": "2025-03-26",
            "clientInfo": { "name": "agy-test", "version": "1.0.0" }
        }),
    );
    assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
    assert_eq!(init["result"]["serverInfo"]["name"], "vibevalley");
    assert!(init["result"]["capabilities"]["tools"].is_object());

    mcp.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));

    let ping = mcp.request(2, "ping", json!({}));
    assert_eq!(ping["result"], json!({}));

    // 2. tools/list exposes the complete Issues + VDP tool surface.
    let list_resp = mcp.request(3, "tools/list", json!({}));
    let tools = list_resp["result"]["tools"].as_array().unwrap();
    let tool_names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    for expected in [
        "vv_issue_list",
        "vv_issue_get",
        "vv_issue_create",
        "vv_issue_update",
        "vv_issue_comment",
        "vv_attachment_upload",
        "vv_artifact_list",
        "vv_artifact_get",
        "vv_artifact_create",
        "vv_artifact_read",
        "vv_artifact_write",
        "vv_artifact_patch",
        "vv_artifact_suggest",
        "vv_vdp_discover",
        "vv_vdp_targets",
        "vv_vdp_state",
        "vv_vdp_navigate",
        "vv_vdp_resize",
        "vv_vdp_theme",
        "vv_vdp_ui_query",
        "vv_vdp_ui_press",
        "vv_vdp_screenshot",
        "vv_vdp_input",
        "vv_vdp_call",
    ] {
        assert!(tool_names.contains(&expected), "missing tool {expected} in {tool_names:?}");
    }

    // 3. Issues workflow: create (with status transition), list (filtered by agent & status), get, update, comment.
    let created = mcp.call_tool(
        10,
        "vv_issue_create",
        json!({
            "title": "Fix rail active highlight",
            "description": "Captured via VDP scan",
            "priority": "high",
            "status": "todo",
            "repo": "vibevalley",
            "agent": "frontend",
            "owner": { "kind": "agent", "id": "frontend" },
            "criteria": ["Left indicator bar matches rail geometry"]
        }),
    );
    assert_ne!(created["isError"], true, "{created}");
    let created_json: Value = serde_json::from_str(created["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(created_json["number"], 1);
    assert_eq!(created_json["status"], "todo");
    assert_eq!(created_json["priority"], "high");
    assert_eq!(created_json["owner"], json!({ "kind": "agent", "id": "frontend" }));

    let _second = mcp.call_tool(
        11,
        "vv_issue_create",
        json!({
            "title": "Backend cleanup",
            "agent": "backend",
            "repo": "vibevalley"
        }),
    );

    let listed = mcp.call_tool(12, "vv_issue_list", json!({ "status": "todo", "agent": "frontend" }));
    assert_ne!(listed["isError"], true, "{listed}");
    let listed_json: Value = serde_json::from_str(listed["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(listed_json["count"], 1);
    assert_eq!(listed_json["issues"][0]["title"], "Fix rail active highlight");

    let got = mcp.call_tool(13, "vv_issue_get", json!({ "id": "#1" }));
    assert_ne!(got["isError"], true, "{got}");
    let got_json: Value = serde_json::from_str(got["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(got_json["criteria"], json!(["Left indicator bar matches rail geometry"]));

    let updated = mcp.call_tool(
        14,
        "vv_issue_update",
        json!({
            "id": "1",
            "title": "Fix rail active highlight (verified)",
            "status": "done",
            "priority": "medium",
            "owner": { "kind": "user", "id": "alice" }
        }),
    );
    assert_ne!(updated["isError"], true, "{updated}");
    let updated_json: Value = serde_json::from_str(updated["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(updated_json["status"], "done");
    assert_eq!(updated_json["title"], "Fix rail active highlight (verified)");
    assert_eq!(updated_json["owner"], json!({ "kind": "user", "id": "alice" }));

    let commented = mcp.call_tool(15, "vv_issue_comment", json!({ "issueId": "1", "text": "Verified on round 2 screenshot" }));
    assert_ne!(commented["isError"], true, "{commented}");
    assert_eq!(issue_srv.comments.lock().len(), 1);

    // Upload a local PNG via vv_attachment_upload and post a compare comment with attachments.
    let local_png = isolated_home.path().join("before.png");
    std::fs::write(&local_png, &vdp_host.png_bytes).unwrap();
    let uploaded = mcp.call_tool(16, "vv_attachment_upload", json!({ "path": local_png.to_str().unwrap(), "name": "before.png" }));
    assert_ne!(uploaded["isError"], true, "{uploaded}");
    let uploaded_json: Value = serde_json::from_str(uploaded["content"][0]["text"].as_str().unwrap()).unwrap();
    let before_att_id = uploaded_json["id"].as_str().unwrap().to_string();
    assert_eq!(uploaded_json["type"], "image/png");
    assert_eq!(uploaded_json["size"], vdp_host.png_bytes.len() as i64);

    let commented_with_att = mcp.call_tool(
        17,
        "vv_issue_comment",
        json!({
            "issueId": "1",
            "text": "Before/after comparison attached",
            "attachments": [before_att_id]
        }),
    );
    assert_ne!(commented_with_att["isError"], true, "{commented_with_att}");
    assert_eq!(issue_srv.channel_messages.lock().len(), 1);
    assert_eq!(issue_srv.channel_messages.lock()[0].attachments.as_deref(), Some(&["att-1".to_string()][..]));

    // 4. VDP live debugging: discover (no token leak!), targets, state, navigate, resize, theme, ui_query, ui_press, input, call.
    let discovered = mcp.call_tool(20, "vv_vdp_discover", json!({}));
    assert_ne!(discovered["isError"], true, "{discovered}");
    let disc_text = discovered["content"][0]["text"].as_str().unwrap();
    assert!(!disc_text.contains(secret_token), "vv_vdp_discover leaked token: {disc_text}");
    let disc_json: Value = serde_json::from_str(disc_text).unwrap();
    assert!(
        disc_json["instances"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["port"] == vdp_host.info.port && i.get("token").is_none()),
        "{disc_json}"
    );

    let targets = mcp.call_tool(21, "vv_vdp_targets", json!({}));
    let targets_json: Value = serde_json::from_str(targets["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(targets_json["targets"].as_array().unwrap().len(), 2);

    let state = mcp.call_tool(22, "vv_vdp_state", json!({}));
    let state_text = state["content"][0]["text"].as_str().unwrap();
    assert!(!state_text.contains(secret_token));
    let state_json: Value = serde_json::from_str(state_text).unwrap();
    assert_eq!(state_json["route"], "/issues");

    let nav = mcp.call_tool(23, "vv_vdp_navigate", json!({ "route": "/library" }));
    assert_ne!(nav["isError"], true, "{nav}");
    let resize = mcp.call_tool(24, "vv_vdp_resize", json!({ "width": 1280, "height": 800 }));
    assert_ne!(resize["isError"], true, "{resize}");
    let theme = mcp.call_tool(25, "vv_vdp_theme", json!({ "mode": "dark" }));
    assert_ne!(theme["isError"], true, "{theme}");

    let query = mcp.call_tool(26, "vv_vdp_ui_query", json!({ "testId": "nav-issues", "view": "workbench" }));
    let query_json: Value = serde_json::from_str(query["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(query_json["nodes"][0]["bounds"]["width"], 120.0);

    let press = mcp.call_tool(27, "vv_vdp_ui_press", json!({ "testId": "nav-issues" }));
    let press_json: Value = serde_json::from_str(press["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(press_json["pressed"], true);

    assert_ne!(mcp.call_tool(28, "vv_vdp_input", json!({ "kind": "key", "keys": "cmd-k" }))["isError"], true);
    assert_ne!(mcp.call_tool(29, "vv_vdp_input", json!({ "kind": "type", "text": "hello" }))["isError"], true);
    assert_ne!(
        mcp.call_tool(30, "vv_vdp_input", json!({ "kind": "click", "x": 100, "y": 200, "right": true }))["isError"],
        true
    );

    let raw = mcp.call_tool(
        31,
        "vv_vdp_call",
        json!({ "method": "Custom.echo", "params": { "a": 1 }, "sessionId": "sess-9" }),
    );
    let raw_json: Value = serde_json::from_str(raw["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(raw_json["echo"]["a"], 1);
    assert_eq!(raw_json["sessionId"], "sess-9");

    // 5. Screenshot returns BOTH inline MCP image block and text summary, writes exact PNG bytes to outPath,
    // and optionally uploads via attachment.create when uploadAttachment=true.
    let shot_dir = tempfile::tempdir().unwrap();
    let out_path = shot_dir.path().join("captures").join("live.png");
    let shot = mcp.call_tool(
        32,
        "vv_vdp_screenshot",
        json!({
            "target": "shell",
            "width": 1280,
            "height": 800,
            "outPath": out_path.to_str().unwrap(),
            "uploadAttachment": true
        }),
    );
    assert_ne!(shot["isError"], true, "{shot}");
    let blocks = shot["content"].as_array().unwrap();
    assert_eq!(blocks.len(), 2, "{shot}");
    assert_eq!(blocks[0]["type"], "image");
    assert_eq!(blocks[0]["mimeType"], "image/png");
    let decoded = base64::engine::general_purpose::STANDARD.decode(blocks[0]["data"].as_str().unwrap()).unwrap();
    assert_eq!(decoded, vdp_host.png_bytes);
    assert_eq!(std::fs::read(&out_path).unwrap(), vdp_host.png_bytes);
    let summary = blocks[1]["text"].as_str().unwrap();
    assert!(summary.contains("1280x800"), "{summary}");
    assert!(summary.contains(out_path.to_str().unwrap()), "{summary}");
    assert!(summary.contains("attachmentId=att-2"), "{summary}");
    assert!(!summary.contains(secret_token));
    assert_eq!(issue_srv.attachments.lock().len(), 2);

    // 6. Error resilience & secret scrubbing: RPC/VDP failures return isError: true without crashing the loop.
    let missing_issue = mcp.call_tool(40, "vv_issue_get", json!({ "id": "999" }));
    assert_eq!(missing_issue["isError"], true, "{missing_issue}");

    let empty_home = tempfile::tempdir().unwrap();
    let unreachable_vdp = mcp.call_tool(41, "vv_vdp_state", json!({ "home": empty_home.path().to_str().unwrap() }));
    assert_eq!(unreachable_vdp["isError"], true, "{unreachable_vdp}");

    let scrubbed_err = mcp.call_tool(42, "vv_vdp_call", json!({ "method": "Custom.leakCheck" }));
    assert_eq!(scrubbed_err["isError"], true, "{scrubbed_err}");
    let err_text = scrubbed_err["content"][0]["text"].as_str().unwrap();
    assert!(!err_text.contains(secret_token), "VDP error leaked token: {err_text}");
    assert!(err_text.contains("[redacted]"), "expected redaction marker: {err_text}");

    let bad_args = mcp.call_tool(43, "vv_vdp_resize", json!({ "width": -10, "height": 500 }));
    assert_eq!(bad_args["isError"], true, "{bad_args}");

    // Malformed JSON line yields JSON-RPC -32700 parse error and server continues serving.
    mcp.send_raw("{broken-json");
    let parse_err = mcp.recv();
    assert_eq!(parse_err["error"]["code"], -32700, "{parse_err}");

    let alive = mcp.request(44, "ping", json!({}));
    assert_eq!(alive["result"], json!({}));

    // Verify expected VDP methods reached the mock host.
    let recorded_methods: Vec<String> = vdp_host.recorded.lock().iter().map(|r| r.method.clone()).collect();
    assert!(recorded_methods.contains(&"Shell.getState".to_string()));
    assert!(recorded_methods.contains(&"Page.captureScreenshot".to_string()));
    assert!(recorded_methods.contains(&"UI.query".to_string()));
    assert!(recorded_methods.contains(&"UI.press".to_string()));

    assert_eq!(mcp.finish(), 0);
}

#[test]
fn mcp_stdio_end_to_end_artifacts_collab_suggestions_and_sep2640_skills() {
    let srv = MockIssueServer::start();
    let isolated_home = tempfile::tempdir().unwrap();
    let mut mcp = McpProcess::spawn(isolated_home.path(), &srv.url, &[]);

    // 1. SEP-2575 stateless discovery & SEP-2640 12 artifact skills.
    let discover = mcp.request(1, "server/discover", json!({}));
    assert_eq!(discover["result"]["stateless"], true, "{discover}");
    assert_eq!(
        discover["result"]["capabilities"]["extensions"]["io.modelcontextprotocol/skills"]["directoryRead"],
        true
    );

    let skills_list = mcp.request(2, "skills/list", json!({ "tag": "artifact" }));
    let skills = skills_list["result"]["skills"].as_array().unwrap();
    assert_eq!(skills.len(), 12, "{skills:?}");
    for slug in [
        "dashboard",
        "design",
        "design-system",
        "diagram",
        "docs",
        "motion",
        "outline",
        "prototype",
        "sheet",
        "slides",
        "storyboard",
        "whiteboard",
    ] {
        let expected_uri = format!("skill://artifact/{slug}");
        assert!(skills.iter().any(|s| s["uri"] == expected_uri), "missing {expected_uri}");
    }

    let skill_doc = mcp.request(3, "skills/get", json!({ "uri": "skill://artifact/outline" }));
    assert_eq!(skill_doc["result"]["uri"], "skill://artifact/outline");
    assert!(skill_doc["result"]["content"].as_str().unwrap().contains("outline"));

    let skill_ref = mcp.request(4, "skills/get", json!({ "uri": "skill://artifact/docs", "file": "references/structure.md" }));
    assert_eq!(skill_ref["result"]["uri"], "skill://artifact/docs/references/structure.md");
    assert!(!skill_ref["result"]["content"].as_str().unwrap().is_empty());

    let res_read = mcp.request(5, "resources/read", json!({ "uri": "skill://artifact/slides/SKILL.en.md" }));
    assert_eq!(res_read["result"]["contents"][0]["uri"], "skill://artifact/slides/SKILL.en.md");
    assert_eq!(res_read["result"]["contents"][0]["mimeType"], "text/markdown");

    // 2. tools/list exposes vv_artifact_* tools with SEP-2640 skill:// guidance.
    let list_resp = mcp.request(6, "tools/list", json!({}));
    let tools = list_resp["result"]["tools"].as_array().unwrap();
    let create_tool = tools.iter().find(|t| t["name"] == "vv_artifact_create").unwrap();
    assert!(create_tool["description"].as_str().unwrap().contains("skill://artifact/<type>"));
    assert!(create_tool["description"].as_str().unwrap().contains("skills/list"));

    // 3. Create docs and outline artifacts + reject invalid ArtifactType / invalid isDefault.
    let bad_type = mcp.call_tool(10, "vv_artifact_create", json!({ "title": "Bad", "artifactType": "bogus" }));
    assert_eq!(bad_type["isError"], true, "{bad_type}");

    let bad_default = mcp.call_tool(
        11,
        "vv_artifact_create",
        json!({ "title": "Not DS", "artifactType": "docs", "isDefault": true }),
    );
    assert_eq!(bad_default["isError"], true, "{bad_default}");

    let docs_created = mcp.call_tool(
        12,
        "vv_artifact_create",
        json!({
            "title": "MCP Architecture RFC",
            "artifactType": "docs",
            "content": "# Overview\nInitial draft.\n",
            "channel": "general",
            "issue": "#7",
            "announce": true,
            "note": "Initial RFC"
        }),
    );
    assert_ne!(docs_created["isError"], true, "{docs_created}");
    let docs_art: Value = serde_json::from_str(docs_created["content"][0]["text"].as_str().unwrap()).unwrap();
    let docs_id = docs_art["id"].as_str().unwrap().to_string();
    assert_eq!(docs_art["artifactType"], "docs");
    assert_eq!(docs_art["issue"], "7");

    let outline_created = mcp.call_tool(
        13,
        "vv_artifact_create",
        json!({
            "title": "Launch Outline",
            "artifactType": "outline",
            "content": "{\"title\":\"Launch Outline\",\"status\":\"draft\",\"nodes\":[]}",
            "files": [{ "path": "structure/notes.md", "content": "Extra notes" }]
        }),
    );
    assert_ne!(outline_created["isError"], true, "{outline_created}");
    let outline_art: Value = serde_json::from_str(outline_created["content"][0]["text"].as_str().unwrap()).unwrap();
    let outline_id = outline_art["id"].as_str().unwrap().to_string();

    // 4. vv_artifact_list filters cleanly.
    let listed = mcp.call_tool(14, "vv_artifact_list", json!({ "artifactType": "docs", "channel": "general", "issue": "#7" }));
    let listed_json: Value = serde_json::from_str(listed["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(listed_json["count"], 1, "{listed_json}");
    assert_eq!(listed_json["artifacts"][0]["id"], docs_id);

    // 5. vv_artifact_get returns metadata, manifest, files, versions, openSuggestions, and skillUri.
    let got = mcp.call_tool(15, "vv_artifact_get", json!({ "id": outline_id }));
    assert_ne!(got["isError"], true, "{got}");
    let got_json: Value = serde_json::from_str(got["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(got_json["skillUri"], "skill://artifact/outline");
    assert_eq!(got_json["manifest"]["artifactType"], "outline");
    assert_eq!(got_json["versions"].as_array().unwrap().len(), 1);
    assert!(got_json["files"].as_array().unwrap().iter().any(|f| f["path"] == "structure/notes.md"));

    // 6. vv_artifact_read reads entry file, prefix directory list, and specific path.
    let read_entry = mcp.call_tool(16, "vv_artifact_read", json!({ "id": docs_id, "includeFiles": true }));
    assert_ne!(read_entry["isError"], true, "{read_entry}");
    let read_entry_json: Value = serde_json::from_str(read_entry["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(read_entry_json["path"], "structure/index.md");
    assert_eq!(read_entry_json["content"], "# Overview\nInitial draft.\n");
    assert!(!read_entry_json["files"].as_array().unwrap().is_empty());

    let read_prefix = mcp.call_tool(17, "vv_artifact_read", json!({ "id": outline_id, "prefix": "structure/" }));
    let prefix_json: Value = serde_json::from_str(read_prefix["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(prefix_json["files"].as_array().unwrap().len(), 2);

    // 7. vv_artifact_write writes with origin attribution & version snapshot, enforces expectedHash, and deletes files.
    let written = mcp.call_tool(
        18,
        "vv_artifact_write",
        json!({
            "id": docs_id,
            "path": "structure/01-context.md",
            "content": "## Context\nLine A\nLine B\n",
            "origin": "session:s1:turn:2",
            "summary": "Add context section",
            "createVersion": true,
            "versionNote": "v2 with context"
        }),
    );
    assert_ne!(written["isError"], true, "{written}");
    let written_json: Value = serde_json::from_str(written["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(written_json["write"]["seq"], 2);
    assert_eq!(written_json["artifact"]["version"], 2);
    let context_hash = written_json["write"]["files"][0]["hash"].as_str().unwrap().to_string();

    // Version 1 snapshot preserves original files without 01-context.md.
    let v1_read = mcp.call_tool(
        19,
        "vv_artifact_read",
        json!({ "id": docs_id, "path": "structure/01-context.md", "version": 1 }),
    );
    assert_eq!(v1_read["isError"], true, "{v1_read}");

    // Stale expectedHash fails cleanly.
    let stale_write = mcp.call_tool(
        20,
        "vv_artifact_write",
        json!({
            "id": docs_id,
            "path": "structure/01-context.md",
            "content": "Overwrite",
            "expectedHash": "deadbeef"
        }),
    );
    assert_eq!(stale_write["isError"], true, "{stale_write}");

    // Delete auxiliary file in outline.
    let deleted_aux = mcp.call_tool(
        21,
        "vv_artifact_write",
        json!({
            "id": outline_id,
            "deletePath": "structure/notes.md",
            "origin": "agent:mcp-test",
            "summary": "Drop scratch notes"
        }),
    );
    assert_ne!(deleted_aux["isError"], true, "{deleted_aux}");

    // 8. vv_artifact_patch: JSON Merge Patch + targeted text find/replace & append with origin attribution.
    let json_patched = mcp.call_tool(
        22,
        "vv_artifact_patch",
        json!({
            "id": outline_id,
            "patch": { "status": "approved", "owner": "agent" },
            "origin": "agent:claude",
            "summary": "Approve outline metadata"
        }),
    );
    assert_ne!(json_patched["isError"], true, "{json_patched}");

    let outline_after = mcp.call_tool(23, "vv_artifact_read", json!({ "id": outline_id }));
    let outline_after_json: Value = serde_json::from_str(outline_after["content"][0]["text"].as_str().unwrap()).unwrap();
    let outline_body: Value = serde_json::from_str(outline_after_json["content"].as_str().unwrap()).unwrap();
    assert_eq!(outline_body["title"], "Launch Outline");
    assert_eq!(outline_body["status"], "approved");
    assert_eq!(outline_body["owner"], "agent");

    let text_patched = mcp.call_tool(
        24,
        "vv_artifact_patch",
        json!({
            "id": docs_id,
            "path": "structure/01-context.md",
            "find": "Line A",
            "replace": "Line A (updated)",
            "append": "Line C\n",
            "expectedHash": context_hash,
            "origin": "agent:codex",
            "summary": "Refine context"
        }),
    );
    assert_ne!(text_patched["isError"], true, "{text_patched}");
    let ctx_after = mcp.call_tool(25, "vv_artifact_read", json!({ "id": docs_id, "path": "structure/01-context.md" }));
    let ctx_after_json: Value = serde_json::from_str(ctx_after["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(ctx_after_json["content"], "## Context\nLine A (updated)\nLine B\nLine C\n");

    // 9. Human-owned file write diversion + vv_artifact_suggest create / list / accept / reject.
    {
        let mut artifacts = srv.artifacts.lock();
        let rec = artifacts.iter_mut().find(|r| r.wire.id == docs_id).unwrap();
        rec.human_touched.insert("structure/index.md".to_owned());
        assert!(rec.commits.iter().any(|(_, origin, _)| origin.as_deref() == Some("session:s1:turn:2")));
        assert!(rec.commits.iter().any(|(_, origin, _)| origin.as_deref() == Some("agent:codex")));
    }
    let diverted = mcp.call_tool(
        26,
        "vv_artifact_write",
        json!({
            "id": docs_id,
            "path": "structure/index.md",
            "content": "# Overview\nAgent rewrite\n",
            "origin": "agent:mcp",
            "summary": "Polish intro"
        }),
    );
    assert_ne!(diverted["isError"], true, "{diverted}");
    let diverted_json: Value = serde_json::from_str(diverted["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(diverted_json["suggestions"].as_array().unwrap().len(), 1);
    let sug1_id = diverted_json["suggestions"][0]["id"].as_str().unwrap().to_string();

    let sug_list = mcp.call_tool(27, "vv_artifact_suggest", json!({ "action": "list", "id": docs_id }));
    let sug_list_json: Value = serde_json::from_str(sug_list["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(sug_list_json["openCount"], 1);

    let sug_accept = mcp.call_tool(28, "vv_artifact_suggest", json!({ "action": "accept", "id": docs_id, "suggestionId": sug1_id }));
    assert_ne!(sug_accept["isError"], true, "{sug_accept}");
    let sug_accept_json: Value = serde_json::from_str(sug_accept["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(sug_accept_json["status"], "accepted");

    let sug_create = mcp.call_tool(
        29,
        "vv_artifact_suggest",
        json!({
            "action": "create",
            "id": docs_id,
            "content": "# Overview\nSecond proposal\n",
            "summary": "Alternative intro"
        }),
    );
    assert_ne!(sug_create["isError"], true, "{sug_create}");
    let sug2_json: Value = serde_json::from_str(sug_create["content"][0]["text"].as_str().unwrap()).unwrap();
    let sug2_id = sug2_json["id"].as_str().unwrap().to_string();

    let sug_reject = mcp.call_tool(30, "vv_artifact_suggest", json!({ "action": "reject", "id": docs_id, "suggestionId": sug2_id }));
    assert_ne!(sug_reject["isError"], true, "{sug_reject}");
    let sug_reject_json: Value = serde_json::from_str(sug_reject["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(sug_reject_json["status"], "rejected");

    let got_after = mcp.call_tool(31, "vv_artifact_get", json!({ "id": docs_id }));
    let got_after_json: Value = serde_json::from_str(got_after["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(got_after_json["openSuggestions"].as_array().unwrap().len(), 0);
    assert_eq!(got_after_json["suggestions"].as_array().unwrap().len(), 2);

    assert_eq!(mcp.finish(), 0);
}
