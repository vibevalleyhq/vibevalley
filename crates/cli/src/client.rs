//! Pooled HTTP client, typed protocol RPC (`ask`/`mutate`), SSE streaming, and structured CLI errors.

use std::io::{BufRead, BufReader};
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use vibevalley_protocol::{ApiErrorKind, BizCode, Envelope, Next, Op, Preview};

use crate::output::Output;

/// Process exit codes scripts can branch on.
pub mod exit {
    pub const OK: i32 = 0;
    pub const OTHER: i32 = 1;
    pub const USAGE: i32 = 2;
    pub const REFUSED: i32 = 3;
    pub const MISSING: i32 = 4;
    pub const UNREACHABLE: i32 = 5;
}

/// Structured command failure printed as one JSON line on stderr.
#[derive(Debug, Clone)]
pub struct Failure {
    pub code: i32,
    pub tag: String,
    pub text: String,
    pub biz_code: Option<u32>,
    pub status: Option<u16>,
    pub next: Vec<Next>,
}

impl Failure {
    pub fn new(code: i32, tag: &str, text: impl Into<String>) -> Self {
        Self {
            code,
            tag: tag.into(),
            text: text.into(),
            biz_code: None,
            status: None,
            next: vec![],
        }
    }

    pub fn usage(tag: &str, text: impl Into<String>) -> Self {
        Self::new(exit::USAGE, tag, text)
    }

    pub fn print(&self) {
        let mut error = json!({ "tag": self.tag, "message": self.text });
        if let Some(code) = self.biz_code {
            error["bizCode"] = json!(code);
        }
        if let Some(status) = self.status {
            error["status"] = json!(status);
        }
        if !self.next.is_empty() {
            error["next"] = json!(self.next);
        }
        eprintln!("{}", json!({ "error": error }));
    }
}

pub type Done = Result<(), Failure>;

pub fn decode_failure(e: impl std::fmt::Display) -> Failure {
    Failure::new(exit::OTHER, "Server", e.to_string())
}

pub fn no_dry_run(command: &str) -> Failure {
    Failure::usage("NoDryRun", format!("{command} does not support --dry-run"))
}

fn code_of(kind: ApiErrorKind) -> i32 {
    match kind {
        ApiErrorKind::InvalidInput => exit::USAGE,
        ApiErrorKind::Unauthorized | ApiErrorKind::Forbidden | ApiErrorKind::Refused | ApiErrorKind::VoiceUnavailable | ApiErrorKind::ServiceUnavailable => {
            exit::REFUSED
        }
        ApiErrorKind::Missing => exit::MISSING,
        ApiErrorKind::VoiceCallFailed | ApiErrorKind::InternalError | ApiErrorKind::BadGateway => exit::OTHER,
    }
}

fn kind_name(kind: ApiErrorKind) -> &'static str {
    match kind {
        ApiErrorKind::InvalidInput => "InvalidInput",
        ApiErrorKind::Unauthorized => "Unauthorized",
        ApiErrorKind::Forbidden => "Forbidden",
        ApiErrorKind::Missing => "Missing",
        ApiErrorKind::Refused => "Refused",
        ApiErrorKind::VoiceUnavailable => "VoiceUnavailable",
        ApiErrorKind::VoiceCallFailed => "VoiceCallFailed",
        ApiErrorKind::InternalError => "InternalError",
        ApiErrorKind::BadGateway => "BadGateway",
        ApiErrorKind::ServiceUnavailable => "ServiceUnavailable",
    }
}

fn unreachable(base: &str, why: impl std::fmt::Display) -> Failure {
    let mut failure = Failure::new(exit::UNREACHABLE, "Unreachable", format!("cannot reach server at {base}: {why}"));
    failure.next = vec![Next {
        say: "Start VibeValley (desktop app or `cargo run -p vibevalley-server`)".into(),
        run: None,
    }];
    failure
}

fn failure_of(status: u16, text: &str) -> Failure {
    let envelope = serde_json::from_str::<Envelope>(text)
        .ok()
        .and_then(|env| BizCode::from_code(env.biz_code).map(|biz| (env, biz)));
    let Some((env, biz)) = envelope else {
        let code = match status {
            404 => exit::MISSING,
            400 => exit::USAGE,
            _ => exit::OTHER,
        };
        let mut failure = Failure::new(code, "Server", text.trim());
        failure.status = Some(status);
        return failure;
    };
    let kind = biz.meta().kind;
    Failure {
        code: code_of(kind),
        tag: kind_name(kind).into(),
        text: env.message,
        biz_code: Some(env.biz_code),
        status: Some(status),
        next: env.error.and_then(|detail| detail.next).unwrap_or_default(),
    }
}

/// Default loopback URL for the active release channel when no server announcement exists.
pub fn fallback_server() -> String {
    format!("http://127.0.0.1:{}", vibevalley_protocol::home::default_port())
}

/// Server URL from `<home>/server.json`, falling back to the channel's default loopback port.
pub fn default_server() -> String {
    vibevalley_protocol::home::announced(&vibevalley_protocol::home::home()).unwrap_or_else(fallback_server)
}

/// Pooled HTTP client shared across a single CLI invocation.
pub struct Client {
    pub server: String,
    pub dry_run: bool,
    pub output: Output,
    http: ureq::Agent,
}

impl Client {
    pub fn new(server: Option<String>, dry_run: bool, json: bool) -> Self {
        let server = server
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("VIBEVALLEY_SERVER").ok().filter(|s| !s.is_empty()))
            .unwrap_or_else(default_server);
        let http = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(5)))
            .build()
            .into();
        Self {
            server,
            dry_run,
            output: Output { json },
            http,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.server.trim_end_matches('/'))
    }

    /// Calls a typed protocol op over `POST /api/v1/<op>`.
    pub fn ask<O: Op>(&self, input: &O::Input) -> Result<O::Result, Failure> {
        let payload = serde_json::to_value(input).unwrap_or(Value::Null);
        let value = self.ask_raw(O::NAME, &payload)?;
        serde_json::from_value(value).map_err(decode_failure)
    }

    fn ask_raw(&self, op: &str, body: &Value) -> Result<Value, Failure> {
        let url = self.url(&format!("/api/v1/{}", op.replace('.', "/")));
        let body = if body.is_null() { json!({}) } else { body.clone() };
        let mut response = self
            .http
            .post(&url)
            .header("content-type", "application/json")
            .send(body.to_string())
            .map_err(|e| unreachable(&self.server, e))?;
        let status = response.status().as_u16();
        let text = response.body_mut().read_to_string().map_err(|e| unreachable(&self.server, e))?;
        decode_envelope(status, &text)
    }

    /// Executes a mutating op, or automatically runs its protocol `dry_run` preview op when `--dry-run` is set.
    pub fn mutate<O: Op>(&self, command: &str, input: &O::Input, format: impl FnOnce(&O::Result) -> String) -> Done {
        if self.dry_run {
            let Some(preview_op) = vibevalley_protocol::endpoint(O::NAME).and_then(|e| e.dry_run) else {
                return Err(no_dry_run(command));
            };
            let payload = serde_json::to_value(input).unwrap_or(Value::Null);
            let raw = self.ask_raw(preview_op, &payload)?;
            let preview: Preview = serde_json::from_value(raw).map_err(decode_failure)?;
            self.output.show(&preview, |p| p.does.join("\n"));
            return Ok(());
        }
        let result = self.ask::<O>(input)?;
        self.output.show(&result, format);
        Ok(())
    }

    /// Downloads raw bytes from a `GET` endpoint (e.g. `/api/v1/attachment/{id}`).
    pub fn get_bytes(&self, path: &str) -> Result<(Vec<u8>, Option<String>), Failure> {
        let url = self.url(path);
        let mut response = self.http.get(&url).call().map_err(|e| unreachable(&self.server, e))?;
        let status = response.status().as_u16();
        let content_type = response.headers().get("content-type").and_then(|v| v.to_str().ok()).map(ToString::to_string);
        if status >= 300 {
            let text = response.body_mut().read_to_string().unwrap_or_default();
            return Err(failure_of(status, &text));
        }
        let bytes = response
            .body_mut()
            .with_config()
            .limit(512 * 1024 * 1024)
            .read_to_vec()
            .map_err(|e| unreachable(&self.server, e))?;
        Ok((bytes, content_type))
    }

    /// Streams binary bytes to a `PUT` endpoint and decodes its JSON `Envelope`.
    pub fn put_bytes<T: DeserializeOwned>(&self, path: &str, content_type: &str, bytes: &[u8]) -> Result<T, Failure> {
        let url = self.url(path);
        let mut response = self
            .http
            .put(&url)
            .header("content-type", content_type)
            .send(bytes)
            .map_err(|e| unreachable(&self.server, e))?;
        let status = response.status().as_u16();
        let text = response.body_mut().read_to_string().map_err(|e| unreachable(&self.server, e))?;
        let data = decode_envelope(status, &text)?;
        serde_json::from_value(data).map_err(decode_failure)
    }

    /// Reads server-sent events from `path`, calling `on` with each event's `data` payload until `on` returns `Ok(false)` or `timeout` elapses.
    pub fn sse(&self, path: &str, timeout: Option<Duration>, mut on: impl FnMut(&str) -> Result<bool, Failure>) -> Done {
        let url = self.url(path);
        let (tx, rx) = std::sync::mpsc::channel::<Result<String, Failure>>();
        let server = self.server.clone();
        std::thread::spawn(move || {
            let response = ureq::Agent::config_builder()
                .http_status_as_error(false)
                .timeout_connect(Some(Duration::from_secs(5)))
                .build()
                .new_agent()
                .get(&url)
                .header("accept", "text/event-stream")
                .call();
            let mut response = match response {
                Ok(r) => r,
                Err(e) => return drop(tx.send(Err(unreachable(&server, e)))),
            };
            let status = response.status().as_u16();
            if status != 200 {
                let text = response.body_mut().read_to_string().unwrap_or_default();
                return drop(tx.send(Err(failure_of(status, &text))));
            }
            let mut data = String::new();
            for line in BufReader::new(response.into_body().into_reader()).lines() {
                let Ok(line) = line else {
                    return drop(tx.send(Err(unreachable(&server, "stream ended"))));
                };
                if let Some(chunk) = line.strip_prefix("data:") {
                    if !data.is_empty() {
                        data.push('\n');
                    }
                    data.push_str(chunk.trim_start());
                } else if line.is_empty() && !data.is_empty() && tx.send(Ok(std::mem::take(&mut data))).is_err() {
                    return;
                }
            }
            let _ = tx.send(Err(unreachable(&server, "stream ended")));
        });

        let deadline = timeout.map(|d| std::time::Instant::now() + d);
        loop {
            let next = match deadline {
                Some(until) => rx.recv_timeout(until.saturating_duration_since(std::time::Instant::now())).map_err(|_| ()),
                None => rx.recv().map_err(|_| ()),
            };
            match next {
                Ok(Ok(payload)) => {
                    if !on(&payload)? {
                        return Ok(());
                    }
                }
                Ok(Err(failure)) => return Err(failure),
                Err(()) => return Err(Failure::new(exit::OTHER, "Timeout", "timed out waiting for server event")),
            }
        }
    }
}

fn decode_envelope(status: u16, text: &str) -> Result<Value, Failure> {
    match serde_json::from_str::<Envelope>(text) {
        Ok(env) if env.biz_code == 0 && status < 300 => Ok(env.data.unwrap_or(Value::Null)),
        _ => Err(failure_of(status, text)),
    }
}
