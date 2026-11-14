//! What every command stands on: the run's flags, a typed question to the
//! server (`ask`), a change that `--dry-run` previews (`change`), the
//! state's server-sent events, and how a run fails.

use std::io::{BufRead, BufReader, Write};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiErrorKind, BizCode, Envelope, Next, Op, Preview};

/// Exit codes a script can branch on.
pub mod exit {
    pub const OK: i32 = 0;
    /// The server failed, or something else unexpected.
    pub const OTHER: i32 = 1;
    /// The command was written wrong: an unknown flag, a missing argument, a body its endpoint does not take.
    pub const USAGE: i32 = 2;
    pub const REFUSED: i32 = 3;
    pub const MISSING: i32 = 4;
    /// No server to talk to.
    pub const UNREACHABLE: i32 = 5;
}

/// A command that did not go through, printed as one JSON line on stderr.
#[derive(Debug, Clone)]
pub struct Failure {
    pub code: i32,
    /// The server's kind (`Refused`, `Missing`…), the parser's (`MissingArgument`…), or `Unreachable`, `Server`, `Timeout`…
    pub tag: String,
    pub text: String,
    pub biz_code: Option<u32>,
    pub status: Option<u16>,
    pub next: Vec<Next>,
}

impl Failure {
    pub fn new(code: i32, tag: &str, text: impl Into<String>) -> Failure {
        Failure {
            code,
            tag: tag.into(),
            text: text.into(),
            biz_code: None,
            status: None,
            next: vec![],
        }
    }

    pub fn usage(tag: &str, text: impl Into<String>) -> Failure {
        Failure::new(exit::USAGE, tag, text)
    }

    pub fn print(&self) {
        let mut error = json!({ "tag": self.tag, "message": self.text });
        if let Some(b) = self.biz_code {
            error["bizCode"] = json!(b);
        }
        if let Some(s) = self.status {
            error["status"] = json!(s);
        }
        if !self.next.is_empty() {
            error["next"] = json!(self.next);
        }
        eprintln!("{}", json!({ "error": error }));
    }
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
    let mut f = Failure::new(
        exit::UNREACHABLE,
        "Unreachable",
        t("cli.failure.unreachable", &[("base", base.into()), ("why", why.to_string().into())]),
    );
    f.next = vec![Next {
        say: t("cli.next.startServer", &[]),
        run: None,
    }];
    f
}

/// What the server answered, as a failure: by its envelope when it sent one, else by the status.
fn failure_of(status: u16, text: &str) -> Failure {
    let envelope = serde_json::from_str::<Envelope>(text)
        .ok()
        .and_then(|e| BizCode::from_code(e.biz_code).map(|b| (e, b)));
    let Some((e, biz)) = envelope else {
        let code = match status {
            404 => exit::MISSING,
            400 => exit::USAGE,
            _ => exit::OTHER,
        };
        let mut f = Failure::new(code, "Server", text.trim());
        f.status = Some(status);
        return f;
    };
    let kind = biz.meta().kind;
    Failure {
        code: code_of(kind),
        tag: kind_name(kind).into(),
        text: e.message,
        biz_code: Some(e.biz_code),
        status: Some(status),
        next: e.error.and_then(|d| d.next).unwrap_or_default(),
    }
}

/// How the run answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Text,
    Json,
}

/// What a command runs with: the global flags.
pub struct Ctx {
    /// `--server`, else `VIBEVALLEY_SERVER`, else the one using this machine's home, else the default port.
    pub server: String,
    pub dry_run: bool,
    pub format: Format,
}

pub const FALLBACK_SERVER: &str = "http://127.0.0.1:8787";

/// The server when none is named: the one using this machine's home, else the default port.
pub fn default_server() -> String {
    vibevalley_home::announced(&vibevalley_home::home()).unwrap_or_else(|| FALLBACK_SERVER.into())
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(5)))
        .build()
        .into()
}

impl Ctx {
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.server.trim_end_matches('/'))
    }

    /// One endpoint asked, typed by its op.
    pub fn ask<O: Op>(&self, input: &O::Input) -> Result<O::Result, Failure> {
        self.ask_raw(O::NAME, &serde_json::to_value(input).unwrap_or(Value::Null))
            .and_then(|v| serde_json::from_value(v).map_err(|e| Failure::new(exit::OTHER, "Server", e.to_string())))
    }

    fn ask_raw(&self, op: &str, body: &Value) -> Result<Value, Failure> {
        let url = self.url(&format!("/api/v1/{}", op.replace('.', "/")));
        let body = if body.is_null() { json!({}) } else { body.clone() };
        let mut response = agent()
            .post(&url)
            .header("content-type", "application/json")
            .send(body.to_string())
            .map_err(|e| unreachable(&self.server, e))?;
        let status = response.status().as_u16();
        let text = response.body_mut().read_to_string().map_err(|e| unreachable(&self.server, e))?;
        match serde_json::from_str::<Envelope>(&text) {
            Ok(e) if e.biz_code == 0 && status < 300 => Ok(e.data.unwrap_or(Value::Null)),
            _ => Err(failure_of(status, &text)),
        }
    }

    /// A value: in the protocol's shape with `--format json`, else as words.
    pub fn show<T: Serialize>(&self, value: &T, text: impl FnOnce(&T) -> String) {
        match self.format {
            Format::Json => println!("{}", serde_json::to_string(value).unwrap_or_else(|_| "null".into())),
            Format::Text => {
                let words = text(value);
                if !words.is_empty() {
                    println!("{words}");
                }
            }
        }
    }

    /// A change: with `--dry-run` what it would do (its preview op), else done and said.
    pub fn change<O: Op>(&self, name: &str, preview: Option<&str>, input: &O::Input, said: impl FnOnce(&O::Result) -> String) -> Result<(), Failure> {
        if self.dry_run {
            let Some(op) = preview else {
                return Err(no_dry_run(name));
            };
            let p: Preview = serde_json::from_value(self.ask_raw(op, &serde_json::to_value(input).unwrap_or(Value::Null))?)
                .map_err(|e| Failure::new(exit::OTHER, "Server", e.to_string()))?;
            self.show(&p, |p| p.does.join("\n"));
            return Ok(());
        }
        let done = self.ask::<O>(input)?;
        self.show(&done, said);
        Ok(())
    }

    /// A server-sent stream's events' data, each to `on` until it says stop (false) or `timeout` passes.
    pub fn events(&self, path: &str, timeout: Option<Duration>, mut on: impl FnMut(&str) -> Result<bool, Failure>) -> Result<(), Failure> {
        let url = self.url(path);
        let (tx, rx) = std::sync::mpsc::channel::<Result<String, Failure>>();
        let server = self.server.clone();
        std::thread::spawn(move || {
            let response = ureq::Agent::config_builder()
                .http_status_as_error(false)
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
                    return drop(tx.send(Err(unreachable(&server, "the stream ended"))));
                };
                if let Some(d) = line.strip_prefix("data:") {
                    data.push_str(d.trim_start());
                } else if line.is_empty() && !data.is_empty() && tx.send(Ok(std::mem::take(&mut data))).is_err() {
                    return;
                }
            }
            let _ = tx.send(Err(unreachable(&server, "the stream ended")));
        });
        let until = timeout.map(|d| std::time::Instant::now() + d);
        loop {
            let got = match until {
                Some(at) => rx.recv_timeout(at.saturating_duration_since(std::time::Instant::now())).map_err(|_| ()),
                None => rx.recv().map_err(|_| ()),
            };
            match got {
                Ok(Ok(data)) => {
                    if !on(&data)? {
                        return Ok(());
                    }
                }
                Ok(Err(f)) => return Err(f),
                Err(_) => return Err(Failure::new(exit::OTHER, "Timeout", "")),
            }
        }
    }
}

/// `#12` or `12`: the issue's number as the server takes it.
pub fn issue_ref(said: &str) -> String {
    said.trim_start_matches('#').to_string()
}

pub fn no_dry_run(name: &str) -> Failure {
    Failure::usage("NoDryRun", t("cli.failure.noDryRun", &[("command", name.into())]))
}

/// Percent-encodes one URL path segment.
pub fn url_segment(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for b in raw.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// What stdin holds, or nothing when it cannot be read.
pub fn stdin_text() -> String {
    let mut s = String::new();
    let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut s);
    s
}

/// One line on stdout, written as it is.
pub fn out(text: &str) {
    let mut o = std::io::stdout();
    let _ = writeln!(o, "{text}");
}

/// One whitespace-collapsed line of text.
pub fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Parts joined by two spaces, the empty ones left out.
pub fn line(parts: &[&str]) -> String {
    parts.iter().filter(|p| !p.is_empty()).copied().collect::<Vec<_>>().join("  ")
}

pub fn decode_failure(e: impl std::fmt::Display) -> Failure {
    Failure::new(exit::OTHER, "Server", e.to_string())
}

pub type Done = Result<(), Failure>;
