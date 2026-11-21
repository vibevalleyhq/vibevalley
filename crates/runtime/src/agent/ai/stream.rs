use std::io::BufRead;
use std::sync::Mutex;

use serde_json::Value;

use crate::agent::ai::types::{Completion, Delta, FinishReason, Message, Role, ToolCall, Usage};
use crate::agent::{BrainError, Result};

#[derive(Clone, Debug, Default)]
pub struct CancelToken {
    rx: Option<flume::Receiver<()>>,
}

impl CancelToken {
    pub fn never() -> Self {
        Self { rx: None }
    }

    pub fn from_receiver(rx: flume::Receiver<()>) -> Self {
        Self { rx: Some(rx) }
    }

    pub fn is_cancelled(&self) -> bool {
        self.rx.as_ref().is_some_and(flume::Receiver::is_disconnected)
    }

    pub fn receiver(&self) -> Option<&flume::Receiver<()>> {
        self.rx.as_ref()
    }
}

struct Signal {
    tx: Option<flume::Sender<()>>,
    rx: flume::Receiver<()>,
}

impl Signal {
    fn open() -> Self {
        let (tx, rx) = flume::bounded(0);
        Self { tx: Some(tx), rx }
    }
}

pub struct CancelHandle {
    state: Mutex<Signal>,
}

impl Default for CancelHandle {
    fn default() -> Self {
        Self::new()
    }
}

impl CancelHandle {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(Signal::open()),
        }
    }

    pub fn token(&self) -> CancelToken {
        let rx = self.state.lock().unwrap_or_else(|e| e.into_inner()).rx.clone();
        CancelToken::from_receiver(rx)
    }

    pub fn cancel(&self) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).tx.take();
    }

    pub fn reset(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.tx.is_none() {
            *state = Signal::open();
        }
    }
}

/// Folds an SSE stream of chat completion chunks into one completion, checking `cancel` between chunks.
pub fn fold_stream(mut reader: impl BufRead, cancel: &CancelToken, on: &mut dyn FnMut(Delta)) -> Result<Completion> {
    let mut text = String::new();
    let mut reasoning = String::new();
    // Tool calls arrive in pieces keyed by index; the id may come late.
    let mut calls: Vec<ToolCall> = Vec::new();
    let mut finish = None;
    let mut usage = Usage::default();
    let mut line = String::new();
    loop {
        if cancel.is_cancelled() {
            return Err(BrainError::Cancelled);
        }
        line.clear();
        let read = reader.read_line(&mut line).map_err(|e| BrainError::Network(e.to_string()))?;
        if read == 0 {
            break;
        }
        if cancel.is_cancelled() {
            return Err(BrainError::Cancelled);
        }
        let Some(data) = line.strip_prefix("data:").map(str::trim) else {
            continue;
        };
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
