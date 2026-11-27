//! MOSS Live's text frames as a call reads and writes them:
//! the one tool its model has (`ask_orchestrator`), the frames the farm says
//! to it, and whether it takes the account's key.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::prompt;
use crate::context::http::{Fetch, FetchError, Request, read_max};
use crate::log::spawn_blocking_traced;
use crate::setting::{MOSS, Secret};

pub const TOOL: &str = "ask_orchestrator";
/// A frame longer than this is not read for tool calls.
const FRAME_MAX: usize = 64 * 1024;
const QUESTION_MAX: usize = 16_000;
/// A commentary frame carries at most this many characters.
const COMMENTARY_CHARS: usize = 2000;

#[derive(Deserialize)]
struct Call {
    call_id: String,
    name: String,
    arguments: String,
}

#[derive(Deserialize)]
struct OutputItem {
    #[serde(rename = "type")]
    kind: String,
    status: String,
    #[serde(flatten)]
    call: Call,
}

#[derive(Deserialize)]
struct Done {
    status: String,
    output: Vec<OutputItem>,
}

#[derive(Deserialize)]
struct Item {
    #[serde(rename = "type")]
    kind: String,
    call_id: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Problem {
    Text(String),
    Object(serde::de::IgnoredAny),
}

#[derive(Deserialize)]
struct Updated {
    error: Option<Problem>,
}

/// A frame from MOSS, told apart by `action`; one of no interest is `Other`.
#[derive(Deserialize)]
#[serde(tag = "action")]
enum Said {
    #[serde(rename = "response.function_call_arguments.done")]
    CallDone { data: Call },
    #[serde(rename = "response.done")]
    ResponseDone { data: ResponseDone },
    #[serde(rename = "conversation.item.created")]
    ItemCreated { data: ItemCreated },
    #[serde(rename = "session.updated")]
    SessionUpdated { data: Option<Updated> },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct ResponseDone {
    response: Done,
}

#[derive(Deserialize)]
struct ItemCreated {
    item: Item,
}

#[derive(Deserialize)]
struct AskArguments {
    question: String,
}

fn said(raw: &str) -> Option<Said> {
    (raw.len() <= FRAME_MAX).then(|| serde_json::from_str(raw).ok()).flatten()
}

/// What the model asks of the orchestrator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCall {
    pub call_id: String,
    pub question: String,
}

/// The `ask_orchestrator` calls a frame finishes: the call's own event, or
/// a completed response listing them. Each call id once.
pub fn tool_calls(raw: &str) -> Vec<ToolCall> {
    let calls = match said(raw) {
        Some(Said::CallDone { data }) => vec![data],
        Some(Said::ResponseDone { data }) if data.response.status == "completed" => {
            let all = data.response.output;
            if all.iter().any(|o| o.kind != "function_call" || o.status != "completed") {
                return vec![];
            }
            all.into_iter().map(|o| o.call).collect()
        }
        _ => return vec![],
    };
    let mut seen = HashSet::new();
    let mut out = vec![];
    for call in calls {
        if call.name != TOOL || call.call_id.is_empty() || call.call_id.encode_utf16().count() > 256 || seen.contains(&call.call_id) {
            continue;
        }
        let Ok(arguments) = serde_json::from_str::<AskArguments>(&call.arguments) else {
            continue;
        };
        let question = arguments.question.trim().to_string();
        if question.is_empty() || question.encode_utf16().count() > QUESTION_MAX {
            continue;
        }
        seen.insert(call.call_id.clone());
        out.push(ToolCall {
            call_id: call.call_id,
            question,
        });
    }
    out
}

/// The call whose answer MOSS says it has taken.
pub fn tool_ack(raw: &str) -> Option<String> {
    match said(raw)? {
        Said::ItemCreated { data } if data.item.kind == "function_call_output" && !data.item.call_id.is_empty() => Some(data.item.call_id),
        _ => None,
    }
}

/// Whether MOSS took the session's settings: `session.updated` with an empty error.
pub fn session_updated(raw: &str) -> bool {
    matches!(said(raw), Some(Said::SessionUpdated { data: Some(Updated { error: Some(Problem::Text(e)) }) }) if e.is_empty())
}

#[derive(Serialize)]
struct Persona<'a> {
    prompt: &'a str,
}

#[derive(Serialize)]
struct Tool {
    #[serde(rename = "type")]
    kind: &'static str,
    name: &'static str,
    description: &'static str,
    parameters: ToolParameters,
}

#[derive(Serialize)]
struct ToolParameters {
    #[serde(rename = "type")]
    kind: &'static str,
    properties: ToolProperties,
    required: [&'static str; 1],
}

#[derive(Serialize)]
struct ToolProperties {
    question: ToolProperty,
}

#[derive(Serialize)]
struct ToolProperty {
    #[serde(rename = "type")]
    kind: &'static str,
    description: &'static str,
}

#[derive(Serialize)]
struct Session<'a> {
    persona: Persona<'a>,
    instructions: String,
    tools: Vec<Tool>,
}

#[derive(Serialize)]
struct CallIds<'a> {
    call_ids: [&'a str; 1],
}

#[derive(Serialize)]
struct Output<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    call_id: &'a str,
    output: &'a str,
}

#[derive(Serialize)]
#[serde(tag = "action")]
enum Saying<'a> {
    #[serde(rename = "session.update")]
    SessionUpdate { session: Session<'a> },
    #[serde(rename = "session.commentary.append")]
    Commentary {
        content: &'a str,
        status: &'static str,
        event_id: &'a str,
    },
    #[serde(rename = "response.create")]
    ResponseCreate { response: CallIds<'a> },
    #[serde(rename = "conversation.item.create")]
    ItemCreate { item: Output<'a> },
}

fn frame(saying: Saying) -> String {
    serde_json::to_string(&saying).unwrap_or_default()
}

/// The session's settings on a farm call: the persona, how to open, and the tool.
pub fn session_update(persona: &str, greeting: &str) -> String {
    frame(Saying::SessionUpdate {
        session: Session {
            persona: Persona { prompt: persona },
            instructions: prompt::moss_instructions(greeting),
            tools: vec![Tool {
                kind: "function",
                name: TOOL,
                description: prompt::ASK_ORCHESTRATOR,
                parameters: ToolParameters {
                    kind: "object",
                    properties: ToolProperties {
                        question: ToolProperty {
                            kind: "string",
                            description: prompt::ASK_ORCHESTRATOR_QUESTION,
                        },
                    },
                    required: ["question"],
                },
            }],
        },
    })
}

/// Session configuration for dictation-only ASR over MOSS Live (no tools).
pub fn asr_session_update() -> String {
    frame(Saying::SessionUpdate {
        session: Session {
            persona: Persona { prompt: prompt::ASR_PERSONA },
            instructions: prompt::ASR_INSTRUCTIONS.into(),
            tools: vec![],
        },
    })
}

/// Words for the model to tell the user, 2000 characters a frame; `id` names each frame.
pub fn commentary(piece: &str, mut id: impl FnMut() -> String) -> Vec<String> {
    let characters: Vec<char> = piece.trim().chars().collect();
    characters
        .chunks(COMMENTARY_CHARS)
        .map(|chunk| {
            let content: String = chunk.iter().collect();
            frame(Saying::Commentary {
                content: &content,
                status: "completed",
                event_id: &id(),
            })
        })
        .collect()
}

pub fn tool_output(call_id: &str, output: &str) -> String {
    frame(Saying::ItemCreate {
        item: Output {
            kind: "function_call_output",
            call_id,
            output,
        },
    })
}

/// Has the model go on with the answers of `call_id`.
pub fn response_create(call_id: &str) -> String {
    frame(Saying::ResponseCreate {
        response: CallIds { call_ids: [call_id] },
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Ok,
    Refused(String),
    Unreachable(String),
    Failed(String),
    Silent,
}

/// How MOSS Live is asked whether it takes a key; a test answers for it.
pub trait Realtime: Send + Sync {
    fn verify_async<'a>(&'a self, key: &'a Secret, model: &'a str) -> crate::BoxFuture<'a, Verdict>;
}

/// The realtime address asked over plain HTTPS with the key: 401 and 403
/// refuse it, any other answer below 500 has let the key in. No socket is
/// opened, no audio captured or sent.
pub struct HttpProbe(pub Arc<dyn Fetch>);

#[derive(Deserialize)]
struct ErrorBody {
    error: Option<ErrorMessage>,
}

#[derive(Deserialize)]
struct ErrorMessage {
    message: Option<String>,
}

fn parse_probe_response(key: &Secret, status: u16, body: Vec<u8>) -> Verdict {
    let safe = |text: &str| -> String { text.replace(key.expose(), "[redacted]").chars().take(200).collect() };
    match status {
        401 | 403 => {
            let said = serde_json::from_slice::<ErrorBody>(&body).ok().and_then(|b| b.error).and_then(|e| e.message);
            Verdict::Refused(safe(
                &said.filter(|m| !m.is_empty()).unwrap_or_else(|| String::from_utf8_lossy(&body).into_owned()),
            ))
        }
        status if status >= 500 => Verdict::Failed(format!("HTTP {status}")),
        _ => Verdict::Ok,
    }
}

impl Realtime for HttpProbe {
    fn verify_async<'a>(&'a self, key: &'a Secret, model: &'a str) -> crate::BoxFuture<'a, Verdict> {
        Box::pin(async move {
            let safe = |text: &str| -> String { text.replace(key.expose(), "[redacted]").chars().take(200).collect() };
            let answered = self
                .0
                .clone()
                .fetch_async(
                    Request {
                        method: "GET",
                        url: format!("{MOSS}/realtime?model={model}"),
                        headers: vec![("authorization".into(), format!("Bearer {}", key.expose()))],
                        body: None,
                        timeout: Duration::from_secs(8),
                    },
                    tokio_util::sync::CancellationToken::new(),
                )
                .await;
            let mut response = match answered {
                Ok(r) => r,
                Err(FetchError::Timeout) => return Verdict::Silent,
                Err(FetchError::Network(why)) => return Verdict::Unreachable(safe(&why)),
            };
            let body = if matches!(response.status, 401 | 403) {
                spawn_blocking_traced(move || read_max(&mut response.body, 1 << 16).unwrap_or_default())
                    .await
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            parse_probe_response(key, response.status, body)
        })
    }
}

/// Wraps signed 16-bit little-endian PCM bytes into a standard 44-byte RIFF/WAVE container.
pub fn pcm16_to_wav(pcm: &[u8], sample_rate: u32, channels: u16) -> Vec<u8> {
    let data_len = u32::try_from(pcm.len()).unwrap_or(u32::MAX);
    let block_align = channels.saturating_mul(2);
    let byte_rate = sample_rate.saturating_mul(u32::from(block_align));
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&data_len.saturating_add(36).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}

/// One-shot speech-to-text provider used by `Voice::transcribe_wav_async` for batch ASR fallback.
pub trait Transcriber: Send + Sync {
    fn transcribe_wav_async<'a>(&'a self, key: &'a Secret, model: &'a str, wav: Vec<u8>) -> crate::BoxFuture<'a, Result<String, String>>;
}

/// Uploads a short WAV clip via MOSS `/files` and transcribes it through `/audio/transcriptions`.
pub struct HttpTranscriber(pub Arc<dyn Fetch>);

#[derive(Deserialize)]
struct UploadedFile {
    id: String,
}

#[derive(Deserialize)]
struct TranscriptionReply {
    text: Option<String>,
    task_id: Option<String>,
}

#[derive(Deserialize)]
struct TranscriptionTask {
    status: String,
    text: Option<String>,
}

fn multipart_wav_body(wav: &[u8]) -> (String, Vec<u8>) {
    let boundary = format!("vv-asr-{}", uuid::Uuid::new_v4().simple());
    let mut body = Vec::with_capacity(wav.len() + 256);
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"purpose\"\r\n\r\naudio\r\n").as_bytes());
    body.extend_from_slice(
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"dictation.wav\"\r\nContent-Type: audio/wav\r\n\r\n").as_bytes(),
    );
    body.extend_from_slice(wav);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

impl HttpTranscriber {
    async fn send_async(
        &self,
        key: &Secret,
        method: &'static str,
        path: &str,
        body: Option<(String, Vec<u8>)>,
        timeout: Duration,
    ) -> Result<(u16, Vec<u8>), String> {
        let safe = |text: &str| text.replace(key.expose(), "[redacted]").chars().take(200).collect::<String>();
        let mut headers = vec![
            ("authorization".into(), format!("Bearer {}", key.expose())),
            ("accept".into(), "application/json".into()),
        ];
        let body = body.map(|(ct, bytes)| {
            headers.push(("content-type".into(), ct.clone()));
            (ct, Box::new(std::io::Cursor::new(bytes)) as Box<dyn std::io::Read + Send>)
        });
        let mut res = self
            .0
            .clone()
            .fetch_async(
                Request {
                    method,
                    url: format!("{MOSS}{path}"),
                    headers,
                    body,
                    timeout,
                },
                tokio_util::sync::CancellationToken::new(),
            )
            .await
            .map_err(|e| match e {
                FetchError::Timeout => "MOSS transcription timed out".to_string(),
                FetchError::Network(why) => safe(&why),
            })?;
        let status = res.status;
        let raw = spawn_blocking_traced(move || read_max(&mut res.body, 1 << 20).unwrap_or_default())
            .await
            .unwrap_or_default();
        if !(200..300).contains(&status) {
            let msg = serde_json::from_slice::<ErrorBody>(&raw)
                .ok()
                .and_then(|b| b.error)
                .and_then(|e| e.message)
                .filter(|m| !m.is_empty())
                .unwrap_or_else(|| format!("HTTP {status}"));
            return Err(safe(&msg));
        }
        Ok((status, raw))
    }
}

impl Transcriber for HttpTranscriber {
    fn transcribe_wav_async<'a>(&'a self, key: &'a Secret, model: &'a str, wav: Vec<u8>) -> crate::BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let upload_body = multipart_wav_body(&wav);
            let (_, upload_raw) = self.send_async(key, "POST", "/files", Some(upload_body), Duration::from_secs(30)).await?;
            let uploaded: UploadedFile = serde_json::from_slice(&upload_raw).map_err(|_| "invalid MOSS file response".to_string())?;
            let file_id = uploaded.id;
            let payload = serde_json::json!({
                "model": model,
                "file_id": file_id,
                "response_format": "json",
                "async": false,
                "stream": false
            })
            .to_string()
            .into_bytes();
            let result = async {
                let (_, tx_raw) = self
                    .send_async(
                        key,
                        "POST",
                        "/audio/transcriptions",
                        Some(("application/json".into(), payload)),
                        Duration::from_secs(60),
                    )
                    .await?;
                let reply: TranscriptionReply = serde_json::from_slice(&tx_raw).map_err(|_| "invalid MOSS transcription response".to_string())?;
                if let Some(text) = reply.text {
                    return Ok(text.trim().to_string());
                }
                let Some(task_id) = reply.task_id else {
                    return Err("MOSS transcription returned neither text nor task_id".into());
                };
                for attempt in 0..80 {
                    let wait = if attempt < 4 { 40 } else { 200 };
                    tokio::time::sleep(Duration::from_millis(wait)).await;
                    let (_, poll_raw) = self
                        .send_async(key, "GET", &format!("/audio/tasks/{task_id}"), None, Duration::from_secs(15))
                        .await?;
                    let task: TranscriptionTask = serde_json::from_slice(&poll_raw).map_err(|_| "invalid MOSS task response".to_string())?;
                    match task.status.as_str() {
                        "SUCCESS" => return Ok(task.text.unwrap_or_default().trim().to_string()),
                        "FAILED" => return Err("MOSS transcription failed".into()),
                        _ => {}
                    }
                }
                Err("MOSS transcription timed out".into())
            }
            .await;
            let _ = self
                .send_async(key, "DELETE", &format!("/files/{file_id}"), None, Duration::from_secs(10))
                .await;
            result
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn call(id: &str, name: &str, arguments: Value) -> Value {
        json!({ "call_id": id, "name": name, "arguments": arguments.to_string() })
    }

    #[test]
    fn a_tool_call_is_read_from_its_own_event_and_from_a_completed_response() {
        let event = json!({ "action": "response.function_call_arguments.done", "data": call("c1", TOOL, json!({ "question": " 现在有几张工单？ " })) });
        assert_eq!(
            tool_calls(&event.to_string()),
            [ToolCall {
                call_id: "c1".into(),
                question: "现在有几张工单？".into()
            }]
        );
        let item = |id: &str, name: &str| {
            let mut c = call(id, name, json!({ "question": "q" }));
            c["type"] = "function_call".into();
            c["status"] = "completed".into();
            c
        };
        let done = json!({ "action": "response.done", "data": { "response": { "status": "completed",
            "output": [item("c1", TOOL), item("c1", TOOL), item("c2", "other_tool"), item("c3", TOOL)] } } });
        let ids: Vec<String> = tool_calls(&done.to_string()).into_iter().map(|c| c.call_id).collect();
        assert_eq!(ids, ["c1", "c3"]);
    }

    #[test]
    fn a_call_that_is_not_whole_is_not_run() {
        let event = |c: Value| json!({ "action": "response.function_call_arguments.done", "data": c }).to_string();
        for bad in [
            event(call("", TOOL, json!({ "question": "q" }))),
            event(call(&"x".repeat(257), TOOL, json!({ "question": "q" }))),
            event(call("c1", TOOL, json!({ "question": "  " }))),
            event(call("c1", TOOL, json!({ "question": "q".repeat(16_001) }))),
            event(call("c1", TOOL, json!({ "ask": "q" }))),
            event(json!({ "call_id": "c1", "name": TOOL, "arguments": "not json" })),
            json!({ "action": "response.done", "data": { "response": { "status": "failed", "output": [] } } }).to_string(),
            json!({ "action": "response.done", "data": { "response": { "status": "completed",
                "output": [{ "type": "message", "status": "completed", "call_id": "c1", "name": TOOL, "arguments": "{\"question\":\"q\"}" }] } } })
            .to_string(),
            "not json".to_string(),
            format!("{}{}", event(call("c1", TOOL, json!({ "question": "q" }))), " ".repeat(FRAME_MAX)),
        ] {
            assert_eq!(tool_calls(&bad), [], "{}", &bad[..bad.len().min(120)]);
        }
    }

    #[test]
    fn an_answer_taken_and_settings_taken_are_recognised() {
        let ack = json!({ "action": "conversation.item.created", "data": { "item": { "type": "function_call_output", "call_id": "c1" } } });
        assert_eq!(tool_ack(&ack.to_string()), Some("c1".into()));
        let other = json!({ "action": "conversation.item.created", "data": { "item": { "type": "message", "call_id": "c1" } } });
        assert_eq!(tool_ack(&other.to_string()), None);
        assert!(session_updated(r#"{"action":"session.updated","data":{"error":""}}"#));
        assert!(!session_updated(r#"{"action":"session.updated","data":{"error":"bad tools"}}"#));
        assert!(!session_updated(r#"{"action":"session.updated","data":{"error":{"message":"x"}}}"#));
        assert!(!session_updated(r#"{"action":"session.updated","data":{}}"#));
    }

    #[test]
    fn the_farm_says_its_frames_as_moss_takes_them() {
        let update: Value = serde_json::from_str(&session_update("你是助手。", "来啦")).unwrap();
        assert_eq!(update["action"], "session.update");
        assert_eq!(update["session"]["persona"]["prompt"], "你是助手。");
        assert!(update["session"]["instructions"].as_str().unwrap().contains("ask_orchestrator"));
        assert_eq!(
            update["session"]["tools"][0],
            json!({ "type": "function", "name": "ask_orchestrator", "description": prompt::ASK_ORCHESTRATOR,
                "parameters": { "type": "object", "properties": { "question": { "type": "string", "description": prompt::ASK_ORCHESTRATOR_QUESTION } }, "required": ["question"] } })
        );
        let mut n = 0;
        let frames = commentary(&format!(" {} ", "字".repeat(4500)), || {
            n += 1;
            format!("brief-{n}")
        });
        let sizes: Vec<usize> = frames
            .iter()
            .map(|f| serde_json::from_str::<Value>(f).unwrap()["content"].as_str().unwrap().chars().count())
            .collect();
        assert_eq!(sizes, [2000, 2000, 500]);
        assert!(frames[2].contains(r#""status":"completed""#) && frames[2].contains(r#""event_id":"brief-3""#));
        assert_eq!(
            tool_output("c1", "三张"),
            r#"{"action":"conversation.item.create","item":{"type":"function_call_output","call_id":"c1","output":"三张"}}"#
        );
        assert_eq!(response_create("c1"), r#"{"action":"response.create","response":{"call_ids":["c1"]}}"#);
    }

    #[tokio::test]
    async fn the_key_is_asked_over_https_without_opening_a_session() {
        use crate::context::http::Response;
        let probe = |answer: Result<(u16, &'static str), FetchError>| async move {
            let answer = parking_lot::Mutex::new(Some(answer));
            HttpProbe(Arc::new(move |r: Request| {
                assert_eq!(r.url, "https://api.mosi.cn/v1/realtime?model=moss-live-1.0");
                answer.lock().take().unwrap().map(|(status, body)| Response {
                    status,
                    headers: vec![],
                    body: Box::new(std::io::Cursor::new(body.as_bytes().to_vec())),
                })
            }))
            .verify_async(&Secret::new("test-key"), "moss-live-1.0")
            .await
        };
        assert_eq!(probe(Ok((426, ""))).await, Verdict::Ok);
        assert_eq!(
            probe(Ok((401, r#"{"error":{"message":"invalid key test-key"}}"#))).await,
            Verdict::Refused("invalid key [redacted]".into())
        );
        assert_eq!(probe(Ok((503, ""))).await, Verdict::Failed("HTTP 503".into()));
        assert_eq!(probe(Err(FetchError::Timeout)).await, Verdict::Silent);
        assert_eq!(probe(Err(FetchError::Network("dns".into()))).await, Verdict::Unreachable("dns".into()));
    }

    #[tokio::test]
    async fn asr_session_update_has_no_tools_and_transcriber_round_trips_wav() {
        let update: Value = serde_json::from_str(&asr_session_update()).unwrap();
        assert_eq!(update["action"], "session.update");
        assert_eq!(update["session"]["tools"], json!([]));
        let wav = pcm16_to_wav(&[1, 0, 2, 0], 16_000, 1);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(wav.len(), 48);

        let (vendor, _) = crate::fake::moss::network();
        let text = HttpTranscriber(vendor)
            .transcribe_wav_async(&Secret::new("test-key"), "moss-transcribe-1.0", wav)
            .await
            .unwrap();
        assert_eq!(text, "First synthetic speaker. Second synthetic speaker.");
    }
}
