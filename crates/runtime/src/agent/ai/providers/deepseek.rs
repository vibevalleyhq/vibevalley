use std::io;
use std::time::Duration;

use futures_util::{StreamExt, TryStreamExt};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use tokio_util::codec::{FramedRead, LinesCodec};
use tokio_util::io::StreamReader;

use crate::agent::ai::retry::{RetryPolicy, parse_retry_after, sleep_interruptible_async};
use crate::agent::ai::stream::{CancelToken, SseFold};
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
    client: reqwest::Client,
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
        // Install ring before building reqwest so rustls-no-provider + platform verifier works without webpki-roots.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(600))
            .build()
            .expect("reqwest OpenAiClient");
        OpenAiClient {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            key: Box::new(key),
            retry: RetryPolicy::default(),
            client,
        }
    }

    pub fn with_retry(mut self, policy: RetryPolicy) -> Self {
        self.retry = policy;
        self
    }

    pub fn fetch_balance(&self) -> Result<AccountBalance> {
        let key = (self.key)().filter(|k| !k.trim().is_empty()).ok_or(BrainError::NoKey)?;
        let url = format!("{}/user/balance", self.base_url);
        let client = self.client.clone();
        let retry = self.retry;
        crate::rt::block_on(async move {
            let mut backoff = retry.backoff();
            loop {
                match client.get(&url).header("Authorization", format!("Bearer {key}")).send().await {
                    Ok(response) => {
                        let status = response.status().as_u16();
                        let retry_after = response.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(parse_retry_after);
                        let text = response.text().await.map_err(|e| BrainError::Network(e.to_string()))?;
                        if status >= 400 {
                            if RetryPolicy::is_retryable_status(status)
                                && let Some(default_delay) = backoff.next()
                            {
                                tokio::time::sleep(RetryPolicy::resolve_delay(default_delay, retry_after)).await;
                                continue;
                            }
                            return Err(BrainError::Model(format!("HTTP {status}: {}", error_message(&text))));
                        }
                        return serde_json::from_str(&text).map_err(|e| BrainError::Model(format!("invalid balance response: {e}")));
                    }
                    Err(err) => {
                        if RetryPolicy::is_retryable_error(&err)
                            && let Some(delay) = backoff.next()
                        {
                            tokio::time::sleep(delay).await;
                            continue;
                        }
                        return Err(BrainError::Network(err.to_string()));
                    }
                }
            }
        })
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

async fn fold_sse_response(response: reqwest::Response, cancel: &CancelToken, on: &mut dyn FnMut(Delta)) -> Result<Completion> {
    let stream = response.bytes_stream().map_err(io::Error::other);
    let lines = FramedRead::new(StreamReader::new(stream), LinesCodec::new());
    tokio::pin!(lines);
    let mut fold = SseFold::new();
    loop {
        if cancel.is_cancelled() {
            return Err(BrainError::Cancelled);
        }
        let next = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(BrainError::Cancelled),
            item = lines.next() => item,
        };
        let Some(line) = next else {
            break;
        };
        let line = line.map_err(|e| BrainError::Network(e.to_string()))?;
        if fold.push_line(&line, on)? {
            return Ok(fold.finish());
        }
        if cancel.is_cancelled() {
            return Err(BrainError::Cancelled);
        }
    }
    Ok(fold.finish())
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
        let client = &self.client;
        let retry = self.retry;
        crate::rt::block_on(async {
            let mut backoff = retry.backoff();
            loop {
                if cancel.is_cancelled() {
                    return Err(BrainError::Cancelled);
                }
                let sent = tokio::select! {
                    biased;
                    () = cancel.cancelled() => return Err(BrainError::Cancelled),
                    res = client
                        .post(&url)
                        .header("Authorization", format!("Bearer {key}"))
                        .header("Accept", "text/event-stream")
                        .json(&body)
                        .send() => res,
                };
                let response = match sent {
                    Ok(r) => r,
                    Err(err) => {
                        let network = BrainError::Network(err.to_string());
                        if RetryPolicy::is_retryable_error(&err)
                            && let Some(delay) = backoff.next()
                        {
                            if !sleep_interruptible_async(delay, cancel).await {
                                return Err(BrainError::Cancelled);
                            }
                            continue;
                        }
                        return Err(network);
                    }
                };
                let status = response.status().as_u16();
                let retry_after = response.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(parse_retry_after);
                if status >= 400 {
                    let text = tokio::select! {
                        biased;
                        () = cancel.cancelled() => return Err(BrainError::Cancelled),
                        res = response.text() => res.unwrap_or_default(),
                    };
                    let err = classify_http_error(status, &text);
                    if RetryPolicy::is_retryable_status(status)
                        && let Some(default_delay) = backoff.next()
                    {
                        let delay = RetryPolicy::resolve_delay(default_delay, retry_after);
                        if !sleep_interruptible_async(delay, cancel).await {
                            return Err(BrainError::Cancelled);
                        }
                        continue;
                    }
                    return Err(err);
                }
                return fold_sse_response(response, cancel, on).await;
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    #[test]
    fn regression_deepseek_sse_preserves_multibyte_utf8_split_across_chunks() {
        let chinese = "你好深度求索：分片测试";
        let payload = format!("data: {{\"choices\":[{{\"index\":0,\"delta\":{{\"content\":\"{chinese}\"}}}}]}}\n\ndata: [DONE]\n\n");
        let raw = payload.as_bytes().to_vec();
        let first_non_ascii = raw.iter().position(|&b| b >= 0x80).expect("multi-byte UTF-8");
        let split_at = first_non_ascii + 1;
        assert!(std::str::from_utf8(&raw[..split_at]).is_err());
        let part1 = raw[..split_at].to_vec();
        let part2 = raw[split_at..].to_vec();

        let addr = crate::rt::block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut req_buf = vec![0u8; 4096];
                let _ = sock.read(&mut req_buf).await;
                sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n")
                    .await
                    .unwrap();
                sock.write_all(format!("{:x}\r\n", part1.len()).as_bytes()).await.unwrap();
                sock.write_all(&part1).await.unwrap();
                sock.write_all(b"\r\n").await.unwrap();
                sock.flush().await.unwrap();
                tokio::time::sleep(Duration::from_millis(15)).await;
                sock.write_all(format!("{:x}\r\n", part2.len()).as_bytes()).await.unwrap();
                sock.write_all(&part2).await.unwrap();
                sock.write_all(b"\r\n0\r\n\r\n").await.unwrap();
                sock.flush().await.unwrap();
            });
            addr
        });

        let client = OpenAiClient::new(format!("http://{addr}"), || Some("sk-test".into())).with_retry(RetryPolicy::none());
        let req = ChatRequest {
            model: "deepseek-chat".into(),
            messages: vec![Message::user("hi")],
            ..Default::default()
        };
        let mut streamed = String::new();
        let completion = client
            .complete(&req, &mut |delta| {
                if let Delta::Text(t) = delta {
                    streamed.push_str(&t);
                }
            })
            .unwrap();
        assert!(!streamed.contains('\u{FFFD}'));
        assert_eq!(streamed, chinese);
        assert_eq!(completion.message.content.as_deref(), Some(chinese));
    }
}
