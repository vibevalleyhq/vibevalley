//! MOSS answered offline for the page's tests (`apps/server/src/testing/network.ts`):
//! audio, files and understanding by the same markers and test keys, and the
//! public download that serves what they made. Only `VIBEVALLEY_TEST_RUNTIMES=1`
//! uses it.

use std::collections::HashMap;
use std::io::Read;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::modules::infra::http::{Fetch, FetchError, Request, Response};

const MOSS: &str = "https://api.mosi.cn/v1";

struct Asset {
    bytes: Vec<u8>,
    kind: String,
    fail_once: bool,
}

struct File {
    purpose: String,
    fail_once: bool,
}

#[derive(Default)]
struct State {
    assets: HashMap<String, Asset>,
    files: HashMap<String, File>,
    tasks: HashMap<String, Value>,
    cloned: HashMap<String, Vec<Value>>,
    next: usize,
}

struct OfflineVendor(Arc<Mutex<State>>);

impl Fetch for OfflineVendor {
    fn fetch(&self, request: Request) -> Result<Response, FetchError> {
        answer(&self.0, request, None)
    }

    fn fetch_with_cancel(&self, request: Request, cancel: CancellationToken) -> Result<Response, FetchError> {
        answer(&self.0, request, Some(cancel))
    }
}

struct OfflineDownload(Arc<Mutex<State>>);

impl Fetch for OfflineDownload {
    fn fetch(&self, request: Request) -> Result<Response, FetchError> {
        serve(&self.0, request)
    }

    fn fetch_with_cancel(&self, request: Request, cancel: CancellationToken) -> Result<Response, FetchError> {
        if cancel.is_cancelled() {
            return Err(FetchError::Network("cancelled".into()));
        }
        serve(&self.0, request)
    }
}

/// The vendor and the public download, sharing what was made.
pub fn network() -> (Arc<dyn Fetch>, Arc<dyn Fetch>) {
    let state = Arc::new(Mutex::new(State::default()));
    (Arc::new(OfflineVendor(state.clone())), Arc::new(OfflineDownload(state)))
}

fn json_response(status: u16, v: &Value) -> Result<Response, FetchError> {
    Ok(Response {
        status,
        headers: vec![("content-type".into(), "application/json".into())],
        body: Box::new(std::io::Cursor::new(v.to_string().into_bytes())),
    })
}

fn empty(status: u16) -> Result<Response, FetchError> {
    Ok(Response {
        status,
        headers: vec![],
        body: Box::new(std::io::empty()),
    })
}

/// An answer that never comes: the request waits out its timeout unless cancelled.
fn never(r: &Request, cancel: Option<CancellationToken>) -> Result<Response, FetchError> {
    match cancel {
        Some(token) => vibevalley_runtime::rt::block_on(async {
            tokio::select! {
                biased;
                _ = token.cancelled() => Err(FetchError::Network("cancelled".into())),
                _ = tokio::time::sleep(r.timeout) => Err(FetchError::Timeout),
            }
        }),
        None => {
            std::thread::sleep(r.timeout);
            Err(FetchError::Timeout)
        }
    }
}

/// `wav()`: a 440 Hz tone, 24 kHz mono 16-bit.
pub fn wav(samples: usize) -> Vec<u8> {
    let rate: u32 = 24000;
    let mut b = Vec::with_capacity(44 + samples * 2);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&((36 + samples * 2) as u32).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&rate.to_le_bytes());
    b.extend_from_slice(&(rate * 2).to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&((samples * 2) as u32).to_le_bytes());
    for i in 0..samples {
        let v = ((i as f64 * 2.0 * std::f64::consts::PI * 440.0 / rate as f64).sin() * 4096.0).round() as i16;
        b.extend_from_slice(&v.to_le_bytes());
    }
    b
}

/// `mp3`: a 120 ms 440 Hz tone, libmp3lame 24 kHz / 32 kbps, no metadata.
pub fn mp3() -> Vec<u8> {
    const B64: &str = concat!(
        "//NExAASeGp8P1gYAAu2SWgM7Z2w9d6p1juO8BfwznNJzOUxhLRopsTh+XyykpKSkpKTAEwfB8H31AhwfP5QMSnKB/h739Hv6Pf/DAPn6wICGgH+U9/QQQggwggAAACN",
        "//NExAkU6T6EV5toAMWe3U+6YWpHbFQwWnhgwNKjvisyUMLbPb18+BNQWkJ7+O4YYYYm/45RwmQ9h7f+Yl0umReL3/5iXS6kkZI/wVEQVBX/lgqCoiPArQBRZ4CofaHp",
        "//NExAgR+Fo0d94AAHluUfS1pgUhBGD0L0YGwTZg1hmHNmvYZegZJg8g+GB2BoYH4DAMAFQCpqtKfqe5/V+z9//Rpos//+n/2f6vR9IWSAZXhhragAJAEwMBow9IE3pv",
        "//NExBMS0FocTO/0QJMjgFMCBB8TR+FyMwpUEHPxMNObMUGLNoqKncuHLeGNq10abP777vTp0Wf61Kq0FPs7Dvv/06NiKiZKAIFuKZgEALBwAUYBAAcGA6AcxgmQFcYP",
        "//NExBoXGFogT18QAKA7BghQQUYceF2mXtsAhiCwn4YbEDPGBjAQwAAbTAcQDswB8AZIgANbaG7E57G+r29nu9VWj/9/XVT1/9p7/X6tHRX0TcFCwCL4MFAleBQ2ARRX",
        "//NExBAVslKYAZRQAEorosf4BAGwWP8CuIsbhef+LBIIsfk//4sDwkFsfk//+PB4YPx+ePP//zDB+eeSGGE////555IYCYfBAB//+HwQAYfBABh9EkAD9QCBdLA1EcTs",
        "//NExAwVWqp8C5RoALXgADQBiLcK4B1Ar34xQtIXkd3+I0MMTRhR6/+ZD2JYxHqa//mQ9jY6XTVX/+XnWXUKS///6Kql5kjMUv///5kuYpJGSKJikkZKTEFNRTQuMKqq",
    );
    base64::engine::general_purpose::STANDARD.decode(B64).unwrap_or_default()
}

/// A body of SSE frames; `hold` keeps it open after them until the request times out.
struct Frames {
    frames: std::collections::VecDeque<(Duration, Vec<u8>)>,
    current: std::io::Cursor<Vec<u8>>,
    hold_until: Option<Instant>,
}

impl Read for Frames {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            let n = self.current.read(buf)?;
            if n > 0 {
                return Ok(n);
            }
            match self.frames.pop_front() {
                Some((wait, bytes)) => {
                    std::thread::sleep(wait);
                    self.current = std::io::Cursor::new(bytes);
                }
                None => match self.hold_until {
                    Some(until) if Instant::now() < until => std::thread::sleep(Duration::from_millis(50)),
                    Some(_) => return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "held")),
                    None => return Ok(0),
                },
            }
        }
    }
}

fn frame(v: Value) -> Vec<u8> {
    format!("data: {v}\n\n").into_bytes()
}

fn stream(frames: Vec<(Duration, Value)>, hold: Option<Duration>) -> Result<Response, FetchError> {
    Ok(Response {
        status: 200,
        headers: vec![("content-type".into(), "text/event-stream".into())],
        body: Box::new(Frames {
            frames: frames.into_iter().map(|(w, v)| (w, frame(v))).collect(),
            current: std::io::Cursor::new(vec![]),
            hold_until: hold.map(|h| Instant::now() + h),
        }),
    })
}

/// The fields of a multipart body: name, file name, bytes.
fn multipart(kind: &str, body: &[u8]) -> Vec<(String, Option<String>, Vec<u8>)> {
    let Some(boundary) = kind.split("boundary=").nth(1) else { return vec![] };
    let marker = format!("--{boundary}").into_bytes();
    let mut out = vec![];
    let mut at = 0;
    let find = |hay: &[u8], needle: &[u8], from: usize| hay[from..].windows(needle.len()).position(|w| w == needle).map(|p| p + from);
    while let Some(start) = find(body, &marker, at) {
        let from = start + marker.len();
        let Some(next) = find(body, &marker, from) else { break };
        let part = &body[from..next];
        at = next;
        let Some(split) = find(part, b"\r\n\r\n", 0) else { continue };
        let head = String::from_utf8_lossy(&part[..split]).to_string();
        let mut data = part[split + 4..].to_vec();
        if data.ends_with(b"\r\n") {
            data.truncate(data.len() - 2);
        }
        let attr = |key: &str| head.split(&format!("{key}=\"")).nth(1).and_then(|r| r.split('"').next()).map(String::from);
        if let Some(name) = attr("name") {
            out.push((name, attr("filename"), data));
        }
    }
    out
}

fn answer(state: &Mutex<State>, r: Request, cancel: Option<CancellationToken>) -> Result<Response, FetchError> {
    let (path, query) = match r.url.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (r.url.clone(), String::new()),
    };
    let auth = r
        .headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("authorization"))
        .map(|(_, v)| v.clone())
        .unwrap_or_default();
    let (kind, body) = match r.body {
        Some((ref kind, _)) => (kind.clone(), Vec::new()),
        None => (String::new(), Vec::new()),
    };
    let body = match r.body {
        Some((_, mut b)) => {
            let mut v = body;
            let _ = b.read_to_end(&mut v);
            v
        }
        None => body,
    };
    let req = Request {
        method: r.method,
        url: r.url.clone(),
        headers: r.headers.clone(),
        body: None,
        timeout: r.timeout,
    };
    let form = kind.starts_with("multipart/form-data");
    let input: Value = if form {
        Value::Null
    } else {
        serde_json::from_slice(&body).unwrap_or(Value::Null)
    };
    let next = |s: &mut State| {
        s.next += 1;
        s.next
    };

    if path == format!("{MOSS}/images/generations") && r.method == "POST" && !form {
        let prompt = input["prompt"].as_str().unwrap_or("");
        if prompt.contains("[media:hold]") {
            return never(&req, cancel);
        }
        if prompt.contains("[media:unknown]") {
            return empty(503);
        }
        let size = input["size"].as_str().unwrap_or("");
        let Some((w, h)) = size.split_once('x') else { return empty(400) };
        let (Ok(width), Ok(height)) = (w.parse::<u32>(), h.parse::<u32>()) else {
            return empty(400);
        };
        let mut s = state.lock();
        let n = next(&mut s);
        let url = format!("https://media.example.com/{n}-{width}x{height}.png");
        s.assets.insert(
            url.clone(),
            Asset {
                bytes: crate::testing::png(width, height),
                kind: "image/png".into(),
                fail_once: prompt.contains("[media:download-failure]"),
            },
        );
        return json_response(
            200,
            &json!({
                "created": 1,
                "data": [{ "url": url }],
                "usage": { "generated_images": 1, "output_width": width, "output_height": height }
            }),
        );
    }
    if path == format!("{MOSS}/audio/voices") && r.method == "GET" {
        let last = query.contains("after");
        let account = if auth == "Bearer test-voice-second" { "second" } else { "first" };
        let speech = auth == "Bearer test-speech-a" || auth == "Bearer test-speech-b" || auth.starts_with("Bearer test-audio");
        let id = if speech {
            (if last { "voice-two" } else { "voice-one" }).to_string()
        } else {
            format!("voice-{account}{}", if last { "-last" } else { "" })
        };
        let mut data = vec![json!({ "id": id, "object": "audio.voice", "name": "Offline voice", "created_at": 1 })];
        if !last {
            data.extend(state.lock().cloned.get(&auth).cloned().unwrap_or_default());
        }
        let last_id = data.last().map(|d| d["id"].clone()).unwrap_or(Value::Null);
        return json_response(
            200,
            &json!({ "object": "list", "data": data, "first_id": id, "last_id": last_id, "has_more": !last, "next_cursor": if last { Value::Null } else { json!("next-voice") } }),
        );
    }
    if path == format!("{MOSS}/audio/voices") && r.method == "POST" && form {
        let parts = multipart(&kind, &body);
        let sample = parts.iter().find(|p| p.0 == "audio_sample" && p.1.is_some());
        if sample.is_none_or(|p| p.2.is_empty() || p.2.len() > 10_000_000) {
            return empty(400);
        }
        let name = parts
            .iter()
            .find(|p| p.0 == "name")
            .map(|p| String::from_utf8_lossy(&p.2).to_string())
            .unwrap_or_default();
        if name.contains("[clone:hold]") {
            return never(&req, cancel);
        }
        if name.contains("[clone:unknown]") {
            return empty(503);
        }
        if name.contains("[clone:rejected]") {
            return empty(422);
        }
        let mut s = state.lock();
        let n = next(&mut s);
        let voice = json!({ "id": format!("voice-cloned-{n}"), "object": "audio.voice", "name": name, "created_at": 1 });
        s.cloned.entry(auth).or_default().push(voice.clone());
        return json_response(200, &voice);
    }
    if let Some(id) = path.strip_prefix(&format!("{MOSS}/audio/tasks/"))
        && r.method == "GET"
    {
        let mut s = state.lock();
        let Some(task) = s.tasks.get(id).filter(|t| t["account"] == auth.as_str()) else {
            return json_response(404, &json!({ "error": { "code": "task_not_found" } }));
        };
        let mut out = task.clone();
        // A task marked pending is still at work the first time it is asked about.
        if let Some(left) = s
            .tasks
            .get_mut(id)
            .and_then(|t| t.get_mut("pending"))
            .filter(|p| p.as_i64().is_some_and(|n| n > 0))
        {
            *left = json!(left.as_i64().unwrap_or(1) - 1);
            out["status"] = json!("PROCESSING");
        }
        if let Some(o) = out.as_object_mut() {
            o.remove("pending");
            o.remove("account");
            o.insert("id".into(), json!(id));
            o.insert("created_at".into(), json!(1));
            o.insert("updated_at".into(), json!(2));
        }
        return json_response(200, &out);
    }
    // Dictation: one recording as a form, answered whole.
    if path == format!("{MOSS}/audio/transcriptions") && r.method == "POST" && form {
        return json_response(200, &json!({ "text": "Synthetic dictation." }));
    }
    // A keyed plain request to the realtime address: the key is let in, the socket is not opened.
    if path == format!("{MOSS}/realtime") && r.method == "GET" {
        return empty(if auth == "Bearer test-live-refused" { 401 } else { 426 });
    }
    if path == format!("{MOSS}/audio/transcriptions") && r.method == "POST" && !form {
        let file = input["file_id"].as_str().unwrap_or("");
        let mut s = state.lock();
        if s.files.get(file).is_none_or(|f| f.purpose != "audio") {
            return empty(400);
        }
        let id = format!("transcription-{}", next(&mut s));
        if input["stream"] == json!(true) {
            let model = input["model"].clone();
            let mut frames = vec![
                (
                    Duration::ZERO,
                    json!({ "type": "task.created", "task_id": id, "object": "audio.transcription", "status": "PROCESSING", "model": model }),
                ),
                (Duration::ZERO, json!({ "type": "transcript.text.delta", "delta": "First synthetic speaker." })),
                (
                    Duration::ZERO,
                    json!({ "type": "transcript.segment.done", "content_index": 0, "speaker": "speaker_0", "start": 0, "end": 1.4, "text": "First synthetic speaker." }),
                ),
            ];
            if auth == "Bearer test-audio-stream-hold" {
                return stream(frames, Some(r.timeout));
            }
            if auth == "Bearer test-audio-stream-truncated" {
                return stream(frames, None);
            }
            frames.extend([
                (Duration::from_millis(1500), json!({ "type": "transcript.text.delta", "delta": " Second synthetic speaker." })),
                (
                    Duration::ZERO,
                    json!({ "type": "transcript.segment.done", "content_index": 1, "speaker": "speaker_1", "start": 1.5, "end": 3, "text": "Second synthetic speaker." }),
                ),
                (
                    Duration::ZERO,
                    json!({ "type": "transcript.text.done", "text": "First synthetic speaker. Second synthetic speaker.", "usage": { "type": "duration", "prompt_tokens": 12, "completion_tokens": 9, "total_tokens": 21, "input_audio_seconds": 4 } }),
                ),
            ]);
            return stream(frames, None);
        }
        s.tasks.insert(
            id.clone(),
            json!({
                "account": auth, "object": "audio.transcription",
                "pending": if auth == "Bearer test-audio-pending" { 1 } else { 0 },
                "status": if auth == "Bearer test-audio-failure" { "FAILED" } else { "SUCCESS" },
                "text": "First synthetic speaker. Second synthetic speaker.",
                "segments": [
                    { "speaker": "speaker_0", "text": "First synthetic speaker.", "start": 0, "end": 1.4 },
                    { "speaker": "speaker_1", "text": "Second synthetic speaker.", "start": 1.5, "end": 3 }
                ]
            }),
        );
        return json_response(200, &json!({ "task_id": id }));
    }
    let speakers = path == format!("{MOSS}/audio/speech/speakers");
    if (speakers || path == format!("{MOSS}/audio/voice/generations")) && r.method == "POST" && !form {
        let text = if speakers {
            input["segments"]
                .as_array()
                .map(|a| a.iter().filter_map(|s| s["text"].as_str()).collect::<Vec<_>>().join(" "))
                .unwrap_or_default()
        } else {
            input["input"].as_str().unwrap_or("").to_string()
        };
        if text.contains("[audio:hold]") {
            return never(&req, cancel);
        }
        if text.contains("[audio:unknown]") {
            return empty(503);
        }
        let large = text.contains("[audio:large]");
        let format = if !large && input["response_format"] == "mp3" { "mp3" } else { "wav" };
        let kind = if format == "mp3" { "audio/mpeg" } else { "audio/wav" };
        let mut s = state.lock();
        let id = format!("audio-{}", next(&mut s));
        let url = format!("https://media.example.com/{id}.{format}");
        let bytes = if large {
            wav((26 * 1024 * 1024 - 44) / 2)
        } else if format == "mp3" {
            mp3()
        } else {
            wav(2880)
        };
        s.assets.insert(
            url.clone(),
            Asset {
                bytes,
                kind: kind.into(),
                fail_once: text.contains("[audio:download-failure]"),
            },
        );
        s.tasks.insert(
            id.clone(),
            json!({ "account": auth, "object": if speakers { "audio.speech" } else { "audio.voice_generation" }, "pending": if text.contains("[audio:pending]") { 1 } else { 0 }, "status": "SUCCESS", "url": url, "response_format": format, "content_type": kind }),
        );
        return json_response(200, &json!({ "task_id": id }));
    }
    if path == format!("{MOSS}/audio/speech") && r.method == "POST" && !form {
        let text = input["input"].as_str().unwrap_or("").to_string();
        if text.contains("[speech:hold]") {
            return never(&req, cancel);
        }
        if text.contains("[speech:unknown]") {
            return empty(503);
        }
        if input["stream"] == json!(true) {
            let id = format!("stream-{}", next(&mut state.lock()));
            let mono = &wav(2880)[44..];
            let mut stereo = Vec::with_capacity(mono.len() * 2);
            for pair in mono.as_chunks::<2>().0 {
                let v = i16::from_le_bytes(*pair);
                stereo.extend_from_slice(&v.to_le_bytes());
                stereo.extend_from_slice(&v.wrapping_neg().to_le_bytes());
            }
            let chunk = base64::engine::general_purpose::STANDARD.encode(&stereo);
            let hold = text.contains("[speech:stream-hold]");
            let truncated = text.contains("[speech:stream-truncated]");
            let n = if hold {
                1
            } else if truncated {
                10
            } else {
                60
            };
            let mut frames = vec![
                (
                    Duration::ZERO,
                    json!({ "type": "task.created", "task_id": id, "object": "audio.speech", "status": "PROCESSING", "model": "moss-tts-1.5-flash" }),
                ),
                (
                    Duration::ZERO,
                    json!({ "type": "speech.created", "format": "pcm", "sample_rate": 24000, "channels": 2, "bit_depth": 16 }),
                ),
            ];
            for _ in 0..n {
                frames.push((Duration::from_millis(30), json!({ "type": "speech.audio.delta", "audio": chunk })));
            }
            if hold {
                return stream(frames, Some(r.timeout));
            }
            if !truncated {
                let chars = text.encode_utf16().count();
                frames.push((
                    Duration::ZERO,
                    json!({ "type": "speech.audio.done", "usage": { "input_characters": chars, "prompt_tokens": 5, "completion_tokens": n, "total_tokens": 5 + n }, "meta_info": { "performance": { "audio_duration_s": n as f64 * 0.12 } } }),
                ));
            }
            return stream(frames, None);
        }
        let large = text.contains("[speech:large]");
        let fails = text.contains("[speech:download-failure]");
        let asked = input["response_format"].as_str().unwrap_or("");
        if input["async"] == json!(true) {
            let format = if !large && asked == "mp3" { "mp3" } else { "wav" };
            let kind = if format == "mp3" { "audio/mpeg" } else { "audio/wav" };
            let mut s = state.lock();
            let id = format!("speech-{}", next(&mut s));
            let url = format!("https://media.example.com/{id}.{format}");
            let bytes = if large {
                wav((26 * 1024 * 1024 - 44) / 2)
            } else if format == "mp3" {
                mp3()
            } else {
                wav(2880)
            };
            s.assets.insert(
                url.clone(),
                Asset {
                    bytes,
                    kind: kind.into(),
                    fail_once: fails,
                },
            );
            s.tasks.insert(
                id.clone(),
                json!({ "account": auth, "object": "audio.speech", "status": "SUCCESS", "url": url, "response_format": format, "content_type": kind }),
            );
            return json_response(200, &json!({ "task_id": id }));
        }
        if asked != "wav" && asked != "mp3" {
            return empty(400);
        }
        let format = if large { "wav" } else { asked };
        let kind = if format == "wav" { "audio/wav" } else { "audio/mpeg" };
        let mut s = state.lock();
        let n = next(&mut s);
        let url = format!("https://media.example.com/{n}.{format}");
        let bytes = if large {
            wav((26 * 1024 * 1024 - 44) / 2)
        } else if format == "wav" {
            wav(2880)
        } else {
            mp3()
        };
        s.assets.insert(
            url.clone(),
            Asset {
                bytes,
                kind: kind.into(),
                fail_once: fails,
            },
        );
        return json_response(
            200,
            &json!({ "id": format!("speech-{n}"), "object": "audio.speech", "status": "SUCCESS", "created_at": 1, "url": url, "response_format": format, "content_type": kind }),
        );
    }
    if path == format!("{MOSS}/files") && r.method == "POST" && form {
        let parts = multipart(&kind, &body);
        let file = parts.iter().find(|p| p.0 == "file" && p.1.is_some());
        let purpose = parts.iter().find(|p| p.0 == "purpose").map(|p| String::from_utf8_lossy(&p.2).to_string());
        let (Some(file), Some(purpose)) = (file, purpose) else { return empty(400) };
        let mut s = state.lock();
        let id = format!("file-{}", next(&mut s));
        s.files.insert(
            id.clone(),
            File {
                purpose: purpose.clone(),
                fail_once: auth == "Bearer test-audio-cleanup-failure",
            },
        );
        return json_response(
            200,
            &json!({ "id": id, "object": "file", "bytes": file.2.len(), "created_at": 1, "filename": file.1, "purpose": purpose, "status": "processed" }),
        );
    }
    if let Some(id) = path.strip_prefix(&format!("{MOSS}/files/"))
        && r.method == "DELETE"
    {
        let mut s = state.lock();
        let Some(file) = s.files.get_mut(id) else { return empty(404) };
        if file.fail_once {
            file.fail_once = false;
            return empty(503);
        }
        s.files.remove(id);
        return json_response(200, &json!({ "id": id, "object": "file", "deleted": true }));
    }
    if path == format!("{MOSS}/responses") && r.method == "POST" && !form {
        let content: Vec<Value> = input["input"]
            .as_array()
            .map(|a| a.iter().flat_map(|i| i["content"].as_array().cloned().unwrap_or_default()).collect())
            .unwrap_or_default();
        let text = content
            .iter()
            .filter(|p| p["type"] == "input_text")
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let media: Vec<&Value> = content.iter().filter(|p| p["type"] != "input_text").collect();
        let mut s = state.lock();
        if media.iter().any(|p| {
            let want = if p["type"] == "input_image" { "image" } else { "video" };
            s.files.get(p["file_id"].as_str().unwrap_or("")).is_none_or(|f| f.purpose != want)
        }) {
            return empty(400);
        }
        if text.contains("[understanding:hold]") {
            drop(s);
            return never(&req, cancel);
        }
        if text.contains("[understanding:unknown]") {
            return empty(503);
        }
        if text.contains("[understanding:cleanup-failure]") {
            for p in &media {
                if let Some(f) = s.files.get_mut(p["file_id"].as_str().unwrap_or("")) {
                    f.fail_once = true;
                }
            }
        }
        let incomplete = text.contains("[understanding:incomplete]");
        let video = media.iter().any(|p| p["type"] == "input_video");
        let n = next(&mut s);
        return json_response(
            200,
            &json!({
                "id": format!("response-{n}"), "model": input["model"],
                "status": if incomplete { "incomplete" } else { "completed" },
                "incomplete_details": if incomplete { json!({ "reason": "max_output_tokens" }) } else { Value::Null },
                "output": [{ "content": [{ "type": "output_text", "text": format!("Offline understanding of {} input.", if video { "video" } else { "image" }) }] }],
                "usage": { "input_tokens": 30, "output_tokens": 8, "total_tokens": 38 }
            }),
        );
    }
    Err(FetchError::Network(format!("the offline network has no {} {}", r.method, path)))
}

/// The public download: what the vendor made, in 64 KiB pieces; a first
/// failure once when it was asked for.
fn serve(state: &Mutex<State>, r: Request) -> Result<Response, FetchError> {
    if r.headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("authorization")) {
        return Err(FetchError::Network("an asset download carried credentials".into()));
    }
    let mut s = state.lock();
    let Some(asset) = s.assets.get_mut(&r.url) else {
        return Err(FetchError::Network(format!("no asset at {}", r.url)));
    };
    if asset.fail_once {
        asset.fail_once = false;
        return empty(503);
    }
    Ok(Response {
        status: 200,
        headers: vec![
            ("content-type".into(), asset.kind.clone()),
            ("content-length".into(), asset.bytes.len().to_string()),
        ],
        body: Box::new(std::io::Cursor::new(asset.bytes.clone())),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multipart_fields_read_back() {
        let body = b"--b\r\ncontent-disposition: form-data; name=\"purpose\"\r\n\r\naudio\r\n--b\r\ncontent-disposition: form-data; name=\"file\"; filename=\"a.wav\"\r\ncontent-type: audio/wav\r\n\r\nRIFF\r\n--b--\r\n";
        let parts = multipart("multipart/form-data; boundary=b", body);
        assert_eq!(parts.len(), 2);
        assert_eq!((parts[0].0.as_str(), parts[0].2.as_slice()), ("purpose", &b"audio"[..]));
        assert_eq!((parts[1].1.as_deref(), parts[1].2.as_slice()), (Some("a.wav"), &b"RIFF"[..]));
    }

    #[test]
    fn a_wav_is_well_formed() {
        let w = wav(2880);
        assert_eq!(&w[..4], b"RIFF");
        assert_eq!(w.len(), 44 + 2880 * 2);
        assert!(!mp3().is_empty());
    }
}
