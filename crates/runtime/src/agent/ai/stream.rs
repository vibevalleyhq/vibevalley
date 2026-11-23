use std::io::BufRead;
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::agent::ai::types::{Completion, Delta, FinishReason, Message, Role, ToolCall, Usage};
use crate::agent::{BrainError, Result};

#[derive(Debug)]
struct CancelInner {
    token: CancellationToken,
    /// Lazily bridged `flume::Receiver<()>` for legacy sync callers using `flume::Selector` / `recv_timeout`.
    bridge_rx: OnceLock<flume::Receiver<()>>,
}

#[derive(Clone, Debug, Default)]
pub struct CancelToken {
    inner: Option<Arc<CancelInner>>,
}

impl CancelToken {
    pub fn never() -> Self {
        Self { inner: None }
    }

    pub fn from_tokio(token: CancellationToken) -> Self {
        Self {
            inner: Some(Arc::new(CancelInner {
                token,
                bridge_rx: OnceLock::new(),
            })),
        }
    }

    pub fn from_receiver(rx: flume::Receiver<()>) -> Self {
        let token = CancellationToken::new();
        let bridge_rx = OnceLock::new();
        let _ = bridge_rx.set(rx.clone());
        if rx.is_disconnected() {
            token.cancel();
        } else {
            let tok = token.clone();
            crate::rt::spawn(async move {
                let _ = rx.recv_async().await;
                tok.cancel();
            });
        }
        Self {
            inner: Some(Arc::new(CancelInner { token, bridge_rx })),
        }
    }

    pub fn token(&self) -> Option<&CancellationToken> {
        self.inner.as_ref().map(|i| &i.token)
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.as_ref().is_some_and(|i| i.token.is_cancelled())
    }

    pub fn receiver(&self) -> Option<&flume::Receiver<()>> {
        let inner = self.inner.as_ref()?;
        Some(inner.bridge_rx.get_or_init(|| {
            let (tx, rx) = flume::bounded(0);
            if inner.token.is_cancelled() {
                drop(tx);
            } else {
                let tok = inner.token.clone();
                crate::rt::spawn(async move {
                    tok.cancelled().await;
                    drop(tx);
                });
            }
            rx
        }))
    }

    pub(crate) async fn cancelled(&self) {
        match &self.inner {
            Some(inner) => inner.token.cancelled().await,
            None => std::future::pending().await,
        }
    }
}

pub struct CancelHandle {
    token: Mutex<CancellationToken>,
}

impl Drop for CancelHandle {
    fn drop(&mut self) {
        self.token.get_mut().cancel();
    }
}

impl Default for CancelHandle {
    fn default() -> Self {
        Self::new()
    }
}

impl CancelHandle {
    pub fn new() -> Self {
        Self {
            token: Mutex::new(CancellationToken::new()),
        }
    }

    pub fn token(&self) -> CancelToken {
        CancelToken::from_tokio(self.token.lock().clone())
    }

    pub fn cancel(&self) {
        self.token.lock().cancel();
    }

    pub fn reset(&self) {
        let mut token = self.token.lock();
        if token.is_cancelled() {
            *token = CancellationToken::new();
        }
    }
}

#[derive(Default)]
pub(crate) struct SseFold {
    text: String,
    reasoning: String,
    // Tool calls arrive in pieces keyed by index; the id may come late.
    calls: Vec<ToolCall>,
    finish: Option<FinishReason>,
    usage: Usage,
}

impl SseFold {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Consumes one SSE line and returns `Ok(true)` once `[DONE]` is seen.
    pub(crate) fn push_line(&mut self, line: &str, on: &mut dyn FnMut(Delta)) -> Result<bool> {
        let Some(data) = line.strip_prefix("data:").map(str::trim) else {
            return Ok(false);
        };
        if data == "[DONE]" {
            return Ok(true);
        }
        let Ok(chunk) = serde_json::from_str::<Value>(data) else {
            return Ok(false);
        };
        if let Some(error) = chunk.get("error") {
            return Err(BrainError::Model(error.get("message").and_then(Value::as_str).unwrap_or("error").to_string()));
        }
        // Usage may sit on the chunk or on its choice.
        for u in [chunk.get("usage"), chunk.pointer("/choices/0/usage")].into_iter().flatten() {
            if u.is_object() {
                self.usage = Usage {
                    input: u["prompt_tokens"].as_u64().unwrap_or(0),
                    output: u["completion_tokens"].as_u64().unwrap_or(0),
                    cache_read: u["prompt_cache_hit_tokens"]
                        .as_u64()
                        .or_else(|| u.pointer("/prompt_tokens_details/cached_tokens").and_then(Value::as_u64))
                        .unwrap_or(0),
                };
            }
        }
        let Some(choice) = chunk.pointer("/choices/0") else {
            return Ok(false);
        };
        let delta = &choice["delta"];
        if let Some(r) = delta["reasoning_content"].as_str().filter(|s| !s.is_empty()) {
            self.reasoning.push_str(r);
            on(Delta::Reasoning(r.to_string()));
        }
        if let Some(t) = delta["content"].as_str().filter(|s| !s.is_empty()) {
            self.text.push_str(t);
            on(Delta::Text(t.to_string()));
        }
        for piece in delta["tool_calls"].as_array().into_iter().flatten() {
            let index = piece["index"].as_u64().unwrap_or(self.calls.len() as u64) as usize;
            while self.calls.len() <= index {
                self.calls.push(ToolCall {
                    id: String::new(),
                    name: String::new(),
                    arguments: String::new(),
                });
            }
            let call = &mut self.calls[index];
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
            self.finish = Some(match reason {
                "stop" => FinishReason::Stop,
                "tool_calls" => FinishReason::ToolCalls,
                "length" => FinishReason::Length,
                other => FinishReason::Other(other.to_string()),
            });
        }
        Ok(false)
    }

    pub(crate) fn finish(mut self) -> Completion {
        for (n, call) in self.calls.iter_mut().enumerate() {
            if call.id.is_empty() {
                call.id = format!("call_{n}");
            }
        }
        let finish = self
            .finish
            .unwrap_or(if self.calls.is_empty() { FinishReason::Stop } else { FinishReason::ToolCalls });
        let message = Message {
            role: Role::Assistant,
            content: (!self.text.is_empty()).then_some(self.text),
            reasoning: (!self.reasoning.is_empty()).then_some(self.reasoning),
            tool_calls: self.calls,
            tool_call_id: None,
        };
        Completion {
            message,
            finish,
            usage: self.usage,
        }
    }
}

/// Folds an SSE stream of chat completion chunks into one completion, checking `cancel` between chunks.
pub fn fold_stream(mut reader: impl BufRead, cancel: &CancelToken, on: &mut dyn FnMut(Delta)) -> Result<Completion> {
    let mut fold = SseFold::new();
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
        if fold.push_line(&line, on)? {
            break;
        }
    }
    Ok(fold.finish())
}
