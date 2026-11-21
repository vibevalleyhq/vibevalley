use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::agent::ai::stream::CancelToken;
use crate::agent::{BrainError, Result};

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

    pub fn assistant(text: impl Into<String>) -> Message {
        Message {
            role: Role::Assistant,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponseFormat {
    Text,
    JsonObject,
}

impl ResponseFormat {
    pub fn to_wire(self) -> Value {
        match self {
            Self::Text => json!({ "type": "text" }),
            Self::JsonObject => json!({ "type": "json_object" }),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolSpec>,
    /// `None`: no thinking. `Some("high")` and so on: sent as
    /// `reasoning_effort` with thinking enabled.
    pub effort: Option<String>,
    pub response_format: Option<ResponseFormat>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
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

    fn complete_cancellable(&self, request: &ChatRequest, cancel: &CancelToken, on: &mut dyn FnMut(Delta)) -> Result<Completion> {
        if cancel.is_cancelled() {
            return Err(BrainError::Cancelled);
        }
        self.complete(request, on)
    }
}
