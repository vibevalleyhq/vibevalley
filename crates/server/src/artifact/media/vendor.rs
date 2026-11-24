//! Async MOSS vendor client routed through [`Fetch`], so tests answer offline
//! via [`crate::fake::moss::network`] while production uses no-redirect `reqwest`.

use std::io::Read;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use vibevalley_protocol::{
    JsNumber, MediaAudioSegment, MediaAudioVoice, MediaImageFormat, MediaImageRequest, MediaImageUsage, MediaInputKind, MediaSpeakersRequestSegments,
    MediaSpeakersRequestSpeakers, MediaUnderstandingResult, MediaUnderstandingResultIncompleteReason, MediaUnderstandingResultUsage, MediaUnderstandingStatus,
};

use super::Stop;
use crate::context::http::{Fetch, FetchError, ReadError, Request, Response, read_max_until};
use crate::log::spawn_blocking_traced;
use crate::setting::{IMAGE_MODELS, MOSS, SPEAKERS_MODELS, SPEECH_MODELS, TRANSCRIPTION_MODELS, UNDERSTANDING_MODELS, VOICE_DESIGN_MODELS};

/// What failed on a vendor call, and whether the call may have taken effect.
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

    /// Nothing sent counts as refused rather than unknown.
    pub fn unknown(&self) -> bool {
        self.outcome == Outcome::Unknown
    }

    /// Network, timeout, 429, and 5xx are retryable.
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

fn bad_key(key: &str) -> bool {
    key.trim().is_empty() || key.chars().any(char::is_whitespace)
}

/// Account credentials held in memory for a media job.
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

/// Reads a response body up to `max` bytes, aborting if `stop` fires.
pub fn read_max(body: &mut dyn Read, max: usize, stop: Option<&Stop>) -> Result<Vec<u8>, VendorError> {
    read_max_until(body, max, || stop.is_some_and(Stop::aborted)).map_err(|e| match e {
        ReadError::TooLarge => VendorError::new(Reason::TooLarge, Outcome::Unknown),
        ReadError::Aborted | ReadError::Io => VendorError::new(Reason::Network, Outcome::Unknown),
    })
}

async fn read_body_async(mut body: Box<dyn Read + Send>, max: usize, stop: Option<Stop>) -> Result<Vec<u8>, VendorError> {
    spawn_blocking_traced(move || read_max(&mut *body, max, stop.as_ref()))
        .await
        .map_err(|_| VendorError::new(Reason::Network, Outcome::Unknown))?
}

fn code_points(s: &str, min: usize, max: usize) -> bool {
    let n = s.chars().count();
    n >= min && n <= max
}

fn text_ok(s: &str, max: usize) -> bool {
    code_points(s, 1, max) && s.chars().any(|c| !c.is_whitespace())
}

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

#[derive(Deserialize)]
struct WireErrorBody {
    error: Option<WireErrorDetail>,
}

#[derive(Deserialize)]
struct WireErrorDetail {
    code: Option<String>,
}

#[derive(Deserialize)]
struct WireAudioUsage {
    input_characters: Option<serde_json::Number>,
    prompt_tokens: Option<serde_json::Number>,
    completion_tokens: Option<serde_json::Number>,
    total_tokens: Option<serde_json::Number>,
    input_audio_seconds: Option<serde_json::Number>,
}

fn usage_of(u: WireAudioUsage) -> Option<Value> {
    let mut out = serde_json::Map::new();
    for (to, val) in [
        ("inputCharacters", u.input_characters),
        ("promptTokens", u.prompt_tokens),
        ("completionTokens", u.completion_tokens),
        ("totalTokens", u.total_tokens),
        ("inputAudioSeconds", u.input_audio_seconds),
    ] {
        if let Some(n) = val {
            if !n.as_f64().is_some_and(|f| f.is_finite() && f >= 0.0) {
                return None;
            }
            out.insert(to.into(), Value::Number(n));
        }
    }
    Some(Value::Object(out))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LayoutPrompt {
    summary: LayoutSummary,
    items: Vec<LayoutItem>,
    bbox_format: String,
    bbox_coord_space: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LayoutSummary {
    caption: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    meta: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    canvas: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LayoutItem {
    label: String,
    caption: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    bbox: [f64; 4],
}

#[derive(Deserialize)]
struct WireImageResponse {
    created: Option<i64>,
    data: Vec<WireImageItem>,
    usage: WireImageUsage,
}

#[derive(Deserialize)]
struct WireImageItem {
    url: String,
}

#[derive(Deserialize)]
struct WireImageUsage {
    generated_images: i64,
    output_width: i64,
    output_height: i64,
}

#[derive(Deserialize)]
struct WireSpeechResponse {
    object: String,
    status: String,
    id: String,
    url: String,
    response_format: String,
    content_type: String,
    usage: Option<WireAudioUsage>,
}

#[derive(Deserialize)]
struct WireTaskSubmitted {
    task_id: String,
}

#[derive(Deserialize)]
struct WireSegment {
    speaker: String,
    text: String,
    start: f64,
    end: f64,
}

#[derive(Deserialize)]
struct WireAudioTaskResponse {
    object: String,
    id: String,
    status: String,
    created_at: i64,
    updated_at: i64,
    url: Option<String>,
    response_format: Option<String>,
    content_type: Option<String>,
    text: Option<String>,
    segments: Option<Vec<WireSegment>>,
    usage: Option<WireAudioUsage>,
}

#[derive(Deserialize)]
struct WireSpeechMeta {
    performance: Option<WireSpeechPerformance>,
}

#[derive(Deserialize)]
struct WireSpeechPerformance {
    audio_duration_s: Option<f64>,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum WireSpeechSseEvent {
    #[serde(rename = "task.created")]
    TaskCreated { task_id: String },
    #[serde(rename = "speech.created")]
    SpeechCreated {
        format: String,
        sample_rate: i64,
        channels: i64,
        bit_depth: i64,
    },
    #[serde(rename = "speech.audio.delta")]
    AudioDelta { audio: String },
    #[serde(rename = "speech.audio.done")]
    AudioDone {
        usage: Option<WireAudioUsage>,
        meta_info: Option<WireSpeechMeta>,
    },
}

impl WireSpeechSseEvent {
    fn event_type(&self) -> &'static str {
        match self {
            WireSpeechSseEvent::TaskCreated { .. } => "task.created",
            WireSpeechSseEvent::SpeechCreated { .. } => "speech.created",
            WireSpeechSseEvent::AudioDelta { .. } => "speech.audio.delta",
            WireSpeechSseEvent::AudioDone { .. } => "speech.audio.done",
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum WireTranscriptionSseEvent {
    #[serde(rename = "task.created")]
    TaskCreated { task_id: String },
    #[serde(rename = "transcript.text.delta")]
    TextDelta { delta: String },
    #[serde(rename = "transcript.segment.done")]
    SegmentDone {
        content_index: i64,
        speaker: String,
        text: String,
        start: f64,
        end: f64,
        session_usage: Option<WireAudioUsage>,
    },
    #[serde(rename = "transcript.text.done")]
    TextDone { text: String, usage: Option<WireAudioUsage> },
}

impl WireTranscriptionSseEvent {
    fn event_type(&self) -> &'static str {
        match self {
            WireTranscriptionSseEvent::TaskCreated { .. } => "task.created",
            WireTranscriptionSseEvent::TextDelta { .. } => "transcript.text.delta",
            WireTranscriptionSseEvent::SegmentDone { .. } => "transcript.segment.done",
            WireTranscriptionSseEvent::TextDone { .. } => "transcript.text.done",
        }
    }
}

#[derive(Deserialize)]
struct WireUnderstandingResponse {
    model: String,
    status: String,
    incomplete_details: Option<WireIncompleteDetails>,
    output: Vec<WireUnderstandingOutput>,
    usage: WireUnderstandingUsage,
}

#[derive(Deserialize)]
struct WireIncompleteDetails {
    reason: Option<String>,
}

#[derive(Deserialize)]
struct WireUnderstandingOutput {
    content: Vec<WireUnderstandingPart>,
}

#[derive(Deserialize)]
struct WireUnderstandingPart {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
}

#[derive(Deserialize)]
struct WireUnderstandingUsage {
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
}

#[derive(Deserialize)]
struct WireUploadedFile {
    id: String,
    object: String,
    bytes: i64,
    purpose: String,
    status: Option<String>,
}

#[derive(Deserialize)]
struct WireDeletedFile {
    id: String,
    deleted: bool,
}

#[derive(Deserialize)]
struct WireClonedVoice {
    id: String,
    name: String,
    created_at: i64,
}

/// Generated audio metadata returned by MOSS before local download.
#[derive(Debug, Clone)]
pub struct Generated {
    pub url: String,
    pub format: String,
    pub content_type: String,
    pub usage: Option<Value>,
}

/// Kind of asynchronous vendor audio task.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskKind {
    Speech,
    VoiceGeneration,
    Transcription,
}

/// Polled status of a vendor audio task.
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

/// Vendor acceptance state for an uploaded file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Uploaded {
    Ready,
    Rejected,
    Unknown,
}

fn segment_of(speaker: String, text: String, start: f64, end: f64) -> Option<MediaAudioSegment> {
    if !code_points(&speaker, 1, 256) || !start.is_finite() || !end.is_finite() || start < 0.0 || end < start {
        return None;
    }
    Some(MediaAudioSegment {
        speaker,
        text,
        start: JsNumber(start),
        end: JsNumber(end),
    })
}

#[derive(Debug, Clone)]
pub enum SpeechEvent {
    TaskCreated(String),
    Created { sample_rate: i64, channels: i64, bit_depth: i64 },
    Delta(Vec<u8>),
    Done { usage: Option<Value>, duration: Option<f64> },
}

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

/// MOSS vendor adapter routed through [`Fetch`].
#[derive(Clone)]
pub struct Moss {
    pub fetch: Arc<dyn Fetch>,
}

fn json_body(v: &Value) -> Option<(String, Box<dyn Read + Send>)> {
    Some(("application/json".into(), Box::new(std::io::Cursor::new(v.to_string().into_bytes()))))
}

/// One multipart form field or file part.
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

fn validate_image_prompt(r: &MediaImageRequest) -> Result<String, VendorError> {
    if r.id.is_empty()
        || r.id.len() > 80
        || !r.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || !text_ok(&r.prompt, 4000)
        || !(256..=2048).contains(&r.width)
        || !(256..=2048).contains(&r.height)
        || r.width % 16 != 0
        || r.height % 16 != 0
        || r.width * r.height > 2_097_152
        || r.steps.is_some_and(|s| !(1..=100).contains(&s))
        || r.guidance.is_some_and(|g| !g.0.is_finite() || !(0.0..=10.0).contains(&g.0))
        || r.negative_prompt.as_ref().is_some_and(|s| s.chars().count() > 4000)
    {
        return Err(invalid_input());
    }
    if r.format != MediaImageFormat::Layout {
        return Ok(r.prompt.clone());
    }
    let layout: LayoutPrompt = serde_json::from_str(&r.prompt).map_err(|_| invalid_input())?;
    if !text_ok(&layout.summary.caption, 4000)
        || layout.summary.canvas.as_ref().is_some_and(String::is_empty)
        || layout.summary.meta.as_ref().is_some_and(|m| m.iter().any(String::is_empty))
        || layout.bbox_format != "yxyx"
        || layout.bbox_coord_space != "abs_centralized"
        || layout.items.is_empty()
        || layout.items.len() > 100
    {
        return Err(invalid_input());
    }
    let (h, w) = (r.height as f64 / 2.0, r.width as f64 / 2.0);
    for item in &layout.items {
        let b = item.bbox;
        if item.label.is_empty()
            || !text_ok(&item.caption, 4000)
            || !b.iter().all(|v| v.is_finite())
            || b[0] >= b[2]
            || b[1] >= b[3]
            || b[0] < -h
            || b[2] > h
            || b[1] < -w
            || b[3] > w
        {
            return Err(invalid_input());
        }
    }
    let serialized = serde_json::to_string(&layout).map_err(|_| invalid_input())?;
    if serialized.chars().count() > 4000 {
        return Err(invalid_input());
    }
    Ok(serialized)
}

struct VendorCall<'a> {
    key: &'a str,
    method: &'static str,
    path: &'a str,
    body: Option<(String, Box<dyn Read + Send>)>,
    timeout: Duration,
    audio: bool,
    stop: Option<&'a Stop>,
}

impl Moss {
    async fn send(&self, req: VendorCall<'_>, accept: &str) -> Result<Response, VendorError> {
        if bad_key(req.key) {
            return Err(VendorError::new(Reason::Credentials, Outcome::NotSubmitted));
        }
        let headers = vec![("authorization".into(), format!("Bearer {}", req.key)), ("accept".into(), accept.into())];
        let request = Request {
            method: req.method,
            url: format!("{MOSS}{}", req.path),
            headers,
            body: req.body,
            timeout: req.timeout,
        };
        let cancel = req.stop.map(Stop::token).unwrap_or_else(CancellationToken::new);
        self.fetch.clone().fetch_async(request, cancel).await.map_err(|e| match e {
            FetchError::Timeout => VendorError::new(Reason::Timeout, Outcome::Unknown),
            FetchError::Network(_) => VendorError::new(Reason::Network, Outcome::Unknown),
        })
    }

    async fn call<T: DeserializeOwned>(&self, req: VendorCall<'_>) -> Result<T, VendorError> {
        let audio = req.audio;
        let stop = req.stop.cloned();
        let r = self.send(req, "application/json").await?;
        let raw = read_body_async(r.body, 1 << 20, stop).await?;
        if !(200..300).contains(&r.status) {
            let code = serde_json::from_slice::<WireErrorBody>(&raw).ok().and_then(|e| e.error).and_then(|e| e.code);
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
        serde_json::from_slice(&raw).map_err(|_| invalid_response())
    }

    /// Validates all image request refinements omitted by protocol generation.
    pub fn validate_image_request(r: &MediaImageRequest) -> Result<(), VendorError> {
        validate_image_prompt(r).map(|_| ())
    }

    pub fn prepare_image(model: &str, r: &MediaImageRequest) -> Result<Value, VendorError> {
        if !IMAGE_MODELS.contains(&model) {
            return Err(invalid_input());
        }
        let prompt = validate_image_prompt(r)?;
        let mut body = json!({
            "model": model,
            "prompt": prompt,
            "size": format!("{}x{}", r.width, r.height),
            "n": 1,
            "response_format": "url",
            "prompt_enhance": r.enhance,
            "output_watermark": { "enabled": r.watermark },
        });
        if let Some(seed) = r.seed {
            body["seed"] = json!(seed);
        }
        if let Some(steps) = r.steps {
            body["num_inference_steps"] = json!(steps);
        }
        if let Some(guidance) = r.guidance {
            body["guidance_scale"] = json!(guidance.0);
        }
        if let Some(neg) = &r.negative_prompt {
            body["negative_prompt"] = json!(neg);
        }
        Ok(body)
    }

    pub async fn image(&self, key: &str, body: &Value, width: i64, height: i64, stop: &Stop) -> Result<(String, MediaImageUsage), VendorError> {
        let r: WireImageResponse = self
            .call(VendorCall {
                key,
                method: "POST",
                path: "/images/generations",
                body: json_body(body),
                timeout: Duration::from_secs(900),
                audio: false,
                stop: Some(stop),
            })
            .await?;
        if r.created.is_none() || r.data.len() != 1 || r.usage.generated_images != 1 || r.usage.output_width != width || r.usage.output_height != height {
            return Err(invalid_response());
        }
        let url = &r.data[0].url;
        if !https_url(url, 8192) {
            return Err(invalid_response());
        }
        Ok((url.clone(), MediaImageUsage { images: 1, width, height }))
    }

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

    fn audio_result(url: String, format: String, content_type: String, usage: Option<WireAudioUsage>) -> Option<Generated> {
        if !https_url(&url, 8192) || !FORMATS.contains(&format.as_str()) || !code_points(&content_type, 1, 256) {
            return None;
        }
        let bare = content_type.split(';').next().unwrap_or("").trim().to_lowercase();
        if !audio_mimes(&format).contains(&bare.as_str()) {
            return None;
        }
        let usage = match usage {
            None => None,
            Some(u) => Some(usage_of(u)?),
        };
        Some(Generated {
            url,
            format,
            content_type,
            usage,
        })
    }

    pub async fn speech_generate(&self, key: &str, body: &Value, stop: &Stop) -> Result<Generated, VendorError> {
        let mut b = body.clone();
        b["async"] = json!(false);
        let r: WireSpeechResponse = self
            .call(VendorCall {
                key,
                method: "POST",
                path: "/audio/speech",
                body: json_body(&b),
                timeout: Duration::from_secs(300),
                audio: true,
                stop: Some(stop),
            })
            .await?;
        if r.object != "audio.speech" || r.status != "SUCCESS" || !audio_id(&r.id) {
            return Err(invalid_response());
        }
        Self::audio_result(r.url, r.response_format, r.content_type, r.usage).ok_or_else(invalid_response)
    }

    pub async fn submit(&self, key: &str, path: &str, body: &Value, stop: &Stop) -> Result<String, VendorError> {
        let r: WireTaskSubmitted = self
            .call(VendorCall {
                key,
                method: "POST",
                path,
                body: json_body(body),
                timeout: Duration::from_secs(300),
                audio: true,
                stop: Some(stop),
            })
            .await?;
        if audio_id(&r.task_id) { Ok(r.task_id) } else { Err(invalid_response()) }
    }

    pub async fn speech_task(&self, key: &str, body: &Value, stop: &Stop) -> Result<String, VendorError> {
        let mut b = body.clone();
        b["async"] = json!(true);
        self.submit(key, "/audio/speech", &b, stop).await
    }

    pub async fn task(&self, key: &str, id: &str, stop: &Stop) -> Result<Task, VendorError> {
        if !audio_id(id) {
            return Err(invalid_input());
        }
        let path = format!("/audio/tasks/{id}");
        let r: WireAudioTaskResponse = self
            .call(VendorCall {
                key,
                method: "GET",
                path: &path,
                body: None,
                timeout: Duration::from_secs(30),
                audio: true,
                stop: Some(stop),
            })
            .await?;
        let kind = match r.object.as_str() {
            "audio.speech" => TaskKind::Speech,
            "audio.voice_generation" => TaskKind::VoiceGeneration,
            "audio.transcription" => TaskKind::Transcription,
            _ => return Err(invalid_response()),
        };
        if r.id != id || r.updated_at < r.created_at {
            return Err(invalid_response());
        }
        match r.status.as_str() {
            "PENDING" | "PROCESSING" => Ok(Task::Waiting),
            "FAILED" => Ok(Task::Failed),
            "SUCCESS" if kind == TaskKind::Transcription => {
                let text = r.text.ok_or_else(invalid_response)?;
                let segments = match r.segments {
                    None => vec![],
                    Some(list) if list.len() <= 10000 => list
                        .into_iter()
                        .map(|s| segment_of(s.speaker, s.text, s.start, s.end))
                        .collect::<Option<Vec<_>>>()
                        .ok_or_else(invalid_response)?,
                    Some(_) => return Err(invalid_response()),
                };
                let usage = match r.usage {
                    None => None,
                    Some(u) => Some(usage_of(u).ok_or_else(invalid_response)?),
                };
                Ok(Task::Transcription { text, segments, usage })
            }
            "SUCCESS" => {
                let (Some(url), Some(format), Some(content_type)) = (r.url, r.response_format, r.content_type) else {
                    return Err(invalid_response());
                };
                Ok(Task::Audio(
                    kind,
                    Self::audio_result(url, format, content_type, r.usage).ok_or_else(invalid_response)?,
                ))
            }
            _ => Err(invalid_response()),
        }
    }

    /// Streams SSE speech events into `tx`; ends with `Done` or fails.
    pub async fn speech_stream(&self, key: &str, body: &Value, stop: &Stop, tx: tokio::sync::mpsc::Sender<SpeechEvent>) -> Result<(), StreamError> {
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
        let r = self
            .send(
                VendorCall {
                    key,
                    method: "POST",
                    path: "/audio/speech",
                    body: json_body(&b),
                    timeout: Duration::from_secs(300),
                    audio: true,
                    stop: Some(stop),
                },
                "text/event-stream",
            )
            .await?;
        let status = r.status;
        let media_type = r.media_type();
        if !(200..300).contains(&status) {
            let raw = read_body_async(r.body, 1 << 20, Some(stop.clone())).await?;
            let missing = serde_json::from_slice::<WireErrorBody>(&raw)
                .ok()
                .and_then(|e| e.error)
                .and_then(|e| e.code)
                .as_deref()
                == Some("voice_not_found");
            let outcome = if REJECTED.contains(&status) || (status == 404 && missing) {
                Outcome::Rejected
            } else {
                Outcome::Unknown
            };
            return Err(StreamError::Vendor(VendorError {
                reason: Reason::HttpStatus,
                outcome,
                status: Some(status),
                code: None,
            }));
        }
        if media_type != "text/event-stream" {
            return Err(StreamError::Vendor(invalid_response()));
        }
        let mut body_reader = r.body;
        let stop_read = stop.clone();
        spawn_blocking_traced(move || {
            let (mut frame, mut audio, mut count, mut task) = (0i64, 0usize, 0, false);
            let mut done = false;
            sse(
                &mut *body_reader,
                1 << 20,
                192 << 20,
                &stop_read,
                started,
                Duration::from_secs(300),
                &mut |event, data| {
                    count += 1;
                    if count > 100_000 {
                        return Err(StreamError::Vendor(VendorError::new(Reason::TooLarge, Outcome::Unknown)));
                    }
                    let bad = || StreamError::Vendor(invalid_response());
                    let parsed: WireSpeechSseEvent = serde_json::from_str(data).map_err(|_| bad())?;
                    if event != "message" && event != parsed.event_type() {
                        return Err(bad());
                    }
                    let next = match parsed {
                        WireSpeechSseEvent::TaskCreated { task_id } => {
                            if task || frame != 0 || !audio_id(&task_id) {
                                return Err(bad());
                            }
                            task = true;
                            SpeechEvent::TaskCreated(task_id)
                        }
                        WireSpeechSseEvent::SpeechCreated {
                            format,
                            sample_rate,
                            channels,
                            bit_depth,
                        } => {
                            if frame != 0
                                || format != "pcm"
                                || !(8000..=192000).contains(&sample_rate)
                                || !(1..=8).contains(&channels)
                                || ![8, 16, 24, 32].contains(&bit_depth)
                            {
                                return Err(bad());
                            }
                            frame = channels * bit_depth / 8;
                            SpeechEvent::Created {
                                sample_rate,
                                channels,
                                bit_depth,
                            }
                        }
                        WireSpeechSseEvent::AudioDelta { audio: raw_audio } => {
                            use base64::Engine;
                            let text: String = raw_audio.chars().filter(|c| *c != '\n' && *c != '\r').collect();
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
                        WireSpeechSseEvent::AudioDone { usage, meta_info } => {
                            if frame == 0 || audio == 0 || audio % frame as usize != 0 {
                                return Err(bad());
                            }
                            done = true;
                            SpeechEvent::Done {
                                usage: usage.and_then(usage_of),
                                duration: meta_info.and_then(|m| m.performance).and_then(|p| p.audio_duration_s),
                            }
                        }
                    };
                    tx.blocking_send(next).map_err(|_| StreamError::Mine("stopped".into()))?;
                    Ok(!done)
                },
            )?;
            if done { Ok(()) } else { Err(StreamError::Vendor(invalid_response())) }
        })
        .await
        .map_err(|_| StreamError::Mine("join error".into()))?
    }

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

    pub fn prepare_design(model: &str, text: &str, instruction: &str, format: &str) -> Result<Value, VendorError> {
        if !VOICE_DESIGN_MODELS.contains(&model) || !text_ok(text, 10000) || !text_ok(instruction, 10000) || !FORMATS.contains(&format) {
            return Err(invalid_input());
        }
        Ok(
            json!({ "model": model, "input": text, "instruction": instruction, "response_format": format, "delivery_method": "url", "create_voice": false, "async": true }),
        )
    }

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

    pub fn streams_transcripts(body: &Value) -> bool {
        body["model"].as_str().is_some_and(|m| m.starts_with("moss-transcribe-diarize-pro"))
    }

    pub async fn transcription_stream(
        &self,
        key: &str,
        body: &Value,
        stop: &Stop,
        tx: tokio::sync::mpsc::Sender<TranscriptionEvent>,
    ) -> Result<(), StreamError> {
        if !Self::streams_transcripts(body) {
            return Err(StreamError::Vendor(invalid_input()));
        }
        let mut b = body.clone();
        b["response_format"] = json!("verbose_json");
        b["stream"] = json!(true);
        b["async"] = json!(false);
        let started = Instant::now();
        let r = self
            .send(
                VendorCall {
                    key,
                    method: "POST",
                    path: "/audio/transcriptions",
                    body: json_body(&b),
                    timeout: Duration::from_secs(900),
                    audio: true,
                    stop: Some(stop),
                },
                "text/event-stream",
            )
            .await?;
        let status = r.status;
        let media_type = r.media_type();
        if !(200..300).contains(&status) {
            read_body_async(r.body, 1 << 20, Some(stop.clone())).await?;
            let outcome = if REJECTED.contains(&status) { Outcome::Rejected } else { Outcome::Unknown };
            return Err(StreamError::Vendor(VendorError {
                reason: Reason::HttpStatus,
                outcome,
                status: Some(status),
                code: None,
            }));
        }
        if media_type != "text/event-stream" {
            return Err(StreamError::Vendor(invalid_response()));
        }
        let mut body_reader = r.body;
        let stop_read = stop.clone();
        spawn_blocking_traced(move || {
            let (mut count, mut deltas, mut seg_len, mut segs, mut done) = (0, 0usize, 0usize, 0, false);
            let too_large = || StreamError::Vendor(VendorError::new(Reason::TooLarge, Outcome::Unknown));
            sse(
                &mut *body_reader,
                4 << 20,
                32 << 20,
                &stop_read,
                started,
                Duration::from_secs(900),
                &mut |event, data| {
                    count += 1;
                    if count > 100_000 {
                        return Err(too_large());
                    }
                    let bad = || StreamError::Vendor(invalid_response());
                    let parsed: WireTranscriptionSseEvent = serde_json::from_str(data).map_err(|_| bad())?;
                    if event != "message" && event != parsed.event_type() {
                        return Err(bad());
                    }
                    let next = match parsed {
                        WireTranscriptionSseEvent::TaskCreated { task_id } => {
                            if count != 1 || !audio_id(&task_id) {
                                return Err(bad());
                            }
                            TranscriptionEvent::TaskCreated(task_id)
                        }
                        WireTranscriptionSseEvent::TextDelta { delta } => {
                            deltas += delta.encode_utf16().count();
                            if deltas > 1 << 20 {
                                return Err(too_large());
                            }
                            TranscriptionEvent::Delta(delta)
                        }
                        WireTranscriptionSseEvent::SegmentDone {
                            content_index,
                            speaker,
                            text,
                            start,
                            end,
                            session_usage,
                        } => {
                            let segment = segment_of(speaker, text, start, end).ok_or_else(bad)?;
                            seg_len += segment.text.encode_utf16().count();
                            segs += 1;
                            if segs > 10000 || seg_len > 1 << 20 {
                                return Err(too_large());
                            }
                            TranscriptionEvent::Segment {
                                index: content_index,
                                segment,
                                usage: session_usage.and_then(usage_of),
                            }
                        }
                        WireTranscriptionSseEvent::TextDone { text, usage } => {
                            if text.encode_utf16().count() > 1 << 20 {
                                return Err(too_large());
                            }
                            done = true;
                            TranscriptionEvent::Done {
                                text,
                                usage: usage.and_then(usage_of),
                            }
                        }
                    };
                    tx.blocking_send(next).map_err(|_| StreamError::Mine("stopped".into()))?;
                    Ok(!done)
                },
            )?;
            if done { Ok(()) } else { Err(StreamError::Vendor(invalid_response())) }
        })
        .await
        .map_err(|_| StreamError::Mine("join error".into()))?
    }

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

    pub async fn understand(&self, key: &str, body: &Value, stop: &Stop) -> Result<MediaUnderstandingResult, VendorError> {
        let r = self
            .send(
                VendorCall {
                    key,
                    method: "POST",
                    path: "/responses",
                    body: json_body(body),
                    timeout: Duration::from_secs(180),
                    audio: false,
                    stop: Some(stop),
                },
                "application/json",
            )
            .await?;
        let status = r.status;
        let raw = read_body_async(r.body, 1 << 20, Some(stop.clone())).await?;
        if status != 200 {
            let outcome = if REJECTED.contains(&status) { Outcome::Rejected } else { Outcome::Unknown };
            return Err(VendorError {
                reason: Reason::HttpStatus,
                outcome,
                status: Some(status),
                code: None,
            });
        }
        let v: WireUnderstandingResponse = serde_json::from_slice(&raw).map_err(|_| invalid_response())?;
        let status = match v.status.as_str() {
            "completed" => MediaUnderstandingStatus::Completed,
            "incomplete" => MediaUnderstandingStatus::Incomplete,
            _ => return Err(invalid_response()),
        };
        if v.output.is_empty() || v.model.is_empty() || v.usage.input_tokens < 0 || v.usage.output_tokens < 0 || v.usage.total_tokens < 0 {
            return Err(invalid_response());
        }
        let mut texts = vec![];
        for item in v.output {
            if item.content.is_empty() {
                return Err(invalid_response());
            }
            for part in item.content {
                if part.kind != "output_text" {
                    return Err(invalid_response());
                }
                texts.push(part.text.ok_or_else(invalid_response)?);
            }
        }
        let cut = status == MediaUnderstandingStatus::Incomplete && v.incomplete_details.and_then(|d| d.reason).as_deref() == Some("max_output_tokens");
        Ok(MediaUnderstandingResult {
            model: v.model,
            text: texts.join("\n"),
            status,
            incomplete_reason: cut.then_some(MediaUnderstandingResultIncompleteReason::MaxOutputTokens),
            usage: MediaUnderstandingResultUsage {
                input_tokens: v.usage.input_tokens,
                output_tokens: v.usage.output_tokens,
                total_tokens: v.usage.total_tokens,
            },
        })
    }

    pub async fn upload(
        &self,
        key: &str,
        file: std::fs::File,
        size: i64,
        filename: &str,
        purpose: &str,
        stop: &Stop,
    ) -> Result<(String, Uploaded), VendorError> {
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
        let r: WireUploadedFile = self
            .call(VendorCall {
                key,
                method: "POST",
                path: "/files",
                body: Some(multipart(parts)),
                timeout: Duration::from_secs(300),
                audio: false,
                stop: Some(stop),
            })
            .await?;
        if !file_id_ok(&r.id) || r.object != "file" || r.bytes != size || r.purpose != purpose {
            return Err(invalid_response());
        }
        let state = match r.status.as_deref() {
            Some("processed" | "active") => Uploaded::Ready,
            Some("failed") => Uploaded::Rejected,
            _ => Uploaded::Unknown,
        };
        Ok((r.id, state))
    }

    pub async fn delete_file(&self, key: &str, id: &str) -> Result<(), VendorError> {
        if !file_id_ok(id) {
            return Err(invalid_input());
        }
        let path = format!("/files/{}", url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>());
        match self
            .call::<WireDeletedFile>(VendorCall {
                key,
                method: "DELETE",
                path: &path,
                body: None,
                timeout: Duration::from_secs(300),
                audio: false,
                stop: None,
            })
            .await
        {
            Ok(r) if r.id == id && r.deleted => Ok(()),
            Ok(_) => Err(invalid_response()),
            Err(e) if e.status == Some(404) => Ok(()),
            Err(e) => Err(e),
        }
    }

    pub async fn clone_voice(&self, key: &str, audio: Vec<u8>, filename: &str, name: Option<&str>, stop: &Stop) -> Result<MediaAudioVoice, VendorError> {
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
        let r: WireClonedVoice = self
            .call(VendorCall {
                key,
                method: "POST",
                path: "/audio/voices",
                body: Some(multipart(parts)),
                timeout: Duration::from_secs(300),
                audio: true,
                stop: Some(stop),
            })
            .await?;
        if !audio_id(&r.id) {
            return Err(invalid_response());
        }
        Ok(MediaAudioVoice {
            id: r.id,
            name: r.name,
            created_at_seconds: JsNumber(r.created_at as f64),
        })
    }
}

fn file_id_ok(id: &str) -> bool {
    code_points(id, 1, 256) && id != "." && id != ".." && !id.chars().any(|c| c.is_whitespace() || c.is_control() || "/\\?#".contains(c))
}

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
