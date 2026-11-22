use std::io::BufReader;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};

use crate::agent::ai::retry::{RetryPolicy, parse_retry_after, sleep_interruptible};
use crate::agent::ai::stream::{CancelToken, fold_stream};
use crate::agent::ai::types::{ChatRequest, Completion, Delta, Message, ModelClient};
use crate::agent::{BrainError, Result};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BalanceEntry {
    pub currency: String,
    #[serde(deserialize_with = "de_f64_or_string")]
    pub total_balance: f64,
    #[serde(default, deserialize_with = "de_f64_or_string")]
    pub granted_balance: f64,
    #[serde(default, deserialize_with = "de_f64_or_string")]
    pub topped_up_balance: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AccountBalance {
    pub is_available: bool,
    #[serde(default)]
    pub balance_infos: Vec<BalanceEntry>,
}

fn de_f64_or_string<'de, D>(deserializer: D) -> std::result::Result<f64, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum NumOrStr {
        Num(f64),
        Str(String),
    }
    match NumOrStr::deserialize(deserializer)? {
        NumOrStr::Num(n) => Ok(n),
        NumOrStr::Str(s) => s.trim().parse::<f64>().map_err(serde::de::Error::custom),
    }
}

/// DeepSeek (or any OpenAI-compatible endpoint). The key is read on every
/// request, so a key set in the settings takes effect without a restart.
pub struct OpenAiClient {
    pub base_url: String,
    pub key: Box<dyn Fn() -> Option<String> + Send + Sync>,
    pub retry: RetryPolicy,
    agent: ureq::Agent,
}

impl OpenAiClient {
    pub fn deepseek(key: impl Fn() -> Option<String> + Send + Sync + 'static) -> OpenAiClient {
        let base_url = std::env::var("DEEPSEEK_BASE_URL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "https://api.deepseek.com".to_string());
        OpenAiClient::new(base_url, key)
    }

    pub fn new(base_url: impl Into<String>, key: impl Fn() -> Option<String> + Send + Sync + 'static) -> OpenAiClient {
        // Explicit ring provider + OS platform verifier avoids ureq's default webpki-roots bundle
        // while preserving HTTPS for production endpoints like https://api.deepseek.com.
        let tls = ureq::tls::TlsConfig::builder()
            .root_certs(ureq::tls::RootCerts::PlatformVerifier)
            .unversioned_rustls_crypto_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .build();
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .tls_config(tls)
            .timeout_global(Some(Duration::from_secs(600)))
            .http_status_as_error(false)
            .build()
            .into();
        OpenAiClient {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            key: Box::new(key),
            retry: RetryPolicy::default(),
            agent,
        }
    }

    pub fn with_retry(mut self, policy: RetryPolicy) -> Self {
        self.retry = policy;
        self
    }

    pub fn fetch_balance(&self) -> Result<AccountBalance> {
        let key = (self.key)().filter(|k| !k.trim().is_empty()).ok_or(BrainError::NoKey)?;
        let url = format!("{}/user/balance", self.base_url);
        for attempt in 0..=self.retry.max_retries {
            match self.agent.get(&url).header("Authorization", format!("Bearer {key}")).call() {
                Ok(response) => {
                    let status = response.status().as_u16();
                    let retry_after = response.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(parse_retry_after);
                    let mut body = response.into_body();
                    let text = body.read_to_string().map_err(|e| BrainError::Network(e.to_string()))?;
                    if status >= 400 {
                        if RetryPolicy::is_retryable_status(status) && attempt < self.retry.max_retries {
                            let delay = self.retry.delay_for(attempt, retry_after);
                            std::thread::sleep(delay);
                            continue;
                        }
                        return Err(BrainError::Model(format!("HTTP {status}: {}", error_message(&text))));
                    }
                    return serde_json::from_str(&text).map_err(|e| BrainError::Model(format!("invalid balance response: {e}")));
                }
                Err(err) => {
                    if RetryPolicy::is_retryable_error(&err) && attempt < self.retry.max_retries {
                        let delay = self.retry.delay_for(attempt, None);
                        std::thread::sleep(delay);
                        continue;
                    }
                    return Err(BrainError::Network(err.to_string()));
                }
            }
        }
        unreachable!()
    }
}

pub fn request_body(request: &ChatRequest) -> Value {
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
    if let Some(format) = request.response_format {
        body["response_format"] = format.to_wire();
    }
    if let Some(max_tokens) = request.max_tokens {
        body["max_tokens"] = json!(max_tokens);
    }
    if let Some(temperature) = request.temperature {
        body["temperature"] = json!(temperature);
    }
    body
}

enum AttemptOutcome {
    Complete(Result<Completion>),
    Retry { delay: Duration, fallback: BrainError },
}

enum StreamMsg {
    Delta(Delta),
    Finished(AttemptOutcome),
}

fn error_message(text: &str) -> String {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v.pointer("/error/message").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| text.to_string())
}

fn classify_http_error(status: u16, text: &str) -> BrainError {
    let message = error_message(text);
    if matches!(status, 400 | 413 | 422)
        && (message.to_lowercase().contains("context length") || message.to_lowercase().contains("context window") || text.contains("context_length_exceeded"))
    {
        BrainError::ContextOverflow(message)
    } else {
        BrainError::Model(format!("HTTP {status}: {message}"))
    }
}

struct AttemptCall<'a> {
    agent: &'a ureq::Agent,
    url: &'a str,
    key: &'a str,
    body: &'a Value,
    policy: RetryPolicy,
}

fn send_attempt(call: &AttemptCall<'_>, attempt: usize, cancel: &CancelToken, on: &mut dyn FnMut(Delta)) -> AttemptOutcome {
    if cancel.is_cancelled() {
        return AttemptOutcome::Complete(Err(BrainError::Cancelled));
    }
    let response = match call
        .agent
        .post(call.url)
        .header("Authorization", format!("Bearer {}", call.key))
        .header("Accept", "text/event-stream")
        .send_json(call.body)
    {
        Ok(r) => r,
        Err(err) => {
            let network = BrainError::Network(err.to_string());
            if RetryPolicy::is_retryable_error(&err) && attempt < call.policy.max_retries {
                return AttemptOutcome::Retry {
                    delay: call.policy.delay_for(attempt, None),
                    fallback: network,
                };
            }
            return AttemptOutcome::Complete(Err(network));
        }
    };
    let status = response.status().as_u16();
    let retry_after = response.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(parse_retry_after);
    let mut body = response.into_body();
    if status >= 400 {
        let text = body.read_to_string().unwrap_or_default();
        let err = classify_http_error(status, &text);
        if RetryPolicy::is_retryable_status(status) && attempt < call.policy.max_retries {
            return AttemptOutcome::Retry {
                delay: call.policy.delay_for(attempt, retry_after),
                fallback: err,
            };
        }
        return AttemptOutcome::Complete(Err(err));
    }
    AttemptOutcome::Complete(fold_stream(BufReader::new(body.into_reader()), cancel, on))
}

fn send_attempt_cancellable(call: &AttemptCall<'_>, attempt: usize, cancel: &CancelToken, on: &mut dyn FnMut(Delta)) -> AttemptOutcome {
    let Some(cancel_rx) = cancel.receiver() else {
        return send_attempt(call, attempt, cancel, on);
    };
    if cancel.is_cancelled() {
        return AttemptOutcome::Complete(Err(BrainError::Cancelled));
    }
    let (tx, rx) = flume::unbounded::<StreamMsg>();
    let agent = call.agent.clone();
    let url = call.url.to_string();
    let key = call.key.to_string();
    let body = call.body.clone();
    let policy = call.policy;
    let cancel_worker = cancel.clone();
    std::thread::spawn(move || {
        let owned = AttemptCall {
            agent: &agent,
            url: &url,
            key: &key,
            body: &body,
            policy,
        };
        let outcome = send_attempt(&owned, attempt, &cancel_worker, &mut |d| {
            let _ = tx.send(StreamMsg::Delta(d));
        });
        let _ = tx.send(StreamMsg::Finished(outcome));
    });
    enum Pick {
        Msg(Result<StreamMsg>),
        Cancelled,
    }
    loop {
        let pick = flume::Selector::new()
            .recv(&rx, |r| Pick::Msg(r.map_err(|_| BrainError::Network("stream worker exited".into()))))
            .recv(cancel_rx, |_| Pick::Cancelled)
            .wait();
        match pick {
            Pick::Cancelled => return AttemptOutcome::Complete(Err(BrainError::Cancelled)),
            Pick::Msg(Ok(StreamMsg::Delta(delta))) => on(delta),
            Pick::Msg(Ok(StreamMsg::Finished(outcome))) => return outcome,
            Pick::Msg(Err(err)) => return AttemptOutcome::Complete(Err(err)),
        }
    }
}

impl ModelClient for OpenAiClient {
    fn complete(&self, request: &ChatRequest, on: &mut dyn FnMut(Delta)) -> Result<Completion> {
        self.complete_cancellable(request, &CancelToken::never(), on)
    }

    fn complete_cancellable(&self, request: &ChatRequest, cancel: &CancelToken, on: &mut dyn FnMut(Delta)) -> Result<Completion> {
        if cancel.is_cancelled() {
            return Err(BrainError::Cancelled);
        }
        let key = (self.key)().filter(|k| !k.trim().is_empty()).ok_or(BrainError::NoKey)?;
        let url = format!("{}/chat/completions", self.base_url);
        let body = request_body(request);
        let call = AttemptCall {
            agent: &self.agent,
            url: &url,
            key: &key,
            body: &body,
            policy: self.retry,
        };
        for attempt in 0..=self.retry.max_retries {
            match send_attempt_cancellable(&call, attempt, cancel, on) {
                AttemptOutcome::Complete(result) => return result,
                AttemptOutcome::Retry { delay, fallback } => {
                    if !sleep_interruptible(delay, cancel) {
                        return Err(BrainError::Cancelled);
                    }
                    if attempt == self.retry.max_retries {
                        return Err(fallback);
                    }
                }
            }
        }
        unreachable!()
    }
}
