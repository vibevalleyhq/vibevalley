//! Pooled HTTP client, target/auth resolution, typed protocol RPC (`ask`/`mutate`), SSE streaming, and structured CLI errors.

use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use vibevalley_protocol::{ApiErrorKind, BizCode, Envelope, Health, Next, Op, Preview, SliceKind, ops};

use crate::auth::{self, AuthConfig, Secret, normalize_server_url_lossy, same_server};
use crate::output::Output;
pub use vibevalley_cli::{Done, Failure, exit, no_dry_run};

pub fn decode_failure(e: impl std::fmt::Display) -> Failure {
    Failure::new(exit::OTHER, "Server", e.to_string())
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
        let (code, tag) = match status {
            404 => (exit::MISSING, "Missing"),
            400 => (exit::USAGE, "InvalidInput"),
            401 => (exit::REFUSED, "Unauthorized"),
            403 => (exit::REFUSED, "Forbidden"),
            _ => (exit::OTHER, "Server"),
        };
        let mut failure = Failure::new(code, tag, text.trim());
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

const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;

fn is_loopback_server(server: &str) -> bool {
    let rest = server.strip_prefix("http://").or_else(|| server.strip_prefix("https://")).unwrap_or(server);
    let authority = rest.split('/').next().unwrap_or("");
    let host = if let Some(bracketed) = authority.strip_prefix('[') {
        bracketed.split(']').next().unwrap_or("")
    } else {
        authority.split(':').next().unwrap_or("")
    };
    host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

fn build_http_client(server: &str) -> reqwest::blocking::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut builder = reqwest::blocking::Client::builder().connect_timeout(Duration::from_secs(5));
    if is_loopback_server(server) {
        builder = builder.no_proxy();
    }
    builder.build().expect("reqwest blocking CLI client")
}

/// Origin of the active server base URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerSource {
    Flag,
    Env,
    AuthFile,
    ServerJson,
    DefaultPort,
}

impl ServerSource {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Flag => "flag",
            Self::Env => "env",
            Self::AuthFile => "auth.json",
            Self::ServerJson => "server.json",
            Self::DefaultPort => "default",
        }
    }
}

/// Origin of the active Bearer token (when present).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenSource {
    Flag,
    Env,
    AuthFile,
    None,
}

impl TokenSource {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Flag => "flag",
            Self::Env => "env",
            Self::AuthFile => "auth.json",
            Self::None => "none",
        }
    }
}

/// Result of resolving base URL and Bearer token from CLI flags, env vars, `auth.json`, and `server.json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedTarget {
    pub server: String,
    pub server_source: ServerSource,
    pub token: Option<Secret>,
    pub token_source: TokenSource,
}

fn non_empty_string(raw: Option<String>) -> Option<String> {
    raw.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn non_empty_secret(raw: Option<Secret>) -> Option<Secret> {
    raw.and_then(|s| s.trimmed())
}

/// Resolves target server URL and Bearer token according to precedence rules:
/// - Server: `--server` > `VIBEVALLEY_SERVER` > `auth.json` > `server.json` > default port.
/// - Token: `--token` > `VIBEVALLEY_REMOTE_TOKEN` > `auth.json` (only when targeting the same normalized server).
pub fn resolve_target(
    flag_server: Option<String>,
    env_server: Option<String>,
    flag_token: Option<Secret>,
    env_token: Option<Secret>,
    stored_auth: Option<&AuthConfig>,
    announced_server: Option<String>,
    fallback: String,
) -> ResolvedTarget {
    let flag_server = non_empty_string(flag_server);
    let env_server = non_empty_string(env_server);
    let announced_server = non_empty_string(announced_server);

    let (server, server_source) = if let Some(s) = flag_server {
        (normalize_server_url_lossy(&s), ServerSource::Flag)
    } else if let Some(s) = env_server {
        (normalize_server_url_lossy(&s), ServerSource::Env)
    } else if let Some(cfg) = stored_auth.filter(|c| !c.server.trim().is_empty()) {
        (normalize_server_url_lossy(&cfg.server), ServerSource::AuthFile)
    } else if let Some(s) = announced_server {
        (normalize_server_url_lossy(&s), ServerSource::ServerJson)
    } else {
        (normalize_server_url_lossy(&fallback), ServerSource::DefaultPort)
    };

    let (token, token_source) = if let Some(tok) = non_empty_secret(flag_token) {
        (Some(tok), TokenSource::Flag)
    } else if let Some(tok) = non_empty_secret(env_token) {
        (Some(tok), TokenSource::Env)
    } else if let Some(cfg) = stored_auth
        && let Some(tok) = cfg.token.trimmed()
        && (server_source == ServerSource::AuthFile || same_server(&server, &cfg.server))
    {
        (Some(tok), TokenSource::AuthFile)
    } else {
        (None, TokenSource::None)
    };

    ResolvedTarget {
        server,
        server_source,
        token,
        token_source,
    }
}

fn attach_headers(req: reqwest::blocking::RequestBuilder, token: Option<&Secret>) -> reqwest::blocking::RequestBuilder {
    let req = req.header("x-vibevalley-client", "cli");
    match token.filter(|t| !t.is_empty()) {
        Some(secret) => req.header("authorization", format!("Bearer {}", secret.expose())),
        None => req,
    }
}

/// Pooled HTTP client shared across a single CLI invocation.
pub struct Client {
    pub home: PathBuf,
    pub server: String,
    pub server_source: ServerSource,
    pub token_source: TokenSource,
    pub dry_run: bool,
    pub output: Output,
    token: Option<Secret>,
    explicit_server: Option<String>,
    flag_token: Option<Secret>,
    env_token: Option<Secret>,
    stored_auth: Option<AuthConfig>,
    http: reqwest::blocking::Client,
}

impl Client {
    pub fn new(server: Option<String>, token: Option<Secret>, dry_run: bool, json: bool) -> Self {
        let home = vibevalley_protocol::home::home();
        let env_server = std::env::var("VIBEVALLEY_SERVER").ok();
        let env_token = std::env::var("VIBEVALLEY_REMOTE_TOKEN").ok().map(Secret::new);
        let stored_auth = auth::load(&home).ok().flatten();
        let announced = vibevalley_protocol::home::announced(&home);
        Self::from_parts(home, server, env_server, token, env_token, stored_auth, announced, dry_run, json)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn from_parts(
        home: PathBuf,
        flag_server: Option<String>,
        env_server: Option<String>,
        flag_token: Option<Secret>,
        env_token: Option<Secret>,
        stored_auth: Option<AuthConfig>,
        announced_server: Option<String>,
        dry_run: bool,
        json: bool,
    ) -> Self {
        let explicit_server = non_empty_string(flag_server.clone()).or_else(|| non_empty_string(env_server.clone()));
        let flag_token_clean = non_empty_secret(flag_token);
        let env_token_clean = non_empty_secret(env_token);
        let resolved = resolve_target(
            flag_server,
            env_server,
            flag_token_clean.clone(),
            env_token_clean.clone(),
            stored_auth.as_ref(),
            announced_server,
            fallback_server(),
        );
        let http = build_http_client(&resolved.server);
        Self {
            home,
            server: resolved.server,
            server_source: resolved.server_source,
            token_source: resolved.token_source,
            dry_run,
            output: Output { json },
            token: resolved.token,
            explicit_server,
            flag_token: flag_token_clean,
            env_token: env_token_clean,
            stored_auth,
            http,
        }
    }

    /// Creates a derived client aimed at an explicit server URL and optional Bearer token
    /// (used by `auth login` and `auth logout --revoke` to avoid leaking unrelated credentials).
    pub fn for_target(&self, server: String, token: Option<Secret>) -> Self {
        let server = normalize_server_url_lossy(&server);
        let token = non_empty_secret(token);
        let token_source = if token.is_some() { TokenSource::Flag } else { TokenSource::None };
        let http = build_http_client(&server);
        Self {
            home: self.home.clone(),
            server,
            server_source: ServerSource::Flag,
            token_source,
            dry_run: self.dry_run,
            output: self.output,
            token,
            explicit_server: None,
            flag_token: None,
            env_token: None,
            stored_auth: None,
            http,
        }
    }

    pub fn token(&self) -> Option<&Secret> {
        self.token.as_ref()
    }

    pub fn explicit_server(&self) -> Option<&str> {
        self.explicit_server.as_deref()
    }

    pub fn flag_token(&self) -> Option<&Secret> {
        self.flag_token.as_ref()
    }

    pub fn env_token(&self) -> Option<&Secret> {
        self.env_token.as_ref()
    }

    pub fn stored_auth(&self) -> Option<&AuthConfig> {
        self.stored_auth.as_ref()
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

    /// Calls an op by name with an explicit JSON payload over `POST /api/v1/<op>`.
    pub fn ask_raw(&self, op: &str, body: &Value) -> Result<Value, Failure> {
        let url = self.url(&format!("/api/v1/{}", op.replace('.', "/")));
        let body = if body.is_null() { json!({}) } else { body.clone() };
        let response = attach_headers(self.http.post(&url).header("content-type", "application/json"), self.token.as_ref())
            .body(body.to_string())
            .send()
            .map_err(|e| unreachable(&self.server, e))?;
        let status = response.status().as_u16();
        let text = response.text().map_err(|e| unreachable(&self.server, e))?;
        decode_envelope(status, &text)
    }

    /// Probes `/api/v1/health` first (accepting either raw `Health` JSON or a protocol `Envelope`),
    /// falling back to `POST /api/v1/server/health/get` when a server does not expose `GET /api/v1/health`.
    pub fn probe_health(&self) -> Result<Health, Failure> {
        let url = self.url("/api/v1/health");
        let response = attach_headers(self.http.get(&url).header("accept", "application/json"), self.token.as_ref())
            .send()
            .map_err(|e| unreachable(&self.server, e))?;
        let status = response.status().as_u16();
        let text = response.text().map_err(|e| unreachable(&self.server, e))?;
        if matches!(status, 404 | 405) {
            return self.ask::<ops::ServerHealthGet>(&());
        }
        if status >= 300 {
            return Err(failure_of(status, &text));
        }
        if let Ok(env) = serde_json::from_str::<Envelope>(&text) {
            if env.biz_code == 0 {
                if let Some(data) = env.data
                    && let Ok(health) = serde_json::from_value::<Health>(data)
                {
                    return Ok(health);
                }
                return Ok(Health {
                    ok: true,
                    version: String::new(),
                });
            }
            return Err(failure_of(status, &text));
        }
        if let Ok(health) = serde_json::from_str::<Health>(&text) {
            return Ok(health);
        }
        if let Ok(val) = serde_json::from_str::<Value>(&text) {
            let ok = val.get("ok").and_then(Value::as_bool).unwrap_or(true);
            let version = val.get("version").and_then(Value::as_str).unwrap_or_default().to_string();
            return Ok(Health { ok, version });
        }
        Err(decode_failure("invalid health response"))
    }

    /// Fetches raw JSON from a `GET` endpoint (e.g. `/api/v1/slice/<name>?once=1`).
    pub fn get_json<T: DeserializeOwned>(&self, path: &str) -> Result<T, Failure> {
        let url = self.url(path);
        let response = attach_headers(self.http.get(&url).header("accept", "application/json"), self.token.as_ref())
            .send()
            .map_err(|e| unreachable(&self.server, e))?;
        let status = response.status().as_u16();
        let text = response.text().map_err(|e| unreachable(&self.server, e))?;
        if status >= 300 {
            return Err(failure_of(status, &text));
        }
        serde_json::from_str(&text).map_err(decode_failure)
    }

    /// Fetches a single typed slice snapshot via `GET /api/v1/slice/<name>?once=1`.
    pub fn slice<T: DeserializeOwned>(&self, kind: SliceKind) -> Result<T, Failure> {
        self.get_json(&format!("/api/v1/slice/{}?once=1", kind.as_str()))
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
        let response = attach_headers(self.http.get(&url), self.token.as_ref())
            .send()
            .map_err(|e| unreachable(&self.server, e))?;
        let status = response.status().as_u16();
        let content_type = response.headers().get("content-type").and_then(|v| v.to_str().ok()).map(ToString::to_string);
        if status >= 300 {
            let text = response.text().unwrap_or_default();
            return Err(failure_of(status, &text));
        }
        let mut bytes = Vec::new();
        response
            .take(MAX_DOWNLOAD_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| unreachable(&self.server, e))?;
        if bytes.len() as u64 > MAX_DOWNLOAD_BYTES {
            return Err(unreachable(&self.server, "response body exceeded 512 MiB limit"));
        }
        Ok((bytes, content_type))
    }

    /// Streams binary bytes to a `PUT` endpoint and decodes its JSON `Envelope`.
    pub fn put_bytes<T: DeserializeOwned>(&self, path: &str, content_type: &str, bytes: &[u8]) -> Result<T, Failure> {
        let url = self.url(path);
        let response = attach_headers(self.http.put(&url).header("content-type", content_type), self.token.as_ref())
            .body(bytes.to_vec())
            .send()
            .map_err(|e| unreachable(&self.server, e))?;
        let status = response.status().as_u16();
        let text = response.text().map_err(|e| unreachable(&self.server, e))?;
        let data = decode_envelope(status, &text)?;
        serde_json::from_value(data).map_err(decode_failure)
    }

    /// Reads server-sent events from `path`, calling `on` with each event's `data` payload until `on` returns `Ok(false)` or `timeout` elapses.
    pub fn sse(&self, path: &str, timeout: Option<Duration>, mut on: impl FnMut(&str) -> Result<bool, Failure>) -> Done {
        let url = self.url(path);
        let (tx, rx) = std::sync::mpsc::channel::<Result<String, Failure>>();
        let server = self.server.clone();
        let http = self.http.clone();
        let token = self.token.clone();
        std::thread::spawn(move || {
            let response = attach_headers(http.get(&url).header("accept", "text/event-stream"), token.as_ref()).send();
            let response = match response {
                Ok(r) => r,
                Err(e) => return drop(tx.send(Err(unreachable(&server, e)))),
            };
            let status = response.status().as_u16();
            if status != 200 {
                let text = response.text().unwrap_or_default();
                return drop(tx.send(Err(failure_of(status, &text))));
            }
            let mut data = String::new();
            for line in BufReader::new(response).lines() {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_auth() -> AuthConfig {
        AuthConfig {
            server: "http://100.64.0.5:8890".into(),
            token: Secret::new("vv_dev_stored_token_123456"),
            device_id: "dev_1".into(),
            device_name: "laptop".into(),
            server_name: Some("Mac Studio".into()),
            scope: Some("remote:default".into()),
        }
    }

    #[test]
    fn detects_loopback_servers_for_no_proxy() {
        assert!(is_loopback_server("http://127.0.0.1:8790"));
        assert!(is_loopback_server("http://127.0.0.1:8790/"));
        assert!(is_loopback_server("http://localhost:8790"));
        assert!(is_loopback_server("http://LOCALHOST:8790"));
        assert!(is_loopback_server("http://[::1]:8790"));
        assert!(!is_loopback_server("https://api.example.com"));
        assert!(!is_loopback_server("http://192.168.1.5:8790"));
    }

    #[test]
    fn target_resolution_precedence_and_token_isolation() {
        let auth = sample_auth();
        let fallback = "http://127.0.0.1:8790".to_string();

        // 1. Default: auth.json beats server.json and attaches stored token.
        let r = resolve_target(None, None, None, None, Some(&auth), Some("http://127.0.0.1:8791".into()), fallback.clone());
        assert_eq!(r.server, "http://100.64.0.5:8890");
        assert_eq!(r.server_source, ServerSource::AuthFile);
        assert_eq!(r.token.as_ref().map(Secret::expose), Some("vv_dev_stored_token_123456"));
        assert_eq!(r.token_source, TokenSource::AuthFile);

        // 2. Without auth.json: server.json beats default fallback, no token.
        let r = resolve_target(None, None, None, None, None, Some("http://127.0.0.1:8791".into()), fallback.clone());
        assert_eq!(r.server, "http://127.0.0.1:8791");
        assert_eq!(r.server_source, ServerSource::ServerJson);
        assert_eq!(r.token, None);
        assert_eq!(r.token_source, TokenSource::None);

        // 3. --server matching normalized auth.json server keeps stored token.
        let r = resolve_target(Some("HTTP://100.64.0.5:8890/".into()), None, None, None, Some(&auth), None, fallback.clone());
        assert_eq!(r.server, "http://100.64.0.5:8890");
        assert_eq!(r.server_source, ServerSource::Flag);
        assert_eq!(r.token.as_ref().map(Secret::expose), Some("vv_dev_stored_token_123456"));
        assert_eq!(r.token_source, TokenSource::AuthFile);

        // 4. --server differing from auth.json NEVER leaks stored token!
        let r = resolve_target(Some("http://127.0.0.1:8790".into()), None, None, None, Some(&auth), None, fallback.clone());
        assert_eq!(r.server, "http://127.0.0.1:8790");
        assert_eq!(r.server_source, ServerSource::Flag);
        assert_eq!(r.token, None);
        assert_eq!(r.token_source, TokenSource::None);

        // 5. VIBEVALLEY_SERVER differing from auth.json NEVER leaks stored token either!
        let r = resolve_target(None, Some("https://100.64.0.5:8890".into()), None, None, Some(&auth), None, fallback.clone());
        assert_eq!(r.server, "https://100.64.0.5:8890");
        assert_eq!(r.server_source, ServerSource::Env);
        assert_eq!(r.token, None);
        assert_eq!(r.token_source, TokenSource::None);

        // 6. --token > VIBEVALLEY_REMOTE_TOKEN > auth.json; explicit token attaches even to a different --server.
        let r = resolve_target(
            Some("http://other.host:8890".into()),
            Some("http://env.host:8890".into()),
            Some(Secret::new("vv_dev_flag_tok")),
            Some(Secret::new("vv_dev_env_tok")),
            Some(&auth),
            None,
            fallback.clone(),
        );
        assert_eq!(r.server, "http://other.host:8890");
        assert_eq!(r.server_source, ServerSource::Flag);
        assert_eq!(r.token.as_ref().map(Secret::expose), Some("vv_dev_flag_tok"));
        assert_eq!(r.token_source, TokenSource::Flag);

        let r = resolve_target(
            Some("http://other.host:8890".into()),
            None,
            None,
            Some(Secret::new("vv_dev_env_tok")),
            Some(&auth),
            None,
            fallback,
        );
        assert_eq!(r.token.as_ref().map(Secret::expose), Some("vv_dev_env_tok"));
        assert_eq!(r.token_source, TokenSource::Env);
    }

    fn spawn_mock(router: axum::Router) -> (std::net::SocketAddr, tokio_util::sync::CancellationToken, tokio_util::sync::DropGuard) {
        vibevalley_runtime::rt::block_on(async move {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let cancel = tokio_util::sync::CancellationToken::new();
            let guard = cancel.clone().drop_guard();
            let shutdown = cancel.clone();
            tokio::spawn(async move {
                let _ = axum::serve(listener, router).with_graceful_shutdown(shutdown.cancelled_owned()).await;
            });
            (addr, cancel, guard)
        })
    }

    #[test]
    fn sse_streams_multiline_events_and_enforces_timeout_with_bearer_header() {
        use axum::http::HeaderMap;
        use axum::response::sse::{Event, Sse};
        use axum::routing::get;

        let (auth_tx, auth_rx) = std::sync::mpsc::channel::<Option<String>>();
        let stream_cancel = tokio_util::sync::CancellationToken::new();
        let stream_cancel_for_route = stream_cancel.clone();
        let router = axum::Router::new().route(
            "/events",
            get(move |headers: HeaderMap| {
                let auth = headers.get("authorization").and_then(|v| v.to_str().ok()).map(ToString::to_string);
                let _ = auth_tx.send(auth);
                let cancel = stream_cancel_for_route.clone();
                let stream = futures_util::stream::unfold((true, cancel), |(first, cancel)| async move {
                    if first {
                        Some((Ok::<_, std::convert::Infallible>(Event::default().data("line-1\nline-2")), (false, cancel)))
                    } else {
                        cancel.cancelled().await;
                        None
                    }
                });
                async move { Sse::new(stream) }
            }),
        );
        let (addr, _cancel, _guard) = spawn_mock(router);
        let _stream_guard = stream_cancel.drop_guard();

        let client = Client::from_parts(
            PathBuf::from("/tmp"),
            Some(format!("http://{addr}")),
            None,
            Some(Secret::new("vv_dev_sse_token_1234")),
            None,
            None,
            None,
            false,
            false,
        );
        let mut seen = Vec::new();
        let err = client
            .sse("/events", Some(Duration::from_millis(120)), |payload| {
                seen.push(payload.to_string());
                Ok(true)
            })
            .unwrap_err();
        let captured_auth = auth_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(
            captured_auth.as_deref(),
            Some("Bearer vv_dev_sse_token_1234"),
            "SSE request missing Bearer header"
        );
        assert_eq!(seen, vec!["line-1\nline-2"]);
        assert_eq!((err.code, err.tag.as_str()), (exit::OTHER, "Timeout"));
    }

    #[test]
    fn api_download_and_upload_attach_bearer_header() {
        use axum::http::{HeaderMap, StatusCode, Uri, header};

        let (req_tx, req_rx) = std::sync::mpsc::channel::<Option<String>>();
        let router = axum::Router::new().fallback(move |uri: Uri, headers: HeaderMap| {
            let req_tx = req_tx.clone();
            async move {
                let auth = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).map(ToString::to_string);
                let _ = req_tx.send(auth);
                let (content_type, body) = match uri.path() {
                    "/api/v1/server/health/get" => ("application/json", r#"{"bizCode":0,"message":"ok","data":{"ok":true}}"#),
                    "/api/v1/health" => ("application/json", r#"{"ok":true}"#),
                    "/api/v1/attachment/att-1" => ("application/octet-stream", "hello"),
                    _ => ("application/json", r#"{"bizCode":0,"message":"ok","data":{"ok":true}}"#),
                };
                (StatusCode::OK, [(header::CONTENT_TYPE, content_type)], body)
            }
        });
        let (addr, _cancel, _guard) = spawn_mock(router);

        let client = Client::from_parts(
            PathBuf::from("/tmp"),
            Some(format!("http://{addr}")),
            None,
            Some(Secret::new("vv_dev_all_paths_token")),
            None,
            None,
            None,
            false,
            false,
        );

        let _ = client.ask_raw("server.health.get", &json!({})).unwrap();
        let _: Value = client.get_json("/api/v1/health").unwrap();
        let (bytes, _) = client.get_bytes("/api/v1/attachment/att-1").unwrap();
        assert_eq!(bytes, b"hello");
        let _: Value = client
            .put_bytes("/api/v1/media/input/in-1/content", "application/octet-stream", b"abc")
            .unwrap();

        for i in 0..4 {
            let auth = req_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            assert_eq!(auth.as_deref(), Some("Bearer vv_dev_all_paths_token"), "request #{i} missing Bearer header");
        }
    }
}
