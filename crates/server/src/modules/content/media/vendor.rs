//! The vendor calls media makes (VibeValley `platform/provider/provider.ts`'s
//! `mossCalls` and `packages/provider/src/moss/*`): every request goes out
//! through a [`Fetch`], so a test answers as MOSS does; the real one is
//! `reqwest`, never following a redirect (it would carry the key).

use std::io::Read;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use vibevalley_protocol::{
    JsNumber, MediaAudioSegment, MediaAudioVoice, MediaInputKind, MediaSpeakersRequestSegments, MediaSpeakersRequestSpeakers, MediaUnderstandingResult,
    MediaUnderstandingResultIncompleteReason, MediaUnderstandingResultUsage, MediaUnderstandingStatus,
};

use super::Stop;
use crate::modules::infra::http::{Fetch, FetchError, ReadError, Request, Response, read_max_until};
use crate::modules::infra::provider::{IMAGE_MODELS, MOSS, SPEAKERS_MODELS, SPEECH_MODELS, TRANSCRIPTION_MODELS, UNDERSTANDING_MODELS, VOICE_DESIGN_MODELS};

/// `MossErrorFields`: what failed, and whether the call may have taken effect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    Credentials,
    InvalidInput,
    Network,
    Timeout,
    HttpStatus,
    InvalidResponse,
    TooLarge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    NotSubmitted,
    Rejected,
    Unknown,
}

#[derive(Debug, Clone)]
pub struct VendorError {
    pub reason: Reason,
    pub outcome: Outcome,
    pub status: Option<u16>,
    pub code: Option<String>,
}

impl VendorError {
    pub fn new(reason: Reason, outcome: Outcome) -> VendorError {
        VendorError {
            reason,
            outcome,
            status: None,
            code: None,
        }
    }

    /// `outcomeOf`: nothing sent counts as refused.
    pub fn unknown(&self) -> bool {
        self.outcome == Outcome::Unknown
    }

    /// Network, timeout, 429 and 5xx (`AudioFailure.retryable`).
    pub fn retryable(&self) -> bool {
        matches!(self.reason, Reason::Network | Reason::Timeout) || (self.reason == Reason::HttpStatus && self.status.is_some_and(|s| s == 429 || s >= 500))
    }
}

fn invalid_input() -> VendorError {
    VendorError::new(Reason::InvalidInput, Outcome::NotSubmitted)
}

fn invalid_response() -> VendorError {
    VendorError::new(Reason::InvalidResponse, Outcome::Unknown)
}

const REJECTED: [u16; 6] = [400, 401, 403, 413, 422, 429];

/// `badKey`.
fn bad_key(key: &str) -> bool {
    key.trim().is_empty() || key.chars().any(char::is_whitespace)
}

/// The account a job asks with (`Account`).
#[derive(Clone)]
pub struct Account {
    pub connection: String,
    pub revision: i64,
    pub model: String,
    pub fingerprint: String,
    pub key: String,
}

pub fn fingerprint(key: &str) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(key.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// A body read whole, at most `max` bytes; past it `TooLarge`.
pub fn read_max(body: &mut dyn Read, max: usize, stop: Option<&Stop>) -> Result<Vec<u8>, VendorError> {
    read_max_until(body, max, || stop.is_some_and(Stop::aborted)).map_err(|e| match e {
        ReadError::TooLarge => VendorError::new(Reason::TooLarge, Outcome::Unknown),
        ReadError::Aborted | ReadError::Io => VendorError::new(Reason::Network, Outcome::Unknown),
    })
}

fn code_points(s: &str, min: usize, max: usize) -> bool {
    let n = s.chars().count();
    n >= min && n <= max
}

fn text_ok(s: &str, max: usize) -> bool {
    code_points(s, 1, max) && s.chars().any(|c| !c.is_whitespace())
}

/// `AudioId`.
pub fn audio_id(s: &str) -> bool {
    (1..=256).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn https_url(s: &str, max: usize) -> bool {
    s.len() <= max && url::Url::parse(s).is_ok_and(|u| u.scheme() == "https")
}

pub fn audio_mimes(format: &str) -> &'static [&'static str] {
    match format {
        "mp3" => &["audio/mpeg", "audio/mp3"],
        "wav" => &["audio/wav", "audio/x-wav", "audio/wave"],
        "pcm" => &["audio/pcm", "audio/l16", "application/octet-stream"],
        "flac" => &["audio/flac", "audio/x-flac"],
        "aac" => &["audio/aac", "audio/aacp"],
        "opus" => &["audio/opus", "audio/ogg", "application/ogg"],
        _ => &[],
    }
}

const FORMATS: [&str; 6] = ["mp3", "wav", "pcm", "flac", "aac", "opus"];

/// `audioUsage`: MOSS's snake case to the farm's camel case.
fn usage_of(u: &Value) -> Option<Value> {
    let o = u.as_object()?;
    let mut out = serde_json::Map::new();
    for (from, to) in [
        ("input_characters", "inputCharacters"),
        ("prompt_tokens", "promptTokens"),
        ("completion_tokens", "completionTokens"),
        ("total_tokens", "totalTokens"),
        ("input_audio_seconds", "inputAudioSeconds"),
    ] {
        if let Some(v) = o.get(from).filter(|v| v.is_number()) {
            if v.as_f64().is_some_and(|f| f < 0.0) {
                return None;
            }
            out.insert(to.into(), v.clone());
        }
    }
    Some(Value::Object(out))
}

/// What a generated audio is at the vendor (`GeneratedAudio`).
#[derive(Debug, Clone)]
pub struct Generated {
    pub url: String,
    pub format: String,
    pub content_type: String,
    pub usage: Option<Value>,
}

/// What a vendor task makes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskKind {
    Speech,
    VoiceGeneration,
    Transcription,
}

/// `AudioTask`.
#[derive(Debug, Clone)]
pub enum Task {
    Waiting,
    Failed,
    Audio(TaskKind, Generated),
    Transcription {
        text: String,
        segments: Vec<MediaAudioSegment>,
        usage: Option<Value>,
    },
}

/// Whether MOSS took an uploaded file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Uploaded {
    Ready,
    Rejected,
    Unknown,
}

/// One transcript segment as MOSS says it, or nothing when it is malformed.
fn segment_of(s: &Value) -> Option<MediaAudioSegment> {
    let (start, end) = (s["start"].as_f64()?, s["end"].as_f64()?);
    let speaker = s["speaker"].as_str().filter(|p| code_points(p, 1, 256))?;
    if start < 0.0 || end < start {
        return None;
    }
    Some(MediaAudioSegment {
        speaker: speaker.into(),
        text: s["text"].as_str()?.into(),
        start: JsNumber(start),
        end: JsNumber(end),
    })
}

/// `SpeechEvent`.
#[derive(Debug, Clone)]
pub enum SpeechEvent {
    TaskCreated(String),
    Created { sample_rate: i64, channels: i64, bit_depth: i64 },
    Delta(Vec<u8>),
    Done { usage: Option<Value>, duration: Option<f64> },
}

/// `TranscriptionEvent`.
#[derive(Debug, Clone)]
pub enum TranscriptionEvent {
    TaskCreated(String),
    Delta(String),
    Segment {
        index: i64,
        segment: MediaAudioSegment,
        usage: Option<Value>,
    },
    Done {
        text: String,
        usage: Option<Value>,
    },
}

/// The vendor, reached through `fetch`.
#[derive(Clone)]
pub struct Moss {
    pub fetch: Arc<dyn Fetch>,
}

fn json_body(v: &Value) -> Option<(String, Box<dyn Read + Send>)> {
    Some(("application/json".into(), Box::new(std::io::Cursor::new(v.to_string().into_bytes()))))
}

/// One multipart part: a name, a file name (files only) and its bytes.
pub struct Part {
    pub name: String,
    pub filename: Option<String>,
    pub kind: String,
    pub bytes: Box<dyn Read + Send>,
}

fn multipart(parts: Vec<Part>) -> (String, Box<dyn Read + Send>) {
    let boundary = format!("vibevalley-{}", uuid::Uuid::new_v4().simple());
    let mut body: Box<dyn Read + Send> = Box::new(std::io::empty());
    for p in parts {
        let mut head = format!("--{boundary}\r\ncontent-disposition: form-data; name=\"{}\"", p.name);
        if let Some(f) = &p.filename {
            head.push_str(&format!("; filename=\"{}\"\r\ncontent-type: {}", f.replace('"', ""), p.kind));
        }
        head.push_str("\r\n\r\n");
        body = Box::new(body.chain(std::io::Cursor::new(head.into_bytes())).chain(p.bytes).chain(&b"\r\n"[..]));
    }
    body = Box::new(body.chain(std::io::Cursor::new(format!("--{boundary}--\r\n").into_bytes())));
    (format!("multipart/form-data; boundary={boundary}"), body)
}

impl Moss {
    fn send(
        &self,
        key: &str,
        method: &'static str,
        url: String,
        body: Option<(String, Box<dyn Read + Send>)>,
        accept: &str,
        timeout: Duration,
    ) -> Result<Response, VendorError> {
        if bad_key(key) {
            return Err(VendorError::new(Reason::Credentials, Outcome::NotSubmitted));
        }
        let headers = vec![("authorization".into(), format!("Bearer {key}")), ("accept".into(), accept.into())];
        self.fetch
            .fetch(Request {
                method,
                url,
                headers,
                body,
                timeout,
            })
            .map_err(|e| match e {
                FetchError::Timeout => VendorError::new(Reason::Timeout, Outcome::Unknown),
                FetchError::Network(_) => VendorError::new(Reason::Network, Outcome::Unknown),
            })
    }

    /// A JSON call: the parsed 2xx body, or a `HttpStatus` failure saying
    /// whether MOSS refused it (`audio` also takes a 404 for a missing voice
    /// or task as refused).
    fn call(
        &self,
        key: &str,
        method: &'static str,
        path: &str,
        body: Option<(String, Box<dyn Read + Send>)>,
        timeout: Duration,
        audio: bool,
    ) -> Result<Value, VendorError> {
        let mut r = self.send(key, method, format!("{MOSS}{path}"), body, "application/json", timeout)?;
        let raw = read_max(&mut r.body, 1 << 20, None)?;
        let parsed: Option<Value> = serde_json::from_slice(&raw).ok();
        if !(200..300).contains(&r.status) {
            let code = parsed.as_ref().and_then(|v| v["error"]["code"].as_str()).map(str::to_string);
            let missing = r.status == 404 && audio && matches!(code.as_deref(), Some("voice_not_found" | "task_not_found"));
            let outcome = if REJECTED.contains(&r.status) || missing {
                Outcome::Rejected
            } else {
                Outcome::Unknown
            };
            return Err(VendorError {
                reason: Reason::HttpStatus,
                outcome,
                status: Some(r.status),
                code,
            });
        }
        parsed.ok_or_else(invalid_response)
    }

    /// `prepareMossImage`: the wire body, or refused.
    pub fn prepare_image(model: &str, prompt: &Value, width: i64, height: i64, extra: &Value) -> Result<Value, VendorError> {
        if !IMAGE_MODELS.contains(&model) {
            return Err(invalid_input());
        }
        let dim = |d: i64| (256..=2048).contains(&d) && d % 16 == 0;
        if !dim(width) || !dim(height) || width * height > 2_097_152 {
            return Err(invalid_input());
        }
        let prompt = match prompt {
            Value::String(s) if text_ok(s, 4000) => s.clone(),
            Value::Object(o) => {
                let items = o.get("items").and_then(Value::as_array).ok_or_else(invalid_input)?;
                if items.is_empty() || items.len() > 100 || o.get("bbox_format") != Some(&json!("yxyx")) {
                    return Err(invalid_input());
                }
                for item in items {
                    let b = item["bbox"].as_array().filter(|b| b.len() == 4).ok_or_else(invalid_input)?;
                    let n: Vec<f64> = b.iter().filter_map(Value::as_f64).collect();
                    let (h, w) = (height as f64 / 2.0, width as f64 / 2.0);
                    if n.len() != 4 || n[0] >= n[2] || n[1] >= n[3] || n[0] < -h || n[2] > h || n[1] < -w || n[3] > w {
                        return Err(invalid_input());
                    }
                }
                let text = Value::Object(o.clone()).to_string();
                if text.chars().count() > 4000 {
                    return Err(invalid_input());
                }
                text
            }
            _ => return Err(invalid_input()),
        };
        if extra["steps"].as_i64().is_some_and(|s| !(1..=100).contains(&s))
            || extra["guidance"].as_f64().is_some_and(|g| !(0.0..=10.0).contains(&g))
            || extra["negativePrompt"].as_str().is_some_and(|n| n.chars().count() > 4000)
        {
            return Err(invalid_input());
        }
        let mut body = json!({
            "model": model,
            "prompt": prompt,
            "size": format!("{width}x{height}"),
            "n": 1,
            "response_format": "url",
            "prompt_enhance": extra["enhance"].as_bool().unwrap_or(false),
            "output_watermark": { "enabled": extra["watermark"].as_bool().unwrap_or(true) },
        });
        for (from, to) in [
            ("seed", "seed"),
            ("steps", "num_inference_steps"),
            ("guidance", "guidance_scale"),
            ("negativePrompt", "negative_prompt"),
        ] {
            if !extra[from].is_null() {
                body[to] = extra[from].clone();
            }
        }
        Ok(body)
    }

    /// `generateMossImage`: the signed address and usage.
    pub fn image(&self, key: &str, body: &Value, width: i64, height: i64) -> Result<(String, Value), VendorError> {
        let r = self.call(key, "POST", "/images/generations", json_body(body), Duration::from_secs(900), false)?;
        let url = r["data"][0]["url"]
            .as_str()
            .filter(|u| https_url(u, 8192) && r["data"].as_array().is_some_and(|d| d.len() == 1));
        let usage = &r["usage"];
        match url {
            Some(url) if usage["generated_images"] == 1 && usage["output_width"] == width && usage["output_height"] == height => {
                Ok((url.to_string(), json!({ "images": 1, "width": width, "height": height })))
            }
            _ => Err(invalid_response()),
        }
    }

    /// `prepareMossSpeech` (the farm sends no language or metadata).
    pub fn prepare_speech(model: &str, text: &str, voice: &str, format: &str) -> Result<Value, VendorError> {
        let pro = model.starts_with("moss-tts-1.0-pro");
        let pauses_ok = if pro {
            !text.contains("[pause")
        } else {
            static PAUSE_ANY: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"\[pause[^\]]*\]").expect("regex"));
            static PAUSE_GOOD: std::sync::LazyLock<regex::Regex> =
                std::sync::LazyLock::new(|| regex::Regex::new(r"^\[pause (?:0\.[1-9]\d*|[1-9](?:\.\d+)?|10(?:\.0+)?)s\]$").expect("regex"));
            PAUSE_ANY.find_iter(text).all(|m| PAUSE_GOOD.is_match(m.as_str()))
        };
        if !SPEECH_MODELS.contains(&model) || !text_ok(text, 10000) || !audio_id(voice) || !FORMATS.contains(&format) || !pauses_ok {
            return Err(invalid_input());
        }
        Ok(json!({ "model": model, "input": text, "voice_id": voice, "response_format": format, "delivery_method": "url", "stream": false }))
    }

    fn audio_result(r: &Value) -> Option<Generated> {
        let url = r["url"].as_str().filter(|u| https_url(u, 8192))?;
        let format = r["response_format"].as_str().filter(|f| FORMATS.contains(f))?;
        let kind = r["content_type"].as_str().filter(|c| code_points(c, 1, 256))?;
        let bare = kind.split(';').next().unwrap_or("").trim().to_lowercase();
        if !audio_mimes(format).contains(&bare.as_str()) {
            return None;
        }
        let usage = if r["usage"].is_null() { None } else { Some(usage_of(&r["usage"])?) };
        Some(Generated {
            url: url.into(),
            format: format.into(),
            content_type: kind.into(),
            usage,
        })
    }

    pub fn speech_generate(&self, key: &str, body: &Value) -> Result<Generated, VendorError> {
        let mut b = body.clone();
        b["async"] = json!(false);
        let r = self.call(key, "POST", "/audio/speech", json_body(&b), Duration::from_secs(300), true)?;
        if r["object"] != "audio.speech" || r["status"] != "SUCCESS" || !r["id"].as_str().is_some_and(audio_id) {
            return Err(invalid_response());
        }
        Self::audio_result(&r).ok_or_else(invalid_response)
    }

    /// `submitMossAudioTask` and the speech task: the task id.
    pub fn submit(&self, key: &str, path: &str, body: &Value) -> Result<String, VendorError> {
        let r = self.call(key, "POST", path, json_body(body), Duration::from_secs(300), true)?;
        r["task_id"].as_str().filter(|t| audio_id(t)).map(str::to_string).ok_or_else(invalid_response)
    }

    pub fn speech_task(&self, key: &str, body: &Value) -> Result<String, VendorError> {
        let mut b = body.clone();
        b["async"] = json!(true);
        self.submit(key, "/audio/speech", &b)
    }

    /// `getMossAudioTask`.
    pub fn task(&self, key: &str, id: &str) -> Result<Task, VendorError> {
        if !audio_id(id) {
            return Err(invalid_input());
        }
        let r = self.call(key, "GET", &format!("/audio/tasks/{id}"), None, Duration::from_secs(30), true)?;
        let kind = match r["object"].as_str() {
            Some("audio.speech") => TaskKind::Speech,
            Some("audio.voice_generation") => TaskKind::VoiceGeneration,
            Some("audio.transcription") => TaskKind::Transcription,
            _ => return Err(invalid_response()),
        };
        if r["id"] != id || !r["created_at"].is_i64() || r["updated_at"].as_i64() < r["created_at"].as_i64() {
            return Err(invalid_response());
        }
        match r["status"].as_str() {
            Some("PENDING" | "PROCESSING") => Ok(Task::Waiting),
            Some("FAILED") => Ok(Task::Failed),
            Some("SUCCESS") if kind == TaskKind::Transcription => {
                let text = r["text"].as_str().ok_or_else(invalid_response)?.to_string();
                let segments = match &r["segments"] {
                    Value::Null => vec![],
                    Value::Array(a) if a.len() <= 10000 => a.iter().map(segment_of).collect::<Option<Vec<_>>>().ok_or_else(invalid_response)?,
                    _ => return Err(invalid_response()),
                };
                let usage = if r["usage"].is_null() {
                    None
                } else {
                    Some(usage_of(&r["usage"]).ok_or_else(invalid_response)?)
                };
                Ok(Task::Transcription { text, segments, usage })
            }
            Some("SUCCESS") => Ok(Task::Audio(kind, Self::audio_result(&r).ok_or_else(invalid_response)?)),
            _ => Err(invalid_response()),
        }
    }

    /// `streamMossSpeech`: the SSE stream, each event handed to `on` as it
    /// comes; it ends with `Done`, anything short of it fails.
    pub fn speech_stream(&self, key: &str, body: &Value, stop: &Stop, on: &mut dyn FnMut(SpeechEvent) -> Result<(), String>) -> Result<(), StreamError> {
        let flash = body["model"].as_str().is_some_and(|m| m.starts_with("moss-tts-1.5-flash"));
        if !flash || body["response_format"] != "pcm" {
            return Err(StreamError::Vendor(invalid_input()));
        }
        let mut b = body.clone();
        if let Some(o) = b.as_object_mut() {
            o.remove("delivery_method");
        }
        b["stream"] = json!(true);
        b["stream_format"] = json!("sse");
        b["async"] = json!(false);
        let started = Instant::now();
        let mut r = self.send(
            key,
            "POST",
            format!("{MOSS}/audio/speech"),
            json_body(&b),
            "text/event-stream",
            Duration::from_secs(300),
        )?;
        if !(200..300).contains(&r.status) {
            let raw = read_max(&mut r.body, 1 << 20, None)?;
            let missing = serde_json::from_slice::<Value>(&raw).is_ok_and(|v| v["error"]["code"] == "voice_not_found");
            let outcome = if REJECTED.contains(&r.status) || (r.status == 404 && missing) {
                Outcome::Rejected
            } else {
                Outcome::Unknown
            };
            return Err(StreamError::Vendor(VendorError {
                reason: Reason::HttpStatus,
                outcome,
                status: Some(r.status),
                code: None,
            }));
        }
        if r.media_type() != "text/event-stream" {
            return Err(StreamError::Vendor(invalid_response()));
        }
        let (mut frame, mut audio, mut count, mut task) = (0i64, 0usize, 0, false);
        let mut done = false;
        sse(&mut r.body, 1 << 20, 192 << 20, stop, started, Duration::from_secs(300), &mut |event, data| {
            count += 1;
            if count > 100_000 {
                return Err(StreamError::Vendor(VendorError::new(Reason::TooLarge, Outcome::Unknown)));
            }
            let v: Value = serde_json::from_str(data).map_err(|_| StreamError::Vendor(invalid_response()))?;
            let kind = v["type"].as_str().unwrap_or("");
            if event != "message" && event != kind {
                return Err(StreamError::Vendor(invalid_response()));
            }
            let bad = || StreamError::Vendor(invalid_response());
            let next = match kind {
                "task.created" => {
                    if task || frame != 0 || !v["task_id"].as_str().is_some_and(audio_id) {
                        return Err(bad());
                    }
                    task = true;
                    SpeechEvent::TaskCreated(v["task_id"].as_str().unwrap_or("").into())
                }
                "speech.created" => {
                    let (rate, ch, depth) = (
                        v["sample_rate"].as_i64().unwrap_or(0),
                        v["channels"].as_i64().unwrap_or(0),
                        v["bit_depth"].as_i64().unwrap_or(0),
                    );
                    if frame != 0 || v["format"] != "pcm" || !(8000..=192000).contains(&rate) || !(1..=8).contains(&ch) || ![8, 16, 24, 32].contains(&depth) {
                        return Err(bad());
                    }
                    frame = ch * depth / 8;
                    SpeechEvent::Created {
                        sample_rate: rate,
                        channels: ch,
                        bit_depth: depth,
                    }
                }
                "speech.audio.delta" => {
                    use base64::Engine;
                    let text: String = v["audio"].as_str().unwrap_or("").chars().filter(|c| *c != '\n' && *c != '\r').collect();
                    if frame == 0 || text.is_empty() {
                        return Err(bad());
                    }
                    let bytes = base64::engine::general_purpose::STANDARD.decode(&text).map_err(|_| bad())?;
                    audio += bytes.len();
                    if bytes.len() > 512 << 10 || audio > 128 << 20 {
                        return Err(StreamError::Vendor(VendorError::new(Reason::TooLarge, Outcome::Unknown)));
                    }
                    if bytes.is_empty() {
                        return Err(bad());
                    }
                    SpeechEvent::Delta(bytes)
                }
                "speech.audio.done" => {
                    if frame == 0 || audio == 0 || audio % frame as usize != 0 {
                        return Err(bad());
                    }
                    done = true;
                    let usage = if v["usage"].is_null() { None } else { usage_of(&v["usage"]) };
                    SpeechEvent::Done {
                        usage,
                        duration: v["meta_info"]["performance"]["audio_duration_s"].as_f64(),
                    }
                }
                _ => return Err(bad()),
            };
            on(next).map_err(StreamError::Mine)?;
            Ok(!done)
        })?;
        if done { Ok(()) } else { Err(StreamError::Vendor(invalid_response())) }
    }

    /// `prepareMossSpeakers`.
    pub fn prepare_speakers(model: &str, sp: &[MediaSpeakersRequestSpeakers], sg: &[MediaSpeakersRequestSegments], format: &str) -> Result<Value, VendorError> {
        if !(1..=100).contains(&sp.len()) || !(1..=1000).contains(&sg.len()) {
            return Err(invalid_input());
        }
        let mut ids = std::collections::HashSet::new();
        for s in sp {
            if !text_ok(&s.id, 256) || !audio_id(&s.voice) || !ids.insert(s.id.as_str()) {
                return Err(invalid_input());
            }
        }
        let mut count = 0;
        for s in sg {
            count += s.text.chars().count();
            if !ids.contains(s.speaker.as_str()) || !text_ok(&s.text, 10000) || count > 10000 {
                return Err(invalid_input());
            }
        }
        if !SPEAKERS_MODELS.contains(&model) || !FORMATS.contains(&format) {
            return Err(invalid_input());
        }
        Ok(json!({
            "model": model,
            "speakers": sp.iter().map(|s| json!({ "id": s.id, "voice_id": s.voice })).collect::<Vec<_>>(),
            "segments": sg.iter().map(|s| json!({ "speaker": s.speaker, "text": s.text })).collect::<Vec<_>>(),
            "response_format": format,
            "delivery_method": "url",
            "async": true,
        }))
    }

    /// `prepareMossVoiceDesign`.
    pub fn prepare_design(model: &str, text: &str, instruction: &str, format: &str) -> Result<Value, VendorError> {
        if !VOICE_DESIGN_MODELS.contains(&model) || !text_ok(text, 10000) || !text_ok(instruction, 10000) || !FORMATS.contains(&format) {
            return Err(invalid_input());
        }
        Ok(
            json!({ "model": model, "input": text, "instruction": instruction, "response_format": format, "delivery_method": "url", "create_voice": false, "async": true }),
        )
    }

    /// `prepareMossTranscription`.
    pub fn prepare_transcription(model: &str, file_id: &str, diarize: Option<bool>, keyterms: Option<&Vec<String>>) -> Result<Value, VendorError> {
        let pro = model.starts_with("moss-transcribe-diarize-pro");
        let terms_ok = keyterms.is_none_or(|k| k.len() <= 20 && k.iter().all(|t| text_ok(t, 30)));
        if !TRANSCRIPTION_MODELS.contains(&model)
            || !audio_id(file_id)
            || !terms_ok
            || (!pro && (diarize == Some(true) || keyterms.is_some_and(|k| !k.is_empty())))
        {
            return Err(invalid_input());
        }
        let mut b = json!({ "model": model, "file_id": file_id, "response_format": "json", "async": true, "stream": false });
        if let Some(d) = diarize {
            b["diarize"] = json!(d);
        }
        if let Some(k) = keyterms {
            b["keyterms"] = json!(k);
        }
        Ok(b)
    }

    /// Whether the model a transcription body names answers as a stream.
    pub fn streams_transcripts(body: &Value) -> bool {
        body["model"].as_str().is_some_and(|m| m.starts_with("moss-transcribe-diarize-pro"))
    }

    /// `streamMossTranscription`.
    pub fn transcription_stream(
        &self,
        key: &str,
        body: &Value,
        stop: &Stop,
        on: &mut dyn FnMut(TranscriptionEvent) -> Result<(), String>,
    ) -> Result<(), StreamError> {
        if !Self::streams_transcripts(body) {
            return Err(StreamError::Vendor(invalid_input()));
        }
        let mut b = body.clone();
        b["response_format"] = json!("verbose_json");
        b["stream"] = json!(true);
        b["async"] = json!(false);
        let started = Instant::now();
        let mut r = self.send(
            key,
            "POST",
            format!("{MOSS}/audio/transcriptions"),
            json_body(&b),
            "text/event-stream",
            Duration::from_secs(900),
        )?;
        if !(200..300).contains(&r.status) {
            read_max(&mut r.body, 1 << 20, None)?;
            let outcome = if REJECTED.contains(&r.status) { Outcome::Rejected } else { Outcome::Unknown };
            return Err(StreamError::Vendor(VendorError {
                reason: Reason::HttpStatus,
                outcome,
                status: Some(r.status),
                code: None,
            }));
        }
        if r.media_type() != "text/event-stream" {
            return Err(StreamError::Vendor(invalid_response()));
        }
        let (mut count, mut deltas, mut seg_len, mut segs, mut done) = (0, 0usize, 0usize, 0, false);
        let too_large = || StreamError::Vendor(VendorError::new(Reason::TooLarge, Outcome::Unknown));
        sse(&mut r.body, 4 << 20, 32 << 20, stop, started, Duration::from_secs(900), &mut |event, data| {
            count += 1;
            if count > 100_000 {
                return Err(too_large());
            }
            let bad = || StreamError::Vendor(invalid_response());
            let v: Value = serde_json::from_str(data).map_err(|_| bad())?;
            let kind = v["type"].as_str().unwrap_or("");
            if event != "message" && event != kind {
                return Err(bad());
            }
            let next = match kind {
                "task.created" => {
                    if count != 1 || !v["task_id"].as_str().is_some_and(audio_id) {
                        return Err(bad());
                    }
                    TranscriptionEvent::TaskCreated(v["task_id"].as_str().unwrap_or("").into())
                }
                "transcript.text.delta" => {
                    let d = v["delta"].as_str().ok_or_else(bad)?;
                    deltas += d.encode_utf16().count();
                    if deltas > 1 << 20 {
                        return Err(too_large());
                    }
                    TranscriptionEvent::Delta(d.into())
                }
                "transcript.segment.done" => {
                    let segment = segment_of(&v).filter(|_| v["content_index"].is_i64()).ok_or_else(bad)?;
                    seg_len += segment.text.encode_utf16().count();
                    segs += 1;
                    if segs > 10000 || seg_len > 1 << 20 {
                        return Err(too_large());
                    }
                    let usage = if v["session_usage"].is_null() { None } else { usage_of(&v["session_usage"]) };
                    TranscriptionEvent::Segment {
                        index: v["content_index"].as_i64().unwrap_or(0),
                        segment,
                        usage,
                    }
                }
                "transcript.text.done" => {
                    let text = v["text"].as_str().ok_or_else(bad)?;
                    if text.encode_utf16().count() > 1 << 20 {
                        return Err(too_large());
                    }
                    done = true;
                    let usage = if v["usage"].is_null() { None } else { usage_of(&v["usage"]) };
                    TranscriptionEvent::Done { text: text.into(), usage }
                }
                _ => return Err(bad()),
            };
            on(next).map_err(StreamError::Mine)?;
            Ok(!done)
        })?;
        if done { Ok(()) } else { Err(StreamError::Vendor(invalid_response())) }
    }

    /// `prepareMossUnderstanding`: `media` is `[(kind, file id)]`, one video or up to five images.
    pub fn prepare_understanding(model: &str, text: &str, media: &[(MediaInputKind, String)], max_tokens: i64) -> Result<Value, VendorError> {
        let images = media.iter().all(|(k, _)| *k == MediaInputKind::Image) && (1..=5).contains(&media.len());
        let video = media.len() == 1 && media[0].0 == MediaInputKind::Video;
        if !UNDERSTANDING_MODELS.contains(&model)
            || !text_ok(text, 64000)
            || !(images || video)
            || !(1..=8192).contains(&max_tokens)
            || media.iter().any(|(_, id)| !text_ok(id, 256))
        {
            return Err(invalid_input());
        }
        let mut content = vec![json!({ "type": "input_text", "text": text })];
        for (kind, id) in media {
            content.push(json!({ "type": if *kind == MediaInputKind::Image { "input_image" } else { "input_video" }, "file_id": id }));
        }
        Ok(json!({ "model": model, "input": [{ "role": "user", "content": content }], "max_output_tokens": max_tokens }))
    }

    /// `understandMossMedia`.
    pub fn understand(&self, key: &str, body: &Value) -> Result<MediaUnderstandingResult, VendorError> {
        let mut r = self.send(
            key,
            "POST",
            format!("{MOSS}/responses"),
            json_body(body),
            "application/json",
            Duration::from_secs(180),
        )?;
        let raw = read_max(&mut r.body, 1 << 20, None)?;
        if r.status != 200 {
            let outcome = if REJECTED.contains(&r.status) { Outcome::Rejected } else { Outcome::Unknown };
            return Err(VendorError {
                reason: Reason::HttpStatus,
                outcome,
                status: Some(r.status),
                code: None,
            });
        }
        let v: Value = serde_json::from_slice(&raw).map_err(|_| invalid_response())?;
        let status = match v["status"].as_str() {
            Some("completed") => MediaUnderstandingStatus::Completed,
            Some("incomplete") => MediaUnderstandingStatus::Incomplete,
            _ => return Err(invalid_response()),
        };
        let output = v["output"].as_array().filter(|o| !o.is_empty()).ok_or_else(invalid_response)?;
        let mut texts = vec![];
        for item in output {
            let content = item["content"].as_array().filter(|c| !c.is_empty()).ok_or_else(invalid_response)?;
            for part in content {
                if part["type"] != "output_text" {
                    return Err(invalid_response());
                }
                texts.push(part["text"].as_str().ok_or_else(invalid_response)?.to_string());
            }
        }
        let u = &v["usage"];
        let tokens = |k: &str| u[k].as_i64().filter(|n| *n >= 0);
        let (Some(i), Some(o), Some(t)) = (tokens("input_tokens"), tokens("output_tokens"), tokens("total_tokens")) else {
            return Err(invalid_response());
        };
        let model = v["model"].as_str().filter(|m| !m.is_empty()).ok_or_else(invalid_response)?;
        let cut = status == MediaUnderstandingStatus::Incomplete && v["incomplete_details"]["reason"] == "max_output_tokens";
        Ok(MediaUnderstandingResult {
            model: model.into(),
            text: texts.join("\n"),
            status,
            incomplete_reason: cut.then_some(MediaUnderstandingResultIncompleteReason::MaxOutputTokens),
            usage: MediaUnderstandingResultUsage {
                input_tokens: i,
                output_tokens: o,
                total_tokens: t,
            },
        })
    }

    /// `uploadMossFile`: the file's id and whether MOSS took it.
    pub fn upload(&self, key: &str, file: std::fs::File, size: i64, filename: &str, purpose: &str) -> Result<(String, Uploaded), VendorError> {
        if !(1..=512_000_000).contains(&size) || !code_points(filename, 1, 256) {
            return Err(invalid_input());
        }
        let parts = vec![
            Part {
                name: "purpose".into(),
                filename: None,
                kind: String::new(),
                bytes: Box::new(std::io::Cursor::new(purpose.as_bytes().to_vec())),
            },
            Part {
                name: "file".into(),
                filename: Some(filename.into()),
                kind: "application/octet-stream".into(),
                bytes: Box::new(file),
            },
        ];
        let r = self.call(key, "POST", "/files", Some(multipart(parts)), Duration::from_secs(300), false)?;
        let id = r["id"].as_str().filter(|i| file_id_ok(i)).ok_or_else(invalid_response)?;
        if r["object"] != "file" || r["bytes"] != size || r["purpose"] != purpose {
            return Err(invalid_response());
        }
        let state = match r["status"].as_str() {
            Some("processed" | "active") => Uploaded::Ready,
            Some("failed") => Uploaded::Rejected,
            _ => Uploaded::Unknown,
        };
        Ok((id.into(), state))
    }

    /// `deleteMossFile`; a 404 counts as gone.
    pub fn delete_file(&self, key: &str, id: &str) -> Result<(), VendorError> {
        if !file_id_ok(id) {
            return Err(invalid_input());
        }
        let path = format!("/files/{}", url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>());
        match self.call(key, "DELETE", &path, None, Duration::from_secs(300), false) {
            Ok(r) if r["id"] == id && r["deleted"] == true => Ok(()),
            Ok(_) => Err(invalid_response()),
            Err(e) if e.status == Some(404) => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// `createMossVoice`: the cloned voice.
    pub fn clone_voice(&self, key: &str, audio: Vec<u8>, filename: &str, name: Option<&str>) -> Result<MediaAudioVoice, VendorError> {
        let mut parts = vec![Part {
            name: "audio_sample".into(),
            filename: Some(filename.into()),
            kind: "application/octet-stream".into(),
            bytes: Box::new(std::io::Cursor::new(audio)),
        }];
        if let Some(n) = name {
            parts.push(Part {
                name: "name".into(),
                filename: None,
                kind: String::new(),
                bytes: Box::new(std::io::Cursor::new(n.as_bytes().to_vec())),
            });
        }
        let r = self.call(key, "POST", "/audio/voices", Some(multipart(parts)), Duration::from_secs(300), true)?;
        match (r["id"].as_str().filter(|i| audio_id(i)), r["name"].as_str(), r["created_at"].as_i64()) {
            (Some(id), Some(n), Some(at)) => Ok(MediaAudioVoice {
                id: id.into(),
                name: n.into(),
                created_at_seconds: JsNumber(at as f64),
            }),
            _ => Err(invalid_response()),
        }
    }
}

fn file_id_ok(id: &str) -> bool {
    code_points(id, 1, 256) && id != "." && id != ".." && !id.chars().any(|c| c.is_whitespace() || c.is_control() || "/\\?#".contains(c))
}

/// A stream's end short of done: the vendor's failure, or the receiver's.
#[derive(Debug)]
pub enum StreamError {
    Vendor(VendorError),
    Mine(String),
    Stopped,
}

impl From<VendorError> for StreamError {
    fn from(e: VendorError) -> StreamError {
        StreamError::Vendor(e)
    }
}

/// `sseEvents`: `on(event, data)` per event until it says false; the body
/// at most `wire` bytes, an event at most `max`, the whole under `deadline`.
fn sse(
    body: &mut dyn Read,
    max: usize,
    wire: usize,
    stop: &Stop,
    started: Instant,
    deadline: Duration,
    on: &mut dyn FnMut(&str, &str) -> Result<bool, StreamError>,
) -> Result<(), StreamError> {
    let mut buf = [0u8; 16384];
    let mut pending: Vec<u8> = vec![];
    let mut total = 0;
    let (mut event, mut data): (String, Vec<String>) = (String::new(), vec![]);
    loop {
        if stop.aborted() {
            return Err(StreamError::Stopped);
        }
        if started.elapsed() > deadline {
            return Err(StreamError::Vendor(VendorError::new(Reason::Timeout, Outcome::Unknown)));
        }
        let n = body
            .read(&mut buf)
            .map_err(|_| StreamError::Vendor(VendorError::new(Reason::Network, Outcome::Unknown)))?;
        if n == 0 {
            return Ok(());
        }
        total += n;
        if total > wire {
            return Err(StreamError::Vendor(VendorError::new(Reason::TooLarge, Outcome::Unknown)));
        }
        pending.extend_from_slice(&buf[..n]);
        while let Some(at) = pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = pending.drain(..=at).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                if !data.is_empty() {
                    let name = if event.is_empty() { "message" } else { event.as_str() };
                    if !on(name, &data.join("\n"))? {
                        return Ok(());
                    }
                }
                event.clear();
                data.clear();
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = line.split_once(':').map(|(f, v)| (f, v.strip_prefix(' ').unwrap_or(v))).unwrap_or((line, ""));
            match field {
                "event" => event = value.into(),
                "data" => data.push(value.into()),
                "retry" => return Err(StreamError::Vendor(invalid_response())),
                _ => {}
            }
            if data.iter().map(String::len).sum::<usize>() > max {
                return Err(StreamError::Vendor(VendorError::new(Reason::TooLarge, Outcome::Unknown)));
            }
        }
        if pending.len() > max {
            return Err(StreamError::Vendor(VendorError::new(Reason::TooLarge, Outcome::Unknown)));
        }
    }
}
