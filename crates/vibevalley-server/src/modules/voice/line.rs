//! The voice line (`gateway/voice/line.ts`, `modules/orchestrator/openai.ts`):
//! a listener of its own on 127.0.0.1 with one route, an OpenAI-shaped
//! `POST /llm/<id>/chat/completions` that the orchestrator answers, each
//! call under a key of its own. Agora's cloud reaches it through a tunnel
//! (cloudflared, or the address the server was started with); the farm's
//! main port is never what a tunnel shows.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use vibevalley_i18n::t;

use super::agora::{CallLine, ORCHESTRATOR_MODEL, Pause};
use crate::lock;
use crate::modules::media::vendor::{Fetch, Request};
use crate::modules::setting::Secret;

const BODY_MAX: usize = 1024 * 1024;
const HEAD_MAX: usize = 64 * 1024;

/// A tunnel's public address and how to close it.
pub struct Tunnel {
    pub url: String,
    pub close: Box<dyn FnOnce() + Send>,
}

/// Opens a tunnel to the port; why it cannot, in the user's words.
pub type OpenTunnel = Arc<dyn Fn(u16) -> Result<Tunnel, String> + Send + Sync>;

/// One turn's words: each piece goes to `say` as it is said; false when
/// nothing answered.
pub type Answer = Arc<dyn Fn(&str, &mut dyn FnMut(String)) -> bool + Send + Sync>;

#[derive(Deserialize)]
struct Part {
    #[serde(rename = "type")]
    kind: Option<String>,
    text: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Content {
    Text(String),
    Parts(Vec<Part>),
}

#[derive(Deserialize)]
struct Message {
    role: Option<String>,
    content: Option<Content>,
}

#[derive(Deserialize)]
struct ChatRequest {
    model: Option<String>,
    stream: Option<bool>,
    messages: Option<Vec<Message>>,
}

/// `newestUserText`: content is a string or parts, of which only the text ones count.
fn newest_user_text(request: &ChatRequest) -> String {
    let newest = request.messages.iter().flatten().rev().find(|m| m.role.as_deref() == Some("user"));
    match newest.and_then(|m| m.content.as_ref()) {
        Some(Content::Text(s)) => s.trim().to_string(),
        Some(Content::Parts(parts)) => parts
            .iter()
            .filter(|p| p.kind.as_deref() == Some("text"))
            .filter_map(|p| p.text.as_deref())
            .collect::<String>()
            .trim()
            .to_string(),
        None => String::new(),
    }
}

#[derive(Serialize)]
struct Delta<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<&'a str>,
}

#[derive(Serialize)]
struct ChunkChoice<'a> {
    index: u8,
    delta: Delta<'a>,
    finish_reason: Option<&'static str>,
}

#[derive(Serialize)]
struct Chunk<'a> {
    id: &'a str,
    object: &'static str,
    created: i64,
    model: &'a str,
    choices: [ChunkChoice<'a>; 1],
}

#[derive(Serialize)]
struct Whole<'a> {
    id: &'a str,
    object: &'static str,
    created: i64,
    model: &'a str,
    choices: [WholeChoice<'a>; 1],
}

#[derive(Serialize)]
struct WholeChoice<'a> {
    index: u8,
    message: WholeMessage<'a>,
    finish_reason: &'static str,
}

#[derive(Serialize)]
struct WholeMessage<'a> {
    role: &'static str,
    content: &'a str,
}

#[derive(Serialize)]
struct Refusal<'a> {
    error: RefusalError<'a>,
}

#[derive(Serialize)]
struct RefusalError<'a> {
    message: &'a str,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
}

/// `chatChunk`: `finish_reason` is null until the last chunk, whose delta is empty.
fn chunk(id: &str, created: i64, model: &str, content: &str, stop: bool, first: bool) -> String {
    let delta = if stop {
        Delta { role: None, content: None }
    } else {
        Delta {
            role: first.then_some("assistant"),
            content: Some(content),
        }
    };
    let chunk = Chunk {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [ChunkChoice {
            index: 0,
            delta,
            finish_reason: stop.then_some("stop"),
        }],
    };
    format!("data: {}\n\n", serde_json::to_string(&chunk).unwrap_or_default())
}

fn respond(stream: &mut TcpStream, status: u16, reason: &str, kind: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream
        .write_all(head.as_bytes())
        .and_then(|()| stream.write_all(body))
        .and_then(|()| stream.flush());
}

fn refuse(stream: &mut TcpStream, status: u16, reason: &str, code: Option<&'static str>, message: &str) {
    let body = serde_json::to_vec(&Refusal {
        error: RefusalError {
            message,
            kind: code.map(|_| if status >= 500 { "server_error" } else { "invalid_request_error" }),
            code,
        },
    })
    .unwrap_or_default();
    respond(stream, status, reason, "application/json", &body);
}

struct Head {
    method: String,
    path: String,
    authorization: String,
    length: usize,
}

fn read_head(reader: &mut BufReader<TcpStream>) -> Option<Head> {
    let mut read = 0;
    let mut line = String::new();
    let mut next = |line: &mut String| -> Option<()> {
        line.clear();
        read += reader.read_line(line).ok().filter(|n| *n > 0)?;
        (read <= HEAD_MAX).then_some(())
    };
    next(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next()?.to_string(), parts.next()?.to_string());
    let mut head = Head {
        method,
        path: target.split('?').next().unwrap_or("").to_string(),
        authorization: String::new(),
        length: 0,
    };
    loop {
        next(&mut line)?;
        let Some((name, value)) = line.trim_end().split_once(':') else {
            return line.trim().is_empty().then_some(head);
        };
        match name.trim().to_ascii_lowercase().as_str() {
            "authorization" => head.authorization = value.trim().to_string(),
            "content-length" => head.length = value.trim().parse().ok()?,
            _ => {}
        }
    }
}

/// The call id of `/llm/<id>/chat/completions`.
fn call_of(path: &str) -> Option<&str> {
    let id = path.strip_prefix("/llm/")?.strip_suffix("/chat/completions")?;
    (!id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')).then_some(id)
}

struct Served {
    keys: Mutex<HashMap<String, Secret>>,
    answer: Answer,
    stopped: AtomicBool,
}

fn serve(served: &Served, stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let Ok(mut out) = stream.try_clone() else { return };
    let mut reader = BufReader::new(stream);
    let Some(head) = read_head(&mut reader) else {
        return refuse(&mut out, 400, "Bad Request", None, "bad request");
    };
    // The body is read before any answer: closing on unread bytes would reset the asker's connection.
    if head.length > BODY_MAX {
        let _ = std::io::copy(&mut (&mut reader).take(BODY_MAX as u64), &mut std::io::sink());
        let why = format!("the body is {} bytes, at most {BODY_MAX}", head.length);
        return refuse(&mut out, 413, "Payload Too Large", Some("request_too_large"), &why);
    }
    let mut body = vec![0; head.length];
    if reader.read_exact(&mut body).is_err() {
        return refuse(&mut out, 400, "Bad Request", Some("invalid_json"), "the body was cut off");
    }
    let Some(call) = call_of(&head.path).filter(|_| head.method == "POST") else {
        return respond(&mut out, 404, "Not Found", "text/plain", b"");
    };
    // A call's own key on its own path; anything else is not let in.
    let key = lock(&served.keys).get(call).cloned();
    if !key.is_some_and(|k| head.authorization == format!("Bearer {}", k.expose())) {
        return refuse(&mut out, 401, "Unauthorized", None, "unauthorized");
    }
    let request: ChatRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => return refuse(&mut out, 400, "Bad Request", Some("invalid_json"), &e.to_string()),
    };
    let model = request.model.clone().unwrap_or_default();
    if model != ORCHESTRATOR_MODEL {
        return refuse(&mut out, 404, "Not Found", Some("model_not_found"), &format!("no model {model}"));
    }
    let said = newest_user_text(&request);
    let id = format!("chatcmpl-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    let created = crate::now() / 1000;
    // Words nobody could make out are answered without waking the orchestrator.
    let answer = |say: &mut dyn FnMut(String)| -> bool {
        if said.is_empty() {
            say(t("server.voice.misheard", &[]));
            return true;
        }
        (served.answer)(&said, say)
    };
    if request.stream != Some(true) {
        let mut all = String::new();
        if !answer(&mut |words| all.push_str(&words)) {
            return refuse(&mut out, 502, "Bad Gateway", Some("not_answered"), "the answer was cut off");
        }
        let whole = Whole {
            id: &id,
            object: "chat.completion",
            created,
            model: &model,
            choices: [WholeChoice {
                index: 0,
                message: WholeMessage {
                    role: "assistant",
                    content: &all,
                },
                finish_reason: "stop",
            }],
        };
        return respond(&mut out, 200, "OK", "application/json", &serde_json::to_vec(&whole).unwrap_or_default());
    }
    // The body ends with the connection: an answer that fails midway is cut off there, with no [DONE].
    if out
        .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\nconnection: close\r\n\r\n")
        .is_err()
    {
        return;
    }
    let mut first = true;
    let answered = answer(&mut |words| {
        let _ = out
            .write_all(chunk(&id, created, &model, &words, false, first).as_bytes())
            .and_then(|()| out.flush());
        first = false;
    });
    if answered {
        let _ = out.write_all(format!("{}data: [DONE]\n\n", chunk(&id, created, &model, "", true, false)).as_bytes());
    }
    let _ = out.flush();
}

/// The address the calls share: the one configured, or a tunnel's.
enum Base {
    None,
    Tunnel(Tunnel),
}

pub struct Line {
    port: u16,
    url: String,
    open_tunnel: OpenTunnel,
    served: Arc<Served>,
    /// The bound port once it listens; why it cannot.
    listening: Mutex<Option<Result<u16, String>>>,
    /// Held while a tunnel opens: one opening at a time.
    base: Mutex<Base>,
}

impl Line {
    /// Nothing listens until the first call opens its line.
    pub fn new(port: u16, url: String, open_tunnel: OpenTunnel, answer: Answer) -> Line {
        Line {
            port,
            url,
            open_tunnel,
            served: Arc::new(Served {
                keys: Mutex::default(),
                answer,
                stopped: AtomicBool::new(false),
            }),
            listening: Mutex::new(None),
            base: Mutex::new(Base::None),
        }
    }

    fn listen(&self) -> Result<u16, String> {
        let mut listening = lock(&self.listening);
        if let Some(known) = &*listening {
            return known.clone();
        }
        let bound = TcpListener::bind(("127.0.0.1", self.port))
            .and_then(|l| l.local_addr().map(|a| (l, a.port())))
            .map_err(|e| t("server.voice.lineDown", &[("why", e.to_string().into())]));
        let result = bound.map(|(listener, port)| {
            let served = self.served.clone();
            let _ = std::thread::Builder::new().name("vibevalley-voice-line".into()).spawn(move || {
                for stream in listener.incoming() {
                    if served.stopped.load(Ordering::SeqCst) {
                        return;
                    }
                    let Ok(stream) = stream else { continue };
                    let served = served.clone();
                    let _ = std::thread::Builder::new()
                        .name("vibevalley-voice-line-call".into())
                        .spawn(move || serve(&served, stream));
                }
            });
            port
        });
        *listening = Some(result.clone());
        result
    }

    /// The port it listens on, once a call opened it.
    pub fn port(&self) -> Option<u16> {
        lock(&self.listening).clone().and_then(Result::ok)
    }

    /// A call's own line; why there is none to be had.
    pub fn open(&self) -> Result<CallLine, String> {
        let closed = || t("server.voice.lineClosed", &[]);
        if self.served.stopped.load(Ordering::SeqCst) {
            return Err(closed());
        }
        let port = self.listen()?;
        let base = if self.url.is_empty() {
            let mut base = lock(&self.base);
            if let Base::None = &*base {
                *base = Base::Tunnel((self.open_tunnel)(port)?);
            }
            match &*base {
                Base::Tunnel(t) => t.url.clone(),
                Base::None => return Err(closed()),
            }
        } else {
            self.url.trim_end_matches('/').to_string()
        };
        if self.served.stopped.load(Ordering::SeqCst) {
            return Err(closed());
        }
        let id = uuid::Uuid::new_v4().simple().to_string()[..16].to_string();
        let key = Secret::new(format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()));
        lock(&self.served.keys).insert(id.clone(), key.clone());
        Ok(CallLine {
            url: format!("{base}/llm/{id}/chat/completions"),
            id,
            key,
        })
    }

    /// The call's key stops opening anything.
    pub fn close(&self, id: &str) {
        lock(&self.served.keys).remove(id);
    }

    pub fn lines(&self) -> usize {
        lock(&self.served.keys).len()
    }

    /// Every key goes, the tunnel closes and the listener stops.
    pub fn stop(&self) {
        self.served.stopped.store(true, Ordering::SeqCst);
        lock(&self.served.keys).clear();
        if let Base::Tunnel(tunnel) = std::mem::replace(&mut *lock(&self.base), Base::None) {
            (tunnel.close)();
        }
        // The accept loop reads the flag at its next connection: this is it.
        if let Some(port) = self.port() {
            let _ = TcpStream::connect(("127.0.0.1", port));
        }
    }
}

impl Drop for Line {
    fn drop(&mut self) {
        self.stop();
    }
}

/// A quick tunnel to the port: cloudflared says its address on either
/// stream, within 30 s or it is given up on.
pub fn cloudflared(port: u16) -> Result<Tunnel, String> {
    use std::process::{Command, Stdio};
    let mut child = Command::new("cloudflared")
        .args(["tunnel", "--no-autoupdate", "--url", &format!("http://127.0.0.1:{port}")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => t("server.voice.tunnel.missing", &[]),
            _ => e.to_string(),
        })?;
    let (found, address) = flume::bounded::<String>(1);
    static TUNNEL_URL: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"https://[a-z0-9-]+\.trycloudflare\.com").expect("the quick tunnel's address"));
    // Both streams are read until it exits, so it never blocks on a write.
    let read = |stream: Box<dyn Read + Send>| {
        let found = found.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                if let Some(m) = TUNNEL_URL.find(&line) {
                    let _ = found.try_send(m.as_str().to_string());
                }
            }
        });
    };
    if let Some(out) = child.stdout.take() {
        read(Box::new(out));
    }
    if let Some(err) = child.stderr.take() {
        read(Box::new(err));
    }
    drop(found);
    let child = Arc::new(Mutex::new(child));
    let kill = {
        let child = child.clone();
        move || {
            let mut child = lock(&child);
            let _ = child.kill();
            let _ = child.wait();
        }
    };
    match address.recv_timeout(Duration::from_secs(30)) {
        Ok(url) => Ok(Tunnel { url, close: Box::new(kill) }),
        Err(flume::RecvTimeoutError::Timeout) => {
            kill();
            Err(t("server.voice.tunnel.timedOut", &[]))
        }
        Err(flume::RecvTimeoutError::Disconnected) => {
            kill();
            Err(t("server.voice.tunnel.exited", &[]))
        }
    }
}

/// A new tunnel's address takes a while to answer (seen: about 25 s): asked
/// every 2 s for a minute at most, the line refusing a keyless request
/// counts as an answer.
pub fn tunnel_answers(fetch: &dyn Fetch, url: &str, pause: &Pause) -> bool {
    for asked in 0..30 {
        if asked > 0 {
            pause(Duration::from_secs(2));
        }
        let answered = fetch.fetch(Request {
            method: "POST",
            url: format!("{url}/llm/ready/chat/completions"),
            headers: vec![],
            body: None,
            timeout: Duration::from_secs(5),
        });
        if answered.is_ok_and(|r| r.status == 401) {
            return true;
        }
    }
    false
}

/// cloudflared, waited for until its address answers; a call goes on even if it does not yet.
pub fn quick_tunnel(fetch: Arc<dyn Fetch>, pause: Pause) -> OpenTunnel {
    Arc::new(move |port| {
        let tunnel = cloudflared(port)?;
        tunnel_answers(&*fetch, &tunnel.url, &pause);
        Ok(tunnel)
    })
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::modules::media::vendor::{FetchError, Response};

    fn line(answer: Answer) -> Line {
        Line::new(
            0,
            String::new(),
            Arc::new(|port| {
                Ok(Tunnel {
                    url: format!("http://127.0.0.1:{port}"),
                    close: Box::new(|| {}),
                })
            }),
            answer,
        )
    }

    /// A request over the loopback, as the tunnel would bring it: (status, body).
    fn post(url: &str, key: &str, body: &str) -> (u16, String) {
        let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();
        let mut answered = agent.post(url).header("authorization", &format!("Bearer {key}")).send(body).unwrap();
        (answered.status().as_u16(), answered.body_mut().read_to_string().unwrap())
    }

    #[test]
    fn a_calls_line_answers_only_with_its_key_and_only_the_orchestrators_model() {
        vibevalley_i18n::set_locale("zh");
        let line = line(Arc::new(|text, say| {
            say(format!("听到了：{text}"));
            say("这就去办。".into());
            true
        }));
        let call = line.open().unwrap();
        let other = line.open().unwrap();
        assert_eq!(line.lines(), 2);
        let ask = |messages: Value, stream: bool| json!({ "model": ORCHESTRATOR_MODEL, "stream": stream, "messages": messages }).to_string();
        let user = json!([{ "role": "system", "content": "persona" }, { "role": "user", "content": [{ "type": "text", "text": " 开工 " }] }]);

        assert_eq!(post(&call.url, "wrong", &ask(user.clone(), false)).0, 401);
        assert_eq!(post(&call.url, other.key.expose(), &ask(user.clone(), false)).0, 401);
        assert_eq!(post(&call.url.replace("/llm/", "/api/"), call.key.expose(), "{}").0, 404);
        assert_eq!(post(&call.url, call.key.expose(), "not json").0, 400);
        let (status, body) = post(&call.url, call.key.expose(), r#"{"model":"gpt-x","messages":[]}"#);
        assert!(status == 404 && body.contains("model_not_found"), "{body}");

        let (status, body) = post(&call.url, call.key.expose(), &ask(user.clone(), false));
        let whole: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(status, 200);
        assert_eq!(
            whole["choices"][0]["message"],
            json!({ "role": "assistant", "content": "听到了：开工这就去办。" })
        );

        let (_, body) = post(&call.url, call.key.expose(), &ask(user, true));
        let frames: Vec<&str> = body.split("\n\n").filter(|f| !f.is_empty()).collect();
        assert_eq!(frames.len(), 4, "{body}");
        let first: Value = serde_json::from_str(frames[0].strip_prefix("data: ").unwrap()).unwrap();
        assert_eq!(
            first["choices"][0],
            json!({ "index": 0, "delta": { "role": "assistant", "content": "听到了：开工" }, "finish_reason": null })
        );
        let last: Value = serde_json::from_str(frames[2].strip_prefix("data: ").unwrap()).unwrap();
        assert_eq!(last["choices"][0], json!({ "index": 0, "delta": {}, "finish_reason": "stop" }));
        assert_eq!(frames[3], "data: [DONE]");

        let (_, body) = post(&call.url, call.key.expose(), &ask(json!([{ "role": "assistant", "content": "hi" }]), false));
        assert!(body.contains("我没听清"), "{body}");

        line.close(&call.id);
        assert_eq!(post(&call.url, call.key.expose(), "{}").0, 401);
        assert_eq!(line.lines(), 1);
        line.stop();
        assert_eq!(line.lines(), 0);
        assert_eq!(line.open().unwrap_err(), "语音线路已经关闭");
    }

    #[test]
    fn an_answer_that_never_came_is_a_502_and_a_tunnel_that_cannot_open_says_why() {
        vibevalley_i18n::set_locale("zh");
        let silent = line(Arc::new(|_, _| false));
        let call = silent.open().unwrap();
        let body = json!({ "model": ORCHESTRATOR_MODEL, "messages": [{ "role": "user", "content": "在吗" }] }).to_string();
        assert_eq!(post(&call.url, call.key.expose(), &body).0, 502);

        let no_tunnel = Line::new(0, String::new(), Arc::new(|_| Err("没有 cloudflared".into())), Arc::new(|_, _| true));
        assert_eq!(no_tunnel.open().unwrap_err(), "没有 cloudflared");
        let own = Line::new(0, "https://line.example.com/".into(), Arc::new(|_| Err("unused".into())), Arc::new(|_, _| true));
        assert!(own.open().unwrap().url.starts_with("https://line.example.com/llm/"));
    }

    #[test]
    fn a_new_tunnel_is_asked_every_2_s_until_it_refuses_a_keyless_request() {
        let waits = Arc::new(Mutex::new(0u64));
        let w = waits.clone();
        let pause: Pause = Arc::new(move |d| *w.lock().unwrap() += d.as_secs());
        let asked = Mutex::new(0);
        let late = move |r: Request| -> Result<Response, FetchError> {
            assert_eq!(r.url, "https://line.example/llm/ready/chat/completions");
            let mut n = asked.lock().unwrap();
            *n += 1;
            Ok(Response {
                status: if *n < 3 { 502 } else { 401 },
                headers: vec![],
                body: Box::new(std::io::empty()),
            })
        };
        assert!(tunnel_answers(&late, "https://line.example", &pause));
        assert_eq!(*waits.lock().unwrap(), 4);
        *waits.lock().unwrap() = 0;
        let never = |_: Request| -> Result<Response, FetchError> { Err(FetchError::Network("down".into())) };
        assert!(!tunnel_answers(&never, "https://line.example", &pause));
        assert_eq!(*waits.lock().unwrap(), 58);
    }
}
