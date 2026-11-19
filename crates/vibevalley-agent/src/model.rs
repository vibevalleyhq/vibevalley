//! Messages and the model client. The wire is OpenAI-compatible chat
//! completions as DeepSeek serves them, including the fields DeepSeek adds:
//! `reasoning_content` (must be sent back on assistant messages that carry
//! tool calls) and `reasoning_effort`.

use std::io::{BufRead, BufReader};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{BrainError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// The raw JSON text the model produced.
    pub arguments: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl Message {
    pub fn system(text: impl Into<String>) -> Message {
        Message {
            role: Role::System,
            content: Some(text.into()),
            reasoning: None,
            tool_calls: vec![],
            tool_call_id: None,
        }
    }
    pub fn user(text: impl Into<String>) -> Message {
        Message {
            role: Role::User,
            content: Some(text.into()),
            reasoning: None,
            tool_calls: vec![],
            tool_call_id: None,
        }
    }
    pub fn tool(id: impl Into<String>, text: impl Into<String>) -> Message {
        Message {
            role: Role::Tool,
            content: Some(text.into()),
            reasoning: None,
            tool_calls: vec![],
            tool_call_id: Some(id.into()),
        }
    }

    /// The message as the API wants it.
    pub fn to_wire(&self) -> Value {
        let mut m = json!({ "role": self.role });
        match self.role {
            Role::Assistant if !self.tool_calls.is_empty() => {
                // A pure tool-call answer goes back with content null and
                // its reasoning, or DeepSeek refuses the next request.
                m["content"] = self.content.clone().filter(|c| !c.is_empty()).map(Value::String).unwrap_or(Value::Null);
                if let Some(r) = &self.reasoning {
                    m["reasoning_content"] = json!(r);
                }
                m["tool_calls"] = self
                    .tool_calls
                    .iter()
                    .map(|c| json!({ "id": c.id, "type": "function", "function": { "name": c.name, "arguments": c.arguments } }))
                    .collect();
            }
            _ => m["content"] = json!(self.content.clone().unwrap_or_default()),
        }
        if let Some(id) = &self.tool_call_id {
            m["tool_call_id"] = json!(id);
        }
        m
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    /// Prompt tokens, cache hits included.
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
}

impl Usage {
    pub fn add(&mut self, other: Usage) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema of the arguments.
    pub parameters: Value,
}

#[derive(Debug, Clone, Default)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolSpec>,
    /// `None`: no thinking. `Some("high")` and so on: sent as
    /// `reasoning_effort` with thinking enabled.
    pub effort: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Delta {
    Text(String),
    Reasoning(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum FinishReason {
    Stop,
    ToolCalls,
    Length,
    Other(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Completion {
    pub message: Message,
    pub finish: FinishReason,
    pub usage: Usage,
}

/// Streams one completion; `on` sees text and reasoning as they arrive.
pub trait ModelClient: Send + Sync {
    fn complete(&self, request: &ChatRequest, on: &mut dyn FnMut(Delta)) -> Result<Completion>;
}

/// DeepSeek (or any OpenAI-compatible endpoint). The key is read on every
/// request, so a key set in the settings takes effect without a restart.
pub struct OpenAiClient {
    pub base_url: String,
    pub key: Box<dyn Fn() -> Option<String> + Send + Sync>,
    agent: ureq::Agent,
}

impl OpenAiClient {
    pub fn deepseek(key: impl Fn() -> Option<String> + Send + Sync + 'static) -> OpenAiClient {
        OpenAiClient::new("https://api.deepseek.com", key)
    }

    pub fn new(base_url: impl Into<String>, key: impl Fn() -> Option<String> + Send + Sync + 'static) -> OpenAiClient {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(600)))
            .http_status_as_error(false)
            .build()
            .into();
        OpenAiClient {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            key: Box::new(key),
            agent,
        }
    }
}

pub(crate) fn request_body(request: &ChatRequest) -> Value {
    let mut body = json!({
        "model": request.model,
        "messages": request.messages.iter().map(Message::to_wire).collect::<Vec<_>>(),
        "stream": true,
        "stream_options": { "include_usage": true },
    });
    if !request.tools.is_empty() {
        body["tools"] = request
            .tools
            .iter()
            .map(|t| json!({ "type": "function", "function": { "name": t.name, "description": t.description, "parameters": t.parameters } }))
            .collect();
    }
    match &request.effort {
        Some(effort) => {
            body["thinking"] = json!({ "type": "enabled" });
            body["reasoning_effort"] = json!(effort);
        }
        None => body["thinking"] = json!({ "type": "disabled" }),
    }
    body
}

/// Folds an SSE stream of chat completion chunks into one completion.
pub(crate) fn fold_stream(reader: impl BufRead, on: &mut dyn FnMut(Delta)) -> Result<Completion> {
    let mut text = String::new();
    let mut reasoning = String::new();
    // Tool calls arrive in pieces keyed by index; the id may come late.
    let mut calls: Vec<ToolCall> = Vec::new();
    let mut finish = None;
    let mut usage = Usage::default();
    for line in reader.lines() {
        let line = line.map_err(|e| BrainError::Network(e.to_string()))?;
        let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue };
        if data == "[DONE]" {
            break;
        }
        let Ok(chunk) = serde_json::from_str::<Value>(data) else { continue };
        if let Some(error) = chunk.get("error") {
            return Err(BrainError::Model(error.get("message").and_then(Value::as_str).unwrap_or("error").to_string()));
        }
        // Usage may sit on the chunk or on its choice.
        for u in [chunk.get("usage"), chunk.pointer("/choices/0/usage")].into_iter().flatten() {
            if u.is_object() {
                usage = Usage {
                    input: u["prompt_tokens"].as_u64().unwrap_or(0),
                    output: u["completion_tokens"].as_u64().unwrap_or(0),
                    cache_read: u["prompt_cache_hit_tokens"]
                        .as_u64()
                        .or_else(|| u.pointer("/prompt_tokens_details/cached_tokens").and_then(Value::as_u64))
                        .unwrap_or(0),
                };
            }
        }
        let Some(choice) = chunk.pointer("/choices/0") else { continue };
        let delta = &choice["delta"];
        if let Some(r) = delta["reasoning_content"].as_str().filter(|s| !s.is_empty()) {
            reasoning.push_str(r);
            on(Delta::Reasoning(r.to_string()));
        }
        if let Some(t) = delta["content"].as_str().filter(|s| !s.is_empty()) {
            text.push_str(t);
            on(Delta::Text(t.to_string()));
        }
        for piece in delta["tool_calls"].as_array().into_iter().flatten() {
            let index = piece["index"].as_u64().unwrap_or(calls.len() as u64) as usize;
            while calls.len() <= index {
                calls.push(ToolCall {
                    id: String::new(),
                    name: String::new(),
                    arguments: String::new(),
                });
            }
            let call = &mut calls[index];
            if let Some(id) = piece["id"].as_str().filter(|s| !s.is_empty()) {
                call.id = id.to_string();
            }
            if let Some(name) = piece.pointer("/function/name").and_then(Value::as_str) {
                call.name.push_str(name);
            }
            if let Some(args) = piece.pointer("/function/arguments").and_then(Value::as_str) {
                call.arguments.push_str(args);
            }
        }
        if let Some(reason) = choice["finish_reason"].as_str() {
            finish = Some(match reason {
                "stop" => FinishReason::Stop,
                "tool_calls" => FinishReason::ToolCalls,
                "length" => FinishReason::Length,
                other => FinishReason::Other(other.to_string()),
            });
        }
    }
    for (n, call) in calls.iter_mut().enumerate() {
        if call.id.is_empty() {
            call.id = format!("call_{n}");
        }
    }
    let finish = finish.unwrap_or(if calls.is_empty() { FinishReason::Stop } else { FinishReason::ToolCalls });
    let message = Message {
        role: Role::Assistant,
        content: (!text.is_empty()).then_some(text),
        reasoning: (!reasoning.is_empty()).then_some(reasoning),
        tool_calls: calls,
        tool_call_id: None,
    };
    Ok(Completion { message, finish, usage })
}

impl ModelClient for OpenAiClient {
    fn complete(&self, request: &ChatRequest, on: &mut dyn FnMut(Delta)) -> Result<Completion> {
        let key = (self.key)().filter(|k| !k.trim().is_empty()).ok_or(BrainError::NoKey)?;
        let response = self
            .agent
            .post(format!("{}/chat/completions", self.base_url))
            .header("Authorization", format!("Bearer {key}"))
            .header("Accept", "text/event-stream")
            .send_json(request_body(request))
            .map_err(|e| BrainError::Network(e.to_string()))?;
        let status = response.status().as_u16();
        let mut body = response.into_body();
        if status >= 400 {
            let text = body.read_to_string().unwrap_or_default();
            let message = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v.pointer("/error/message").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_else(|| text.clone());
            if matches!(status, 400 | 413 | 422)
                && (message.to_lowercase().contains("context length")
                    || message.to_lowercase().contains("context window")
                    || text.contains("context_length_exceeded"))
            {
                return Err(BrainError::ContextOverflow(message));
            }
            return Err(BrainError::Model(format!("HTTP {status}: {message}")));
        }
        fold_stream(BufReader::new(body.into_reader()), on)
    }
}
