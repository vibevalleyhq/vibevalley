//! Antigravity CLI (`agy >= 1.5.0`) ACP protocol policy, payload normalization,
//! interaction routing, and background-continuation tracking.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::oar::{Installation, InteractionOption, PermissionMode, SessionOptions};

pub(crate) const MIN_VERSION: (u64, u64, u64) = (1, 5, 0);
pub(crate) const FIELD_TEXT_LIMIT: usize = 8 * 1024;
pub(crate) const PAYLOAD_BYTE_LIMIT: usize = 64 * 1024;
pub(crate) const PAYLOAD_NODE_LIMIT: usize = 512;

const AUTH_LINK_PREFIX: &str = "Open the following link to authenticate the ACP server:";

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
}
