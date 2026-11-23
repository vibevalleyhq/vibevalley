//! Antigravity CLI (`agy >= 1.5.0`) ACP protocol policy, payload normalization,
//! interaction routing, and background-continuation tracking.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::oar::{AccountUsage, AgentError, EventKind, Installation, InteractionOption, PermissionMode, Result, SessionOptions, SubagentStatus, UsageWindow};

pub(crate) const MIN_VERSION: (u64, u64, u64) = (1, 5, 0);
pub(crate) const FIELD_TEXT_LIMIT: usize = 8 * 1024;
pub(crate) const PAYLOAD_BYTE_LIMIT: usize = 64 * 1024;
pub(crate) const PAYLOAD_NODE_LIMIT: usize = 512;

const AUTH_LINK_PREFIX: &str = "Open the following link to authenticate the ACP server:";
const USAGE_TIMEOUT: Duration = Duration::from_secs(20);

pub(crate) fn parse_semver(raw: &str) -> Option<(u64, u64, u64)> {
    for token in raw.split(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | '(' | ')' | '[' | ']')) {
        let trimmed = token.trim().trim_start_matches('v').trim_start_matches('V');
        let core = trimmed.split(['-', '+']).next().unwrap_or(trimmed);
        let mut parts = core.split('.');
        let Some(major) = parts.next().and_then(|p| p.parse::<u64>().ok()) else {
            continue;
        };
        let Some(minor) = parts.next().and_then(|p| p.parse::<u64>().ok()) else {
            continue;
        };
        let patch = parts.next().and_then(|p| p.parse::<u64>().ok()).unwrap_or(0);
        return Some((major, minor, patch));
    }
    None
}

pub(crate) fn check_installation(path: PathBuf, version: Option<String>) -> Installation {
    let Some(raw) = version.as_deref() else {
        return Installation::Unusable {
            reason: format!("`{} --version` returned no version; `agy >= 1.5.0` is required", path.display()),
        };
    };
    let Some(parsed) = parse_semver(raw) else {
        return Installation::Unusable {
            reason: format!("could not parse Antigravity CLI version `{raw}`; `agy >= 1.5.0` is required"),
        };
    };
    if parsed < MIN_VERSION {
        return Installation::Unusable {
            reason: format!("Antigravity CLI {raw} is below minimum supported version 1.5.0; upgrade `agy` to >= 1.5.0"),
        };
    }
    Installation::Available { version, path }
}

pub(crate) fn spawn_args(base_args: &[String], opts: &SessionOptions) -> Vec<String> {
    let mut args = base_args.to_vec();
    for dir in &opts.additional_directories {
        args.push("--add-dir".to_string());
        args.push(dir.to_string_lossy().into_owned());
    }
    args
}

pub(crate) fn spawn_env(opts: &SessionOptions) -> Vec<(String, String)> {
    let mut env = opts.env.clone();
    for (key, value) in [("AGY_CLI_DISABLE_AUTO_UPDATE", "1"), ("PYTHONUNBUFFERED", "1")] {
        if !env.iter().any(|(k, _)| k == key) {
            env.push((key.to_string(), value.to_string()));
        }
    }
    env
}

fn flag_value(args: &[String], names: &[&str]) -> Option<String> {
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        for name in names {
            if arg == name {
                if let Some(next) = args.get(i + 1) {
                    return Some(next.clone());
                }
            } else if let Some(rest) = arg.strip_prefix(name).and_then(|r| r.strip_prefix('=')) {
                return Some(rest.to_string());
            }
        }
        i += 1;
    }
    None
}

fn lookup_env(key: &str, env: &[(String, String)], base_env: Option<&[(String, String)]>) -> Option<String> {
    if let Some((_, v)) = env.iter().rev().find(|(k, _)| k == key) {
        return (!v.is_empty()).then(|| v.clone());
    }
    if let Some(base) = base_env {
        return base.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v.clone()).filter(|v| !v.is_empty());
    }
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

pub(crate) fn resolve_db_dirs(args: &[String], env: &[(String, String)], base_env: Option<&[(String, String)]>) -> Option<(PathBuf, String)> {
    let gemini_dir = flag_value(args, &["--gemini-dir", "--gemini_dir"])
        .map(PathBuf::from)
        .or_else(|| lookup_env("GEMINI_HOME", env, base_env).map(PathBuf::from))
        .or_else(|| lookup_env("HOME", env, base_env).map(|h| PathBuf::from(h).join(".gemini")))?;
    let app_data_dir = flag_value(args, &["--app-data-dir", "--app_data_dir"]).unwrap_or_else(|| "antigravity-cli".to_string());
    Some((gemini_dir, app_data_dir))
}

/// Detects the plain-text stdout authentication banner emitted by `agy acp`
/// when signed out, before the line reaches JSON-RPC framing.
pub(crate) fn auth_url_line(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    trimmed.strip_prefix(AUTH_LINK_PREFIX).map(str::trim)
}

/// ACP v2 `initialize` parameters tailored for `agy >= 1.5.0`.
/// Disabling client `fs.writeTextFile` keeps native diff edits; disabling
/// `fs.readTextFile` keeps native line-based reads.
pub(crate) fn initialize_params() -> Value {
    json!({
        "protocolVersion": 2,
        "clientCapabilities": {
            "fs": {
                "readTextFile": false,
                "writeTextFile": false,
            },
            "terminal": false,
        },
        "clientInfo": {
            "name": "vibevalley",
            "title": "VibeValley",
            "version": env!("CARGO_PKG_VERSION"),
        },
    })
}

/// Chooses a non-interactive authentication method to invoke proactively before
/// `session/new` or `session/resume`, if configured or backed by credentials.
///
/// `agy 1.5+` always advertises `gemini-api-key` alongside `oauth-personal`
/// even when the user is signed in via stored OAuth credentials without
/// `GEMINI_API_KEY`, so API-key auth is only picked when `GEMINI_API_KEY` is
/// actually present.
pub(crate) fn pick_auth_method(init: &Value, env: &[(String, String)], base_env: Option<&[(String, String)]>) -> Option<String> {
    for key in ["AGY_ACP_AUTH_METHOD", "OAR_ANTIGRAVITY_AUTH_METHOD"] {
        if let Some(method) = lookup_env(key, env, base_env) {
            return Some(method);
        }
    }
    let has_gemini_api_key = lookup_env("GEMINI_API_KEY", env, base_env).is_some();
    let methods = init.get("authMethods").and_then(Value::as_array)?;
    for method in methods {
        let Some(id) = method.get("id").and_then(Value::as_str) else { continue };
        let interactive = method
            .get("interactive")
            .and_then(Value::as_bool)
            .or_else(|| method.pointer("/_meta/interactive").and_then(Value::as_bool));
        if interactive == Some(false) {
            return Some(id.to_string());
        }
        if interactive == Some(true) {
            continue;
        }
        let kind = method.get("type").and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase();
        let lower_id = id.to_ascii_lowercase();
        let is_api_key = matches!(kind.as_str(), "api_key" | "apikey") || lower_id.contains("api_key") || lower_id.contains("api-key");
        if is_api_key {
            if has_gemini_api_key {
                return Some(id.to_string());
            }
            continue;
        }
        let looks_non_interactive = matches!(
            kind.as_str(),
            "token" | "env" | "env_var" | "service_account" | "cached" | "stored" | "agent" | "none"
        ) || lower_id.contains("token")
            || lower_id.contains("service-account")
            || lower_id.contains("service_account")
            || lower_id.contains("cached")
            || lower_id.contains("stored");
        if looks_non_interactive {
            return Some(id.to_string());
        }
    }
    None
}

pub(crate) fn is_auth_error(code: Option<i64>, message: &str, data: Option<&Value>) -> bool {
    if code == Some(-32000) {
        return true;
    }
    let data_text = data.map(Value::to_string).unwrap_or_default();
    let combined = format!("{message} {data_text}").to_ascii_lowercase();
    if combined.contains("no browser is available here")
        || combined.contains("authentication required")
        || combined.contains("not authenticated")
        || combined.contains("login required")
    {
        return true;
    }
    code == Some(-32603) && (combined.contains("authenticate") || combined.contains("login") || combined.contains("auth"))
}

pub(crate) fn supports_append_system_prompt(init: &Value) -> bool {
    init.pointer("/agentCapabilities/_meta/antigravity/systemPrompt/append")
        .and_then(Value::as_bool)
        == Some(true)
}

pub(crate) fn build_session_meta(init: &Value, append_system_prompt: Option<&str>) -> Option<Map<String, Value>> {
    let text = append_system_prompt.filter(|s| !s.is_empty())?;
    if !supports_append_system_prompt(init) {
        return None;
    }
    let mut meta = Map::new();
    meta.insert("antigravity".to_string(), json!({ "systemPrompt": { "append": text } }));
    Some(meta)
}

/// Interactive multi-choice questions arrive on `session/request_permission`
/// with a `toolCallId` prefixed by `interaction_`. They must NEVER be
/// auto-approved, even in `PermissionMode::Bypass`.
pub(crate) fn is_interaction_request(tool_call: &Value) -> bool {
    tool_call
        .get("toolCallId")
        .and_then(Value::as_str)
        .is_some_and(|id| id.starts_with("interaction_"))
}

fn security_warning_of(option: &Value) -> Option<String> {
    let meta = option.get("_meta")?;
    let val = meta.get("agy.security.warning")?;
    match val {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Array(items) => {
            let joined: Vec<&str> = items.iter().filter_map(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).collect();
            (!joined.is_empty()).then(|| joined.join("; "))
        }
        _ => None,
    }
}

pub(crate) fn extract_security_warnings(options: &Value) -> Vec<String> {
    let mut warnings = Vec::new();
    for option in options.as_array().into_iter().flatten() {
        if let Some(warning) = security_warning_of(option)
            && !warnings.contains(&warning)
        {
            warnings.push(warning);
        }
    }
    warnings
}

pub(crate) fn parse_interaction(tool_call: &Value, options: &Value) -> (String, Vec<InteractionOption>, bool) {
    let raw_input = tool_call.get("rawInput").unwrap_or(&Value::Null);
    let question = ["question", "prompt", "message", "text"]
        .into_iter()
        .find_map(|k| raw_input.get(k).and_then(Value::as_str).filter(|s| !s.trim().is_empty()))
        .or_else(|| tool_call.get("title").and_then(Value::as_str).filter(|s| !s.trim().is_empty()))
        .unwrap_or("Question")
        .to_string();

    let parsed_options: Vec<InteractionOption> = options
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|opt| {
            let id = opt.get("optionId").or_else(|| opt.get("id")).and_then(Value::as_str)?.to_string();
            let label = opt.get("name").or_else(|| opt.get("label")).and_then(Value::as_str).unwrap_or(&id).to_string();
            let description = opt
                .get("description")
                .or_else(|| opt.pointer("/_meta/description"))
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string);
            let kind = opt.get("kind").and_then(Value::as_str).map(str::to_string);
            let warning = security_warning_of(opt);
            Some(InteractionOption {
                id,
                label,
                description,
                kind,
                warning,
            })
        })
        .collect();

    let explicit_custom = ["allowCustom", "allow_custom", "allowFreeText", "freeform"]
        .into_iter()
        .find_map(|k| raw_input.get(k).or_else(|| tool_call.pointer(&format!("/_meta/{k}"))).and_then(Value::as_bool));
    let has_custom_option = parsed_options.iter().any(|o| {
        matches!(o.id.to_ascii_lowercase().as_str(), "custom" | "other" | "freeform")
            || o.kind
                .as_deref()
                .is_some_and(|k| matches!(k.to_ascii_lowercase().as_str(), "custom" | "other" | "freeform"))
    });
    let allow_custom = explicit_custom.unwrap_or(has_custom_option || parsed_options.is_empty());

    (question, parsed_options, allow_custom)
}

/// Client-side auto-approval policy for non-interaction tool permission requests.
/// `agy acp` rejects `yolo` / `auto_edit` wire modes, so permission policy is
/// enforced here while keeping the server in its default mode.
pub(crate) fn client_auto_allow(mode: PermissionMode, tool_kind: Option<&str>) -> bool {
    match mode {
        PermissionMode::Bypass => true,
        PermissionMode::AcceptEdits => matches!(tool_kind, Some("read" | "search" | "think" | "edit" | "delete" | "move")),
        PermissionMode::Ask | PermissionMode::Plan => matches!(tool_kind, Some("read" | "search" | "think")),
    }
}

/// Maps `PermissionMode` to a wire mode id for `agy`. Never returns `yolo` or
/// `auto_edit`; only `plan` (if advertised) or `default` (when leaving `plan`).
pub(crate) fn wire_mode_for(mode: PermissionMode, available: &[String], leaving_plan: bool) -> std::result::Result<Option<String>, String> {
    let find_normalized = |targets: &[&str]| -> Option<String> {
        available
            .iter()
            .find(|id| {
                let norm: String = id.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase();
                targets.contains(&norm.as_str())
            })
            .cloned()
    };
    match mode {
        PermissionMode::Plan => find_normalized(&["plan", "planmode", "readonly"])
            .map(Some)
            .ok_or_else(|| format!("antigravity has no plan mode (available modes: {available:?})")),
        PermissionMode::Ask | PermissionMode::AcceptEdits | PermissionMode::Bypass => {
            if leaving_plan {
                Ok(find_normalized(&["default", "ask"]))
            } else {
                Ok(None)
            }
        }
    }
}

// ---- Tool payload normalization & truncation --------------------------------

fn data_image_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"data:image/[a-zA-Z0-9.+-]+(?:;base64)?,[A-Za-z0-9+/=_%-]+"#).expect("valid regex"))
}

pub(crate) fn strip_inline_data_images(text: &str) -> String {
    if !text.contains("data:image/") {
        return text.to_string();
    }
    data_image_regex().replace_all(text, "[inline image omitted]").into_owned()
}

pub(crate) fn truncate_utf8_head(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    const SUFFIX: &str = "\n...[truncated]";
    if max_bytes <= SUFFIX.len() {
        let mut end = max_bytes;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        return text[..end].to_string();
    }
    let mut end = max_bytes - SUFFIX.len();
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = String::with_capacity(end + SUFFIX.len());
    out.push_str(&text[..end]);
    out.push_str(SUFFIX);
    out
}

pub(crate) fn truncate_utf8_tail(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    const PREFIX: &str = "...[truncated]\n";
    if max_bytes <= PREFIX.len() {
        let mut start = text.len().saturating_sub(max_bytes);
        while start < text.len() && !text.is_char_boundary(start) {
            start += 1;
        }
        return text[start..].to_string();
    }
    let mut start = text.len() - (max_bytes - PREFIX.len());
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    let mut out = String::with_capacity(PREFIX.len() + (text.len() - start));
    out.push_str(PREFIX);
    out.push_str(&text[start..]);
    out
}

fn canonical_key(key: &str) -> &str {
    match key {
        "CommandLine" | "command_line" | "commandLine" | "command" => "command",
        "Cwd" | "WorkingDirectory" | "working_dir" | "workingDir" | "cwd" => "cwd",
        "combinedOutput" | "combined_output" => "output",
        "exitCode" | "exit_code" => "exitCode",
        other => other,
    }
}

fn prefer_tail(key: Option<&str>) -> bool {
    matches!(key, Some("output" | "stdout" | "stderr" | "combinedOutput" | "combined_output"))
}

struct Budget {
    nodes: usize,
    bytes: usize,
}

impl Budget {
    fn new() -> Self {
        Self {
            nodes: PAYLOAD_NODE_LIMIT,
            bytes: PAYLOAD_BYTE_LIMIT,
        }
    }

    fn take_node(&mut self) -> bool {
        if self.nodes == 0 {
            return false;
        }
        self.nodes -= 1;
        true
    }

    fn take_bytes(&mut self, amount: usize) -> bool {
        if amount > self.bytes {
            return false;
        }
        self.bytes -= amount;
        true
    }
}

fn normalize_value(value: &Value, key: Option<&str>, budget: &mut Budget) -> Value {
    if !budget.take_node() {
        return Value::String("...[truncated]".to_string());
    }
    match value {
        Value::Null => Value::Null,
        Value::Bool(b) => Value::Bool(*b),
        Value::Number(n) => {
            let _ = budget.take_bytes(16);
            Value::Number(n.clone())
        }
        Value::String(s) => {
            let cleaned = strip_inline_data_images(s);
            let limit = FIELD_TEXT_LIMIT.min(budget.bytes);
            let capped = if prefer_tail(key) {
                truncate_utf8_tail(&cleaned, limit)
            } else {
                truncate_utf8_head(&cleaned, limit)
            };
            budget.bytes = budget.bytes.saturating_sub(capped.len());
            Value::String(capped)
        }
        Value::Array(items) => {
            let mut out = Vec::with_capacity(items.len().min(budget.nodes));
            for item in items {
                if budget.nodes == 0 || budget.bytes == 0 {
                    out.push(Value::String("...[truncated]".to_string()));
                    break;
                }
                out.push(normalize_value(item, None, budget));
            }
            Value::Array(out)
        }
        Value::Object(map) => {
            let mut out = Map::new();
            // First pass: canonicalize keys, keeping explicit canonical keys over aliases.
            let mut canonical: Vec<(String, &Value)> = Vec::with_capacity(map.len());
            for (k, v) in map {
                let target = canonical_key(k).to_string();
                if let Some(slot) = canonical.iter_mut().find(|(existing, _)| existing == &target) {
                    if k == &target {
                        slot.1 = v;
                    }
                } else {
                    canonical.push((target, v));
                }
            }
            let output_val = canonical.iter().find(|(k, _)| k == "output").map(|(_, v)| *v);
            for (k, v) in canonical {
                if k == "formatted_output"
                    && let Some(out_v) = output_val
                    && v == out_v
                {
                    continue;
                }
                if budget.nodes == 0 || budget.bytes == 0 {
                    out.insert("_truncated".to_string(), Value::Bool(true));
                    break;
                }
                let _ = budget.take_bytes(k.len() + 4);
                let normalized = normalize_value(v, Some(&k), budget);
                out.insert(k, normalized);
            }
            Value::Object(out)
        }
    }
}

pub(crate) fn normalize_tool_input(raw: &Value, kind: Option<&str>) -> Value {
    let mut budget = Budget::new();
    let mut normalized = normalize_value(raw, None, &mut budget);
    if let Some(kind) = kind.filter(|k| !k.is_empty()) {
        match &mut normalized {
            Value::Object(map) => {
                map.entry("kind".to_string()).or_insert_with(|| Value::String(kind.to_string()));
            }
            Value::Null => {
                normalized = json!({ "kind": kind });
            }
            _ => {}
        }
    }
    normalized
}

pub(crate) fn normalize_tool_text(text: &str, kind: Option<&str>) -> String {
    let cleaned = strip_inline_data_images(text);
    if kind == Some("execute") {
        truncate_utf8_tail(&cleaned, FIELD_TEXT_LIMIT)
    } else {
        truncate_utf8_head(&cleaned, FIELD_TEXT_LIMIT)
    }
}

pub(crate) fn normalize_tool_output(raw: &Value, kind: Option<&str>) -> Option<String> {
    match raw {
        Value::Null => None,
        Value::String(s) => Some(normalize_tool_text(s, kind)),
        other => {
            let mut budget = Budget::new();
            let normalized = normalize_value(other, None, &mut budget);
            if let Some(out) = normalized.get("output").and_then(Value::as_str) {
                Some(out.to_string())
            } else {
                let serialized = normalized.to_string();
                if serialized.len() > PAYLOAD_BYTE_LIMIT {
                    Some(truncate_utf8_head(&serialized, PAYLOAD_BYTE_LIMIT))
                } else {
                    Some(serialized)
                }
            }
        }
    }
}

// ---- Background / schedule continuation tracking ----------------------------

#[derive(Default)]
pub(crate) struct BackgroundTracker {
    open: HashSet<String>,
}

impl BackgroundTracker {
    fn is_daemon(raw_input: Option<&Value>) -> bool {
        let Some(input) = raw_input else { return false };
        ["IsDaemon", "isDaemon", "is_daemon"]
            .into_iter()
            .any(|k| input.get(k).and_then(Value::as_bool) == Some(true))
    }

    fn is_schedule(title: &str) -> bool {
        let lower = title.to_ascii_lowercase();
        lower == "schedule" || lower.starts_with("run schedule") || lower.starts_with("running schedule")
    }

    pub(crate) fn on_tool_update(&mut self, id: &str, title: &str, kind: &str, raw_input: Option<&Value>, status: &str) {
        if matches!(status, "completed" | "failed" | "cancelled") {
            self.open.remove(id);
            return;
        }
        let trackable = (kind == "execute" && !Self::is_daemon(raw_input)) || Self::is_schedule(title);
        if trackable {
            self.open.insert(id.to_string());
        }
    }

    pub(crate) fn has_open(&self) -> bool {
        !self.open.is_empty()
    }

    pub(crate) fn clear(&mut self) {
        self.open.clear();
    }
}

// ---- Swarm & subagent ACP tool-call → `EventKind::Subagent*` tracker --------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChildTool {
    Swarm,
    InvokeSubagent,
    SwarmWait,
    PostMessage,
    PassiveSignal,
}

struct ChildCallState {
    tool: ChildTool,
    input: Value,
    emitted_start: bool,
    emitted_end: bool,
}

/// Maps Antigravity ACP `tool_call` / `tool_call_update` frames for `/swarm` and
/// `invoke_subagent` tools into structured `EventKind::Subagent*` events.
#[derive(Default)]
pub(crate) struct ChildActivityTracker {
    calls: HashMap<String, ChildCallState>,
}

fn classify_child_tool(title: &str) -> Option<ChildTool> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return None;
    }
    let after_colon = trimmed.rsplit_once(':').map_or(trimmed, |(_, r)| r);
    let bare = after_colon.rsplit_once('.').map_or(after_colon, |(_, r)| r).trim().to_ascii_lowercase();
    match bare.as_str() {
        "swarm" => Some(ChildTool::Swarm),
        "invoke_subagent" | "start_subagent" => Some(ChildTool::InvokeSubagent),
        "swarm_wait" => Some(ChildTool::SwarmWait),
        "post_message" => Some(ChildTool::PostMessage),
        "read_board" | "define_subagent" => Some(ChildTool::PassiveSignal),
        _ => None,
    }
}

fn first_str<'a>(input: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| input.get(*k).and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn output_summary(update: &Value) -> Option<String> {
    if let Some(arr) = update.get("content").and_then(Value::as_array) {
        let texts: Vec<&str> = arr
            .iter()
            .filter_map(|item| {
                item.get("text")
                    .or_else(|| item.pointer("/content/text"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
            })
            .collect();
        if !texts.is_empty() {
            return Some(truncate_utf8_head(&strip_inline_data_images(&texts.join("\n")), 512));
        }
    }
    match update.get("rawOutput") {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(truncate_utf8_head(&strip_inline_data_images(s.trim()), 512)),
        Some(Value::Object(map)) => map
            .get("output")
            .or_else(|| map.get("message"))
            .or_else(|| map.get("summary"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| truncate_utf8_head(&strip_inline_data_images(s), 512)),
        _ => None,
    }
}

impl ChildActivityTracker {
    /// Absorbs one `tool_call` / `tool_call_update` frame. Returns `(matched_child_tool, events)`.
    pub(crate) fn on_tool_update(&mut self, parent_session_id: &str, update: &Value) -> (bool, Vec<EventKind>) {
        let Some(call_id) = update.get("toolCallId").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
            return (false, Vec::new());
        };
        let title = update.get("title").and_then(Value::as_str).unwrap_or_default();
        if !self.calls.contains_key(call_id) {
            let Some(tool) = classify_child_tool(title) else {
                return (false, Vec::new());
            };
            self.calls.insert(
                call_id.to_string(),
                ChildCallState {
                    tool,
                    input: Value::Null,
                    emitted_start: false,
                    emitted_end: false,
                },
            );
        }
        let Some(state) = self.calls.get_mut(call_id) else {
            return (false, Vec::new());
        };
        if let Some(raw_input) = update.get("rawInput")
            && !matches!(raw_input, Value::Null)
            && !raw_input.as_object().is_some_and(Map::is_empty)
        {
            state.input = raw_input.clone();
        }

        let status = update.get("status").and_then(Value::as_str).unwrap_or_default();
        let terminal = matches!(status, "completed" | "failed" | "cancelled");
        let mut events = Vec::new();

        match state.tool {
            ChildTool::Swarm => {
                let action = first_str(&state.input, &["action"]);
                if !state.emitted_start
                    && let Some(action) = action
                {
                    state.emitted_start = true;
                    match action {
                        "add" => {
                            let base_name = first_str(&state.input, &["name"]).unwrap_or(call_id);
                            let brief = first_str(&state.input, &["brief"]).map(|s| truncate_utf8_head(&strip_inline_data_images(s), 1024));
                            let tasks = state.input.get("tasks").and_then(Value::as_array);
                            let count = state.input.get("n").and_then(Value::as_u64).unwrap_or(1) as usize;
                            let spawned: Vec<(String, Option<String>)> = if let Some(items) = tasks.filter(|a| !a.is_empty()) {
                                items
                                    .iter()
                                    .enumerate()
                                    .map(|(idx, item)| {
                                        let worker = format!("{base_name}-{}", idx + 1);
                                        let slice_task = item.as_str().map(str::trim).filter(|s| !s.is_empty());
                                        let task = match (slice_task, brief.as_deref()) {
                                            (Some(t), Some(b)) => Some(truncate_utf8_head(&format!("{t}: {b}"), 1024)),
                                            (Some(t), None) => Some(t.to_string()),
                                            (None, Some(b)) => Some(b.to_string()),
                                            (None, None) => None,
                                        };
                                        (worker, task)
                                    })
                                    .collect()
                            } else if count > 1 {
                                (1..=count.min(16)).map(|i| (format!("{base_name}-{i}"), brief.clone())).collect()
                            } else {
                                vec![(base_name.to_string(), brief)]
                            };
                            for (worker, task) in spawned {
                                events.push(EventKind::SubagentSpawned {
                                    parent_thread_id: parent_session_id.to_string(),
                                    thread_id: worker.clone(),
                                    task,
                                    agent_name: Some(worker.clone()),
                                });
                                events.push(EventKind::SubagentStatusChanged {
                                    thread_id: worker,
                                    turn_id: None,
                                    status: SubagentStatus::Running,
                                    message: None,
                                });
                            }
                        }
                        "kill" => {
                            if let Some(target) = first_str(&state.input, &["name"]) {
                                events.push(EventKind::SubagentStatusChanged {
                                    thread_id: target.to_string(),
                                    turn_id: None,
                                    status: SubagentStatus::Shutdown,
                                    message: None,
                                });
                            }
                        }
                        _ => {}
                    }
                }
            }
            ChildTool::InvokeSubagent => {
                let has_input = !state.input.is_null();
                if !state.emitted_start && (has_input || status == "in_progress" || terminal) {
                    state.emitted_start = true;
                    let agent_name = first_str(&state.input, &["agent_type", "agentType", "role", "name", "subagent_type"]).map(str::to_string);
                    let task = first_str(&state.input, &["prompt", "task", "instructions", "description"])
                        .map(|s| truncate_utf8_head(&strip_inline_data_images(s), 1024));
                    events.push(EventKind::SubagentSpawned {
                        parent_thread_id: parent_session_id.to_string(),
                        thread_id: call_id.to_string(),
                        task,
                        agent_name,
                    });
                    events.push(EventKind::SubagentStatusChanged {
                        thread_id: call_id.to_string(),
                        turn_id: None,
                        status: SubagentStatus::Running,
                        message: None,
                    });
                }
                if terminal && !state.emitted_end {
                    state.emitted_end = true;
                    let final_status = match status {
                        "completed" => SubagentStatus::Completed,
                        "cancelled" => SubagentStatus::Interrupted,
                        _ => SubagentStatus::Errored,
                    };
                    events.push(EventKind::SubagentStatusChanged {
                        thread_id: call_id.to_string(),
                        turn_id: None,
                        status: final_status,
                        message: output_summary(update),
                    });
                }
            }
            ChildTool::SwarmWait => {
                if !terminal && !state.emitted_start {
                    state.emitted_start = true;
                    events.push(EventKind::SubagentWait {
                        thread_id: parent_session_id.to_string(),
                        call_id: call_id.to_string(),
                        targets: vec!["board".to_string()],
                        waiting: true,
                    });
                } else if terminal && !state.emitted_end {
                    state.emitted_end = true;
                    events.push(EventKind::SubagentWait {
                        thread_id: parent_session_id.to_string(),
                        call_id: call_id.to_string(),
                        targets: vec!["board".to_string()],
                        waiting: false,
                    });
                }
            }
            ChildTool::PostMessage => {
                if !state.emitted_start
                    && let Some(text) = first_str(&state.input, &["text", "message"])
                {
                    state.emitted_start = true;
                    events.push(EventKind::SubagentMessage {
                        thread_id: "swarm-board".to_string(),
                        turn_id: call_id.to_string(),
                        text: truncate_utf8_head(&strip_inline_data_images(text), 1024),
                    });
                }
            }
            ChildTool::PassiveSignal => {}
        }

        if terminal {
            self.calls.remove(call_id);
        }
        (true, events)
    }
}

// ---- Account usage / quota probing (`agy --print /usage --output-format json`)

#[derive(Deserialize)]
struct WireUsageOutput {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    response: Option<String>,
    #[serde(default)]
    error: Option<WireUsageError>,
    #[serde(default)]
    command: Option<WireUsageCommand>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WireUsageError {
    Message(String),
    Object {
        #[serde(default)]
        message: Option<String>,
    },
    Other(#[allow(dead_code)] serde::de::IgnoredAny),
}

impl WireUsageError {
    fn as_str(&self) -> Option<&str> {
        match self {
            Self::Message(s) => Some(s.as_str()),
            Self::Object { message } => message.as_deref(),
            Self::Other(_) => None,
        }
    }
}

#[derive(Deserialize)]
struct WireUsageCommand {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    data: Option<WireUsageData>,
}

#[derive(Deserialize)]
struct WireUsageData {
    #[serde(default)]
    groups: Option<Vec<WireUsageGroup>>,
}

#[derive(Deserialize)]
struct WireUsageGroup {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    buckets: Option<Vec<WireUsageBucket>>,
}

#[derive(Deserialize)]
struct WireUsageBucket {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    window: Option<String>,
    #[serde(default)]
    remaining_fraction: Option<f64>,
    #[serde(default)]
    reset_time: Option<String>,
}

fn has_auth_hint(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("open the following link to authenticate")
        || lower.contains("not logged in")
        || lower.contains("not authenticated")
        || lower.contains("authentication required")
        || lower.contains("login required")
        || lower.contains("unauthenticated")
        || lower.contains("please log in")
        || lower.contains("please sign in")
}

fn is_non_success_auth_hint(status: &str, detail: &str, raw: &str) -> bool {
    if has_auth_hint(raw) || has_auth_hint(detail) {
        return true;
    }
    let status_lower = status.to_ascii_lowercase();
    let detail_lower = detail.to_ascii_lowercase();
    status_lower.contains("auth") || status_lower.contains("login") || detail_lower.contains("authenticate") || detail_lower.contains("login")
}

fn normalize_group_name(raw: Option<&str>) -> Option<String> {
    let trimmed = raw?.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower == "gemini models" || lower == "gemini" {
        return Some("Gemini".to_string());
    }
    if lower == "claude and gpt models" || lower == "claude and gpt" || lower == "claude/gpt" {
        return Some("Claude/GPT".to_string());
    }
    let stripped = trimmed
        .strip_suffix(" Models")
        .or_else(|| trimmed.strip_suffix(" models"))
        .unwrap_or(trimmed)
        .trim();
    (!stripped.is_empty()).then(|| stripped.to_string())
}

/// Normalizes a bucket's window key into `(display_label, duration_ms, sort_rank)`.
/// Shorter windows sort first (`5h` before `7d`).
fn normalize_window(window: Option<&str>, fallback_name: Option<&str>, fallback_id: Option<&str>) -> (String, Option<u64>, u8) {
    const HOUR_MS: u64 = 3_600_000;
    const DAY_MS: u64 = 24 * HOUR_MS;
    if let Some(raw) = window.map(str::trim).filter(|s| !s.is_empty()) {
        return match raw.to_ascii_lowercase().as_str() {
            "5h" | "5_hour" | "five_hour" => ("5h".into(), Some(5 * HOUR_MS), 0),
            "daily" | "1d" | "24h" => ("24h".into(), Some(DAY_MS), 1),
            "weekly" | "7d" | "seven_day" | "1w" => ("7d".into(), Some(7 * DAY_MS), 2),
            "monthly" | "30d" => ("30d".into(), Some(30 * DAY_MS), 3),
            _ => (raw.to_string(), None, 4),
        };
    }
    if let Some(name) = fallback_name.map(str::trim).filter(|s| !s.is_empty()) {
        let lower = name.to_ascii_lowercase();
        if lower.contains("five hour") || lower.contains("5h") || lower.contains("5-hour") {
            return ("5h".into(), Some(5 * HOUR_MS), 0);
        }
        if lower.contains("weekly") || lower.contains("7d") || lower.contains("7-day") {
            return ("7d".into(), Some(7 * DAY_MS), 2);
        }
        return (name.to_string(), None, 4);
    }
    if let Some(id) = fallback_id.map(str::trim).filter(|s| !s.is_empty()) {
        return (id.to_string(), None, 5);
    }
    ("limit".into(), None, 5)
}

fn parse_usage_json(raw: &str) -> std::result::Result<WireUsageOutput, serde_json::Error> {
    let trimmed = raw.trim();
    match serde_json::from_str::<WireUsageOutput>(trimmed) {
        Ok(parsed) => Ok(parsed),
        Err(first_err) => {
            if let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}'))
                && start < end
                && (start > 0 || end + 1 < trimmed.len())
            {
                serde_json::from_str::<WireUsageOutput>(&trimmed[start..=end]).map_err(|_| first_err)
            } else {
                Err(first_err)
            }
        }
    }
}

/// Parses the JSON (or auth banner text) emitted by `agy --print /usage --output-format json`.
pub(crate) fn usage_of(raw: &str) -> Result<AccountUsage> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(AccountUsage::Unsupported {
            reason: "quota_unavailable".into(),
        });
    }
    let parsed = match parse_usage_json(trimmed) {
        Ok(parsed) => parsed,
        Err(err) => {
            if has_auth_hint(trimmed) {
                return Ok(AccountUsage::ReauthRequired {
                    reason: "not_authenticated".into(),
                });
            }
            return Err(AgentError::Protocol(format!("could not parse antigravity usage output: {err}")));
        }
    };

    if let Some(status) = parsed.status.as_deref()
        && !status.eq_ignore_ascii_case("SUCCESS")
    {
        let detail = parsed
            .error
            .as_ref()
            .and_then(WireUsageError::as_str)
            .or(parsed.response.as_deref())
            .unwrap_or_default()
            .trim();
        if is_non_success_auth_hint(status, detail, trimmed) {
            return Ok(AccountUsage::ReauthRequired {
                reason: "not_authenticated".into(),
            });
        }
        return Err(AgentError::Protocol(if detail.is_empty() {
            format!("antigravity usage query returned status `{status}`")
        } else {
            format!("antigravity usage query failed ({status}): {detail}")
        }));
    }

    let Some(command) = parsed.command else {
        return Ok(AccountUsage::Unsupported {
            reason: "quota_unavailable".into(),
        });
    };
    if command.name.as_deref() != Some("usage") {
        return Ok(AccountUsage::Unsupported {
            reason: "quota_unavailable".into(),
        });
    }
    let groups = command.data.and_then(|d| d.groups).unwrap_or_default();
    if groups.is_empty() {
        return Ok(AccountUsage::Unsupported {
            reason: "quota_unavailable".into(),
        });
    }

    let mut windows = Vec::new();
    let mut non_empty_groups = 0usize;
    let mut exhausted_groups = 0usize;

    for group in groups {
        let group_prefix = normalize_group_name(group.name.as_deref());
        let mut group_windows: Vec<(u8, usize, UsageWindow)> = Vec::new();
        for (idx, bucket) in group.buckets.unwrap_or_default().into_iter().enumerate() {
            let Some(remaining) = bucket.remaining_fraction.filter(|r| r.is_finite()) else {
                continue;
            };
            let (win_label, duration_ms, rank) = normalize_window(bucket.window.as_deref(), bucket.name.as_deref(), bucket.id.as_deref());
            let label = match &group_prefix {
                Some(prefix) => format!("{prefix} · {win_label}"),
                None => win_label,
            };
            let used_ratio = ((1.0 - remaining).clamp(0.0, 1.0) * 1e6).round() / 1e6;
            let resets_at = bucket.reset_time.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
            let id = bucket.id.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
            group_windows.push((
                rank,
                idx,
                UsageWindow {
                    label,
                    used_ratio,
                    resets_at,
                    id,
                    duration_ms,
                },
            ));
        }
        if group_windows.is_empty() {
            continue;
        }
        group_windows.sort_by_key(|(rank, idx, _)| (*rank, *idx));
        non_empty_groups += 1;
        if group_windows.iter().any(|(_, _, w)| w.used_ratio >= 1.0) {
            exhausted_groups += 1;
        }
        windows.extend(group_windows.into_iter().map(|(_, _, w)| w));
    }

    if windows.is_empty() {
        return Ok(AccountUsage::Unsupported {
            reason: "quota_unavailable".into(),
        });
    }

    Ok(AccountUsage::Available {
        plan: None,
        email: None,
        rate_limited: non_empty_groups > 0 && exhausted_groups == non_empty_groups,
        windows,
    })
}

/// Runs `agy --print /usage --output-format json` in a clean temp directory with
/// auto-update disabled and a bounded async timeout + process-group reaper.
pub(crate) fn read_account_usage(binary: &Path) -> Result<AccountUsage> {
    use tokio::io::AsyncReadExt as _;
    use tokio::process::Command;

    let binary = binary.to_path_buf();
    let (status, stdout, stderr) = crate::rt::block_on(async move {
        let mut child = Command::new(&binary)
            .args(["--print", "/usage", "--output-format", "json"])
            .current_dir(std::env::temp_dir())
            .env("AGY_CLI_DISABLE_AUTO_UPDATE", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
            .map_err(|e| AgentError::NotAvailable(format!("cannot start {}: {e}", binary.display())))?;
        let pid = child.id().unwrap_or(0);
        let stdout_task = child.stdout.take().map(|mut stdout| {
            crate::rt::spawn(async move {
                let mut bytes = Vec::new();
                let _ = stdout.read_to_end(&mut bytes).await;
                String::from_utf8_lossy(&bytes).into_owned()
            })
        });
        let stderr_task = child.stderr.take().map(|mut stderr| {
            crate::rt::spawn(async move {
                let mut bytes = Vec::new();
                let _ = stderr.read_to_end(&mut bytes).await;
                String::from_utf8_lossy(&bytes).into_owned()
            })
        });

        let status = match tokio::time::timeout(USAGE_TIMEOUT, child.wait()).await {
            Ok(Ok(status)) => status,
            Ok(Err(e)) => {
                let _ = crate::oar::process::reap_process_group(&mut child, pid, Duration::from_millis(200)).await;
                if let Some(h) = stdout_task {
                    h.abort();
                }
                if let Some(h) = stderr_task {
                    h.abort();
                }
                return Err(AgentError::Io(format!("failed waiting for antigravity usage query: {e}")));
            }
            Err(_) => {
                let _ = crate::oar::process::reap_process_group(&mut child, pid, Duration::from_millis(200)).await;
                if let Some(h) = stdout_task {
                    h.abort();
                }
                if let Some(h) = stderr_task {
                    h.abort();
                }
                return Err(AgentError::Io("antigravity did not answer the usage query in time".into()));
            }
        };

        let stdout = match stdout_task {
            Some(h) => h.await.unwrap_or_default(),
            None => String::new(),
        };
        let stderr = match stderr_task {
            Some(h) => h.await.unwrap_or_default(),
            None => String::new(),
        };
        Ok((status, stdout, stderr))
    })?;

    if !stdout.trim().is_empty() {
        match usage_of(&stdout) {
            Ok(AccountUsage::Unsupported { .. }) if has_auth_hint(&stderr) => {
                return Ok(AccountUsage::ReauthRequired {
                    reason: "not_authenticated".into(),
                });
            }
            Ok(usage) => return Ok(usage),
            Err(_) if has_auth_hint(&stderr) => {
                return Ok(AccountUsage::ReauthRequired {
                    reason: "not_authenticated".into(),
                });
            }
            Err(err) => {
                if !status.success() {
                    let detail = stderr.trim();
                    let message = if detail.is_empty() {
                        format!("antigravity usage query failed (exit {:?}): {err}", status.code())
                    } else {
                        format!("antigravity usage query failed (exit {:?}): {detail}", status.code())
                    };
                    return Err(AgentError::Protocol(message));
                }
                return Err(err);
            }
        }
    }

    if has_auth_hint(&stderr) {
        return Ok(AccountUsage::ReauthRequired {
            reason: "not_authenticated".into(),
        });
    }
    if !status.success() {
        let detail = stderr.trim();
        return Err(AgentError::Protocol(format!(
            "antigravity usage query failed (exit {:?}): {}",
            status.code(),
            if detail.is_empty() { "no output" } else { detail }
        )));
    }
    Ok(AccountUsage::Unsupported {
        reason: "quota_unavailable".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oar::{ToolAction, tool_action};

    #[test]
    fn rejects_versions_below_1_5_0() {
        let bin = PathBuf::from("/usr/local/bin/agy");
        assert!(matches!(
            check_installation(bin.clone(), Some("1.4.9".into())),
            Installation::Unusable { reason } if reason.contains("1.5.0")
        ));
        assert!(matches!(
            check_installation(bin.clone(), Some("v1.1.0-beta".into())),
            Installation::Unusable { .. }
        ));
        assert!(matches!(check_installation(bin.clone(), None), Installation::Unusable { .. }));
        assert!(matches!(
            check_installation(bin.clone(), Some("1.5.0".into())),
            Installation::Available { version: Some(v), .. } if v == "1.5.0"
        ));
        assert!(matches!(
            check_installation(bin, Some("agy 1.5.14".into())),
            Installation::Available { version: Some(v), .. } if v == "agy 1.5.14"
        ));
    }

    #[test]
    fn normalizes_tool_keys_strips_inline_images_and_drops_duplicate_formatted_output() {
        let raw = json!({
            "CommandLine": "cargo test",
            "WorkingDirectory": "/repo",
            "combinedOutput": "ok data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
            "formatted_output": "ok data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
            "exit_code": 0
        });
        let norm = normalize_tool_input(&raw, Some("execute"));
        assert_eq!(norm["command"], "cargo test");
        assert_eq!(norm["cwd"], "/repo");
        assert_eq!(norm["output"], "ok [inline image omitted]");
        assert_eq!(norm["exitCode"], 0);
        assert_eq!(norm["kind"], "execute");
        assert!(norm.get("formatted_output").is_none());
        assert_eq!(tool_action("custom_shell_title", &norm), ToolAction::RunCommand);
    }

    #[test]
    fn truncates_field_at_8kib_preserving_tail_for_command_output_and_caps_nodes() {
        let big = format!("HEAD-{}TAIL-END", "x".repeat(FIELD_TEXT_LIMIT + 4096));
        let raw = json!({ "combinedOutput": big });
        let out = normalize_tool_output(&raw, Some("execute")).unwrap();
        assert!(out.len() <= FIELD_TEXT_LIMIT);
        assert!(out.ends_with("TAIL-END"), "expected tail preserved: {out}");
        assert!(out.starts_with("...[truncated]\n"));

        let many: Vec<Value> = (0..1000).map(|i| json!(i)).collect();
        let norm = normalize_tool_input(&json!({ "items": many }), Some("search"));
        let items = norm["items"].as_array().unwrap();
        assert!(items.len() <= PAYLOAD_NODE_LIMIT);
        assert_eq!(items.last().and_then(Value::as_str), Some("...[truncated]"));
    }

    #[test]
    fn parses_interaction_and_preserves_security_warnings() {
        let tool_call = json!({
            "toolCallId": "interaction_42",
            "title": "Pick deployment target",
            "rawInput": { "question": "Where should we deploy?", "allowCustom": true }
        });
        assert!(is_interaction_request(&tool_call));
        let options = json!([
            {
                "optionId": "prod",
                "name": "Production",
                "description": "Live cluster",
                "kind": "allow_once",
                "_meta": { "agy.security.warning": "Writes directly to production" }
            },
            {
                "optionId": "staging",
                "name": "Staging"
            }
        ]);
        let (question, parsed, allow_custom) = parse_interaction(&tool_call, &options);
        assert_eq!(question, "Where should we deploy?");
        assert!(allow_custom);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].id, "prod");
        assert_eq!(parsed[0].warning.as_deref(), Some("Writes directly to production"));
        assert_eq!(extract_security_warnings(&options), vec!["Writes directly to production"]);
    }

    #[test]
    fn wire_mode_never_emits_yolo_or_auto_edit() {
        let modes = vec!["default".into(), "plan".into(), "yolo".into(), "auto_edit".into()];
        assert_eq!(wire_mode_for(PermissionMode::Bypass, &modes, false), Ok(None));
        assert_eq!(wire_mode_for(PermissionMode::AcceptEdits, &modes, false), Ok(None));
        assert_eq!(wire_mode_for(PermissionMode::Ask, &modes, false), Ok(None));
        assert_eq!(wire_mode_for(PermissionMode::Plan, &modes, false), Ok(Some("plan".into())));
        assert_eq!(wire_mode_for(PermissionMode::Ask, &modes, true), Ok(Some("default".into())));
        assert!(wire_mode_for(PermissionMode::Plan, &["default".into()], false).is_err());
    }

    #[test]
    fn background_tracker_tracks_non_daemon_execute_and_schedule() {
        let mut tracker = BackgroundTracker::default();
        tracker.on_tool_update("d1", "run_command", "execute", Some(&json!({"IsDaemon": true})), "in_progress");
        assert!(!tracker.has_open());

        tracker.on_tool_update("b1", "run_command", "execute", Some(&json!({"CommandLine": "sleep 5"})), "in_progress");
        assert!(tracker.has_open());
        tracker.on_tool_update("b1", "run_command", "execute", None, "completed");
        assert!(!tracker.has_open());

        tracker.on_tool_update("s1", "Running schedule", "other", None, "in_progress");
        assert!(tracker.has_open());
        tracker.on_tool_update("s1", "Running schedule", "other", None, "completed");
        assert!(!tracker.has_open());
    }

    #[test]
    fn auth_url_line_detects_banner_and_ignores_jsonrpc() {
        assert_eq!(
            auth_url_line("Open the following link to authenticate the ACP server: https://example.com/auth"),
            Some("https://example.com/auth")
        );
        assert_eq!(auth_url_line(r#"{"jsonrpc":"2.0","id":1,"result":{}}"#), None);
    }

    #[test]
    fn pick_auth_method_only_selects_api_key_when_env_is_present() {
        let agy_init = json!({
            "authMethods": [
                { "id": "oauth-personal", "name": "Log in with Google" },
                { "id": "gemini-api-key", "name": "Gemini API key" },
                { "id": "agent-platform", "name": "Agent Platform" }
            ]
        });
        // Isolated base_env without GEMINI_API_KEY -> do not call authenticate("gemini-api-key").
        let empty_base: Vec<(String, String)> = vec![];
        assert_eq!(pick_auth_method(&agy_init, &[], Some(&empty_base)), None);
        // With GEMINI_API_KEY present -> selects gemini-api-key.
        assert_eq!(
            pick_auth_method(&agy_init, &[("GEMINI_API_KEY".into(), "secret".into())], Some(&empty_base)),
            Some("gemini-api-key".into())
        );
        // Explicit AGY_ACP_AUTH_METHOD override always wins.
        assert_eq!(
            pick_auth_method(&agy_init, &[("AGY_ACP_AUTH_METHOD".into(), "agent-platform".into())], Some(&empty_base)),
            Some("agent-platform".into())
        );
    }

    #[test]
    fn child_activity_tracker_maps_swarm_and_subagent_tool_calls() {
        let mut tracker = ChildActivityTracker::default();

        // 1. swarm(action: "add") emits SubagentSpawned + Running.
        let (matched, evs) = tracker.on_tool_update(
            "root-1",
            &json!({
                "toolCallId": "tc-add",
                "title": "swarm",
                "status": "in_progress",
                "rawInput": {"action": "add", "name": "verifier", "brief": "Run acceptance checks"}
            }),
        );
        assert!(matched);
        assert_eq!(
            evs,
            vec![
                EventKind::SubagentSpawned {
                    parent_thread_id: "root-1".into(),
                    thread_id: "verifier".into(),
                    task: Some("Run acceptance checks".into()),
                    agent_name: Some("verifier".into()),
                },
                EventKind::SubagentStatusChanged {
                    thread_id: "verifier".into(),
                    turn_id: None,
                    status: SubagentStatus::Running,
                    message: None,
                },
            ]
        );
        // Completion update must not duplicate spawn events.
        let (matched_done, evs_done) = tracker.on_tool_update("root-1", &json!({"toolCallId": "tc-add", "status": "completed"}));
        assert!(matched_done);
        assert!(evs_done.is_empty());

        // 2. swarm(action: "kill") emits Shutdown.
        let (_, evs_kill) = tracker.on_tool_update(
            "root-1",
            &json!({"toolCallId": "tc-kill", "title": "default_api:swarm", "status": "completed", "rawInput": {"action": "kill", "name": "verifier"}}),
        );
        assert_eq!(
            evs_kill,
            vec![EventKind::SubagentStatusChanged {
                thread_id: "verifier".into(),
                turn_id: None,
                status: SubagentStatus::Shutdown,
                message: None,
            }]
        );

        // 3. invoke_subagent emits Spawned+Running then Completed.
        let (_, evs_sub_start) = tracker.on_tool_update(
            "root-1",
            &json!({"toolCallId": "tc-sub", "title": "invoke_subagent", "status": "in_progress", "rawInput": {"agent_type": "explore", "prompt": "Scan repo"}}),
        );
        assert_eq!(evs_sub_start.len(), 2);
        let (_, evs_sub_end) = tracker.on_tool_update(
            "root-1",
            &json!({"toolCallId": "tc-sub", "status": "completed", "rawOutput": {"summary": "Found 3 files"}}),
        );
        assert_eq!(
            evs_sub_end,
            vec![EventKind::SubagentStatusChanged {
                thread_id: "tc-sub".into(),
                turn_id: None,
                status: SubagentStatus::Completed,
                message: Some("Found 3 files".into()),
            }]
        );

        // 4. swarm_wait toggles waiting true -> false.
        let (_, w1) = tracker.on_tool_update("root-1", &json!({"toolCallId": "tc-wait", "title": "swarm_wait", "status": "in_progress"}));
        let (_, w2) = tracker.on_tool_update("root-1", &json!({"toolCallId": "tc-wait", "status": "completed"}));
        assert_eq!(
            w1,
            vec![EventKind::SubagentWait {
                thread_id: "root-1".into(),
                call_id: "tc-wait".into(),
                targets: vec!["board".into()],
                waiting: true,
            }]
        );
        assert_eq!(
            w2,
            vec![EventKind::SubagentWait {
                thread_id: "root-1".into(),
                call_id: "tc-wait".into(),
                targets: vec!["board".into()],
                waiting: false,
            }]
        );

        // 5. post_message emits SubagentMessage on swarm-board.
        let (_, pm) = tracker.on_tool_update(
            "root-1",
            &json!({"toolCallId": "tc-post", "title": "post_message", "status": "completed", "rawInput": {"text": "@all ready"}}),
        );
        assert_eq!(
            pm,
            vec![EventKind::SubagentMessage {
                thread_id: "swarm-board".into(),
                turn_id: "tc-post".into(),
                text: "@all ready".into(),
            }]
        );

        // 6. Unrelated tool returns matched=false.
        let (other_matched, other_evs) = tracker.on_tool_update("root-1", &json!({"toolCallId": "tc-other", "title": "read_file", "status": "completed"}));
        assert!(!other_matched);
        assert!(other_evs.is_empty());
    }
}
