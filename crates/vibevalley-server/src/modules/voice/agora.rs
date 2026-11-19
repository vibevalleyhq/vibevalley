//! Agora's Conversational AI agent over REST (what the `agora-agents` SDK
//! sent for `gateway/voice/agora-vendors.ts`): the join request built from
//! the voice settings, the agent asked to speak and to leave. Every call is
//! signed with a token of its own; 408, 429 and 5xx are tried twice more.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, ApiErrorDetail, Area, BizCode, JsNumber, Language, Model, VoiceASR, VoiceAnswer, VoiceAnswerAgoraModel, VoiceFix, VoiceSettings, VoiceTTS,
    VoiceTTSMinimaxModel,
};

use super::token::{self, BadCredentials, Issue};
use crate::modules::media::vendor::{Fetch, FetchError, Request, read_max};
use crate::modules::setting::Secret;

/// The agent's uid in every call's channel.
pub const AGENT_UID: &str = "123456";
/// How long a grant and the agent's own token last.
pub const TOKEN_SECONDS: u32 = 3600;
/// A REST call's token, as the SDK signs it.
const REST_TOKEN_SECONDS: u32 = 86_400;
const DEEPSEEK_CHAT: &str = "https://api.deepseek.com/chat/completions";
/// The model the voice line answers as.
pub const ORCHESTRATOR_MODEL: &str = "vibevalley-orchestrator";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credentials {
    pub app_id: String,
    pub certificate: Secret,
}

/// The keys of the vendors that need their own.
#[derive(Debug, Clone, Default)]
pub struct VendorKeys {
    pub asr: Secret,
    pub llm: Secret,
    pub tts: Secret,
    pub deepseek: Secret,
}

/// A call's own way in to the orchestrator: an address and its key.
#[derive(Debug, Clone)]
pub struct CallLine {
    pub id: String,
    pub url: String,
    pub key: Secret,
}

/// `unavailable`: `settings` is the Settings section that fixes it.
pub fn unavailable(reason: impl Into<String>, settings: Option<VoiceFix>) -> ApiError {
    ApiError {
        biz_code: BizCode::VoiceUnavailable,
        message: reason.into(),
        detail: ApiErrorDetail { next: None, settings },
    }
}

pub fn failed(reason: impl Into<String>) -> ApiError {
    ApiError::new(BizCode::VoiceCallFailed, reason)
}

// ----- the join request -----

#[derive(Debug, Serialize)]
pub struct Join {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    pub properties: Properties,
}

#[derive(Debug, Serialize)]
pub struct Properties {
    pub channel: String,
    pub token: String,
    pub agent_rtc_uid: &'static str,
    pub remote_rtc_uids: Vec<String>,
    pub idle_timeout: JsNumber,
    advanced_features: AdvancedFeatures,
    parameters: Parameters,
    turn_detection: TurnDetection,
    pub llm: Llm,
    tts: Tts,
    asr: Asr,
}

#[derive(Debug, Serialize)]
struct AdvancedFeatures {
    enable_rtm: bool,
    enable_tools: bool,
}

/// Captions go over the RTC data stream: the client has no RTM.
#[derive(Debug, Serialize)]
struct Parameters {
    audio_scenario: &'static str,
    data_channel: &'static str,
    enable_error_message: bool,
    enable_metrics: bool,
}

#[derive(Debug, Serialize)]
struct TurnDetection {
    language: Language,
    config: TurnConfig,
}

#[derive(Debug, Serialize)]
struct TurnConfig {
    speech_threshold: f64,
    start_of_speech: Vad<StartVad>,
    end_of_speech: Vad<EndVad>,
}

#[derive(Debug, Serialize)]
struct Vad<C> {
    mode: &'static str,
    vad_config: C,
}

#[derive(Debug, Serialize)]
struct StartVad {
    interrupt_duration_ms: i64,
    prefix_padding_ms: i64,
}

#[derive(Debug, Serialize)]
struct EndVad {
    silence_duration_ms: i64,
}

#[derive(Debug, Serialize)]
pub struct Llm {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    params: LlmParams,
    max_history: i64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    system_messages: Vec<SystemMessage>,
    pub greeting_message: String,
    failure_message: String,
    input_modalities: [&'static str; 1],
    style: &'static str,
}

#[derive(Debug, Serialize)]
struct LlmParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    max_tokens: i64,
    temperature: f64,
    top_p: f64,
}

#[derive(Debug, Serialize)]
struct SystemMessage {
    role: &'static str,
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "vendor", rename_all = "lowercase")]
enum Tts {
    Minimax { params: MinimaxParams },
    Openai { params: OpenaiTtsParams },
    Microsoft { params: MicrosoftTtsParams },
}

#[derive(Debug, Serialize)]
struct MinimaxParams {
    voice_setting: MinimaxVoice,
}

#[derive(Debug, Serialize)]
struct MinimaxVoice {
    voice_id: String,
}

#[derive(Debug, Serialize)]
struct OpenaiTtsParams {
    voice: vibevalley_protocol::Voice,
}

#[derive(Debug, Serialize)]
struct MicrosoftTtsParams {
    key: String,
    region: String,
    voice_name: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "vendor", rename_all = "lowercase")]
enum Asr {
    Ares { language: Language },
    Deepgram { params: DeepgramParams, language: Language },
    Microsoft { params: MicrosoftAsrParams, language: Language },
}

#[derive(Debug, Serialize)]
struct DeepgramParams {
    language: Language,
}

#[derive(Debug, Serialize)]
struct MicrosoftAsrParams {
    key: String,
    region: String,
    language: Language,
}

/// Who joins where: the session's name, the channel, the agent's token and
/// the one user it listens to.
pub struct Joining<'a> {
    pub name: &'a str,
    pub channel: &'a str,
    pub token: &'a Secret,
    pub user_uid: &'a str,
}

/// `buildVendors` and the SDK's presets: the request for the three vendors
/// the voice page chose, or which key is missing. A vendor Agora hosts is
/// named by its preset and needs no key.
pub fn join(voice: &VoiceSettings, keys: &VendorKeys, line: Option<&CallLine>, joining: &Joining) -> Result<Join, ApiError> {
    let mut presets: Vec<&'static str> = vec![];
    let language = voice.language;
    let asr = match &voice.asr {
        VoiceASR::Ares(_) => Asr::Ares { language },
        VoiceASR::Deepgram(d) => {
            presets.push(match d.model {
                Model::Nova2 => "deepgram_nova_2",
                Model::Nova3 => "deepgram_nova_3",
            });
            Asr::Deepgram {
                params: DeepgramParams { language },
                language,
            }
        }
        VoiceASR::Microsoft(m) => {
            if keys.asr.is_empty() {
                return Err(unavailable(t("server.voice.noAsrKey", &[]), Some(VoiceFix::Call)));
            }
            Asr::Microsoft {
                params: MicrosoftAsrParams {
                    key: keys.asr.expose().into(),
                    region: m.region.clone(),
                    language,
                },
                language,
            }
        }
    };
    let (url, api_key, model) = match &voice.answer {
        VoiceAnswer::Orchestrator(_) | VoiceAnswer::Moss(_) => {
            let line = line.ok_or_else(|| unavailable(t("server.voice.noLine", &[]), None))?;
            (
                Some(line.url.clone()),
                Some(line.key.expose().to_string()),
                Some(ORCHESTRATOR_MODEL.to_string()),
            )
        }
        VoiceAnswer::Agora(a) => {
            presets.push(match a.model {
                VoiceAnswerAgoraModel::Gpt4oMini => "openai_gpt_4o_mini",
                VoiceAnswerAgoraModel::Gpt41Mini => "openai_gpt_4_1_mini",
                VoiceAnswerAgoraModel::Gpt5Nano => "openai_gpt_5_nano",
                VoiceAnswerAgoraModel::Gpt5Mini => "openai_gpt_5_mini",
            });
            (None, None, None)
        }
        VoiceAnswer::Deepseek(d) => {
            if keys.deepseek.is_empty() {
                return Err(unavailable(t("server.voice.noDeepseekKey", &[]), Some(VoiceFix::Models)));
            }
            (Some(DEEPSEEK_CHAT.to_string()), Some(keys.deepseek.expose().to_string()), Some(d.model.clone()))
        }
        VoiceAnswer::Openai(o) => {
            if keys.llm.is_empty() {
                return Err(unavailable(t("server.voice.noLlmKey", &[]), Some(VoiceFix::Call)));
            }
            (Some(o.url.clone()), Some(keys.llm.expose().to_string()), Some(o.model.clone()))
        }
    };
    let tts = match &voice.tts {
        VoiceTTS::Minimax(m) => {
            presets.push(match m.model {
                VoiceTTSMinimaxModel::Speech26Turbo => "minimax_speech_2_6_turbo",
                VoiceTTSMinimaxModel::Speech28Turbo => "minimax_speech_2_8_turbo",
            });
            Tts::Minimax {
                params: MinimaxParams {
                    voice_setting: MinimaxVoice { voice_id: m.voice_id.clone() },
                },
            }
        }
        VoiceTTS::Openai(o) => {
            presets.push("openai_tts_1");
            Tts::Openai {
                params: OpenaiTtsParams { voice: o.voice },
            }
        }
        VoiceTTS::Microsoft(m) => {
            if keys.tts.is_empty() {
                return Err(unavailable(t("server.voice.noTtsKey", &[]), Some(VoiceFix::Call)));
            }
            Tts::Microsoft {
                params: MicrosoftTtsParams {
                    key: keys.tts.expose().into(),
                    region: m.region.clone(),
                    voice_name: m.voice_name.clone(),
                },
            }
        }
    };
    let system_messages = if voice.persona.is_empty() {
        vec![]
    } else {
        vec![SystemMessage {
            role: "system",
            content: voice.persona.clone(),
        }]
    };
    Ok(Join {
        name: joining.name.into(),
        preset: (!presets.is_empty()).then(|| presets.join(",")),
        properties: Properties {
            channel: joining.channel.into(),
            token: joining.token.expose().into(),
            agent_rtc_uid: AGENT_UID,
            remote_rtc_uids: vec![joining.user_uid.into()],
            idle_timeout: voice.idle_seconds,
            advanced_features: AdvancedFeatures {
                enable_rtm: false,
                enable_tools: true,
            },
            parameters: Parameters {
                audio_scenario: "chorus",
                data_channel: "datastream",
                enable_error_message: true,
                enable_metrics: true,
            },
            turn_detection: TurnDetection {
                language,
                config: TurnConfig {
                    speech_threshold: 0.5,
                    start_of_speech: Vad {
                        mode: "vad",
                        vad_config: StartVad {
                            interrupt_duration_ms: voice.interrupt_ms,
                            prefix_padding_ms: 300,
                        },
                    },
                    end_of_speech: Vad {
                        mode: "vad",
                        vad_config: EndVad {
                            silence_duration_ms: voice.silence_ms,
                        },
                    },
                },
            },
            llm: Llm {
                url,
                api_key,
                params: LlmParams {
                    model,
                    max_tokens: 512,
                    temperature: 0.7,
                    top_p: 0.95,
                },
                max_history: 15,
                system_messages,
                greeting_message: voice.greeting.clone(),
                failure_message: voice.failure_message.clone(),
                input_modalities: ["text"],
                style: "openai",
            },
            tts,
            asr,
        },
    })
}

// ----- the REST calls -----

/// The first region of each area, on the area's own domain.
pub fn base_url(area: Area) -> &'static str {
    match area {
        Area::US => "https://api-us-west-1.agora.io/api/conversational-ai-agent",
        Area::EU => "https://api-eu-west-1.agora.io/api/conversational-ai-agent",
        Area::AP => "https://api-ap-southeast-1.agora.io/api/conversational-ai-agent",
        Area::CN => "https://api-cn-east-1.sd-rtn.com/cn/api/conversational-ai-agent",
    }
}

/// A call to Agora that did not go: its status when it answered, and what it said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgoraError {
    pub status: Option<u16>,
    pub message: String,
}

impl std::fmt::Display for AgoraError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status {
            Some(s) => write!(f, "HTTP {s}: {}", self.message),
            None => f.write_str(&self.message),
        }
    }
}

impl From<BadCredentials> for AgoraError {
    fn from(e: BadCredentials) -> AgoraError {
        AgoraError {
            status: None,
            message: e.to_string(),
        }
    }
}

#[derive(Deserialize)]
struct Started {
    #[serde(default)]
    agent_id: String,
}

#[derive(Deserialize, Default)]
struct Refusal {
    #[serde(default)]
    detail: Option<String>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Serialize)]
struct Speak<'a> {
    text: &'a str,
    priority: &'static str,
    interruptable: bool,
}

/// How a retry waits; a test moves through it.
pub type Pause = Arc<dyn Fn(Duration) + Send + Sync>;

pub struct Client {
    pub fetch: Arc<dyn Fetch>,
    pub credentials: Credentials,
    pub area: Area,
    pub pause: Pause,
}

fn retryable(status: u16) -> bool {
    status == 408 || status == 429 || status >= 500
}

impl Client {
    fn authorization(&self, channel: &str, account: &str) -> Result<String, AgoraError> {
        let c = &self.credentials;
        let token = token::rtc_with_rtm(&c.app_id, &c.certificate, channel, account, REST_TOKEN_SECONDS, Issue::now())?;
        Ok(format!("agora token={}", token.expose()))
    }

    /// One POST, tried again twice on 408, 429 and 5xx: after what
    /// `Retry-After` says (a minute at most), else 1 s then 2 s.
    fn post(&self, path: &str, authorization: String, body: String) -> Result<Vec<u8>, AgoraError> {
        let url = format!("{}/v2/projects/{}/{path}", base_url(self.area), self.credentials.app_id);
        let mut attempt = 1;
        loop {
            let mut response = self
                .fetch
                .fetch(Request {
                    method: "POST",
                    url: url.clone(),
                    headers: vec![("authorization".into(), authorization.clone())],
                    body: Some(("application/json".into(), Box::new(std::io::Cursor::new(body.clone().into_bytes())))),
                    timeout: Duration::from_secs(60),
                })
                .map_err(|e| AgoraError {
                    status: None,
                    message: match e {
                        FetchError::Timeout => "timed out".into(),
                        FetchError::Network(why) => why,
                    },
                })?;
            if attempt <= 2 && retryable(response.status) {
                let after = response.header("retry-after").and_then(|s| s.trim().parse::<f64>().ok()).filter(|s| *s > 0.0);
                (self.pause)(match after {
                    Some(seconds) => Duration::from_secs_f64(seconds.min(60.0)),
                    None => Duration::from_secs(1 << (attempt - 1)),
                });
                attempt += 1;
                continue;
            }
            let bytes = read_max(&mut response.body, 1 << 20, None).unwrap_or_default();
            if (200..300).contains(&response.status) {
                return Ok(bytes);
            }
            let said: Refusal = serde_json::from_slice(&bytes).unwrap_or_default();
            let raw: String = String::from_utf8_lossy(&bytes).trim().chars().take(200).collect();
            return Err(AgoraError {
                status: Some(response.status),
                message: said.detail.or(said.reason).or(said.message).unwrap_or(raw),
            });
        }
    }

    /// Asks the agent into the channel; its id.
    pub fn start(&self, request: &Join) -> Result<String, AgoraError> {
        let auth = self.authorization(&request.properties.channel, AGENT_UID)?;
        let body = serde_json::to_string(request).unwrap_or_default();
        let answered = self.post("join", auth, body)?;
        let started: Started = serde_json::from_slice(&answered).map_err(|e| AgoraError {
            status: None,
            message: e.to_string(),
        })?;
        Ok(started.agent_id)
    }

    /// Has the agent say `text` after what it is saying, without cutting the user off.
    pub fn speak(&self, channel: &str, agent: &str, text: &str) -> Result<(), AgoraError> {
        let auth = self.authorization(channel, AGENT_UID)?;
        let body = serde_json::to_string(&Speak {
            text,
            priority: "APPEND",
            interruptable: true,
        })
        .unwrap_or_default();
        self.post(&format!("agents/{agent}/speak"), auth, body).map(|_| ())
    }

    /// Asks the agent to leave; one already gone or leaving has left.
    pub fn stop(&self, agent: &str) -> Result<(), AgoraError> {
        let auth = self.authorization("stop", "0")?;
        match self.post(&format!("agents/{agent}/leave"), auth, "{}".into()) {
            Err(e) if e.status == Some(404) || e.message.to_lowercase().contains("already in the process of shutting down") => Ok(()),
            other => other.map(|_| ()),
        }
    }
}

/// Agora reads out at most 512 bytes at a time: the words in pieces under
/// `max`, cut after a sentence where one ends.
pub fn speak_pieces(text: &str, max: usize) -> Vec<String> {
    let mut out = vec![];
    let mut rest: Vec<char> = text.trim().chars().collect();
    while !rest.is_empty() {
        let bytes: usize = rest.iter().map(|c| c.len_utf8()).sum();
        if bytes <= max {
            out.push(rest.iter().collect::<String>());
            break;
        }
        let mut fit = 0;
        let mut used = 0;
        for c in &rest {
            if used + c.len_utf8() > max {
                break;
            }
            used += c.len_utf8();
            fit += 1;
        }
        let end = rest[..fit].iter().rposition(|c| "。！？!?；;\n".contains(*c)).filter(|i| *i > 0);
        // A single character wider than `max` still goes, alone.
        let cut = end.map(|i| i + 1).unwrap_or(fit).max(1);
        let piece: String = rest[..cut].iter().collect();
        out.push(piece.trim().to_string());
        let left: String = rest[cut..].iter().collect();
        rest = left.trim().chars().collect();
    }
    out.retain(|p| !p.is_empty());
    out
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::Value;

    use super::*;
    use crate::modules::media::vendor::Response;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Case {
        name: String,
        voice: VoiceSettings,
        keys: CaseKeys,
        deepseek_key: Option<String>,
        line: Option<CaseLine>,
        request: Value,
        request_url: String,
    }

    #[derive(Deserialize, Default)]
    #[serde(rename_all = "camelCase")]
    struct CaseKeys {
        asr_key: Option<String>,
        llm_key: Option<String>,
        tts_key: Option<String>,
    }

    #[derive(Deserialize)]
    struct CaseLine {
        id: String,
        url: String,
        key: String,
    }

    fn cases() -> Vec<Case> {
        serde_json::from_str(include_str!("../../../tests/fixtures/voice-requests.json")).unwrap()
    }

    /// A status, its headers and its body.
    type Answered = (u16, Vec<(&'static str, &'static str)>, &'static str);
    /// Each request's call, `Authorization` and body.
    type Asked = Arc<Mutex<Vec<(String, String, String)>>>;

    fn answering(answers: Vec<Answered>) -> (Arc<dyn Fetch>, Asked) {
        let seen = Arc::new(Mutex::new(vec![]));
        let (s, left) = (seen.clone(), Mutex::new(std::collections::VecDeque::from(answers)));
        let fetch: Arc<dyn Fetch> = Arc::new(move |r: Request| {
            let mut body = String::new();
            if let Some((_, mut b)) = r.body {
                std::io::Read::read_to_string(&mut b, &mut body).unwrap();
            }
            let auth = r.headers.iter().find(|(k, _)| k == "authorization").map(|(_, v)| v.clone()).unwrap_or_default();
            s.lock().unwrap().push((format!("{} {}", r.method, r.url), auth, body));
            let (status, headers, text) = left.lock().unwrap().pop_front().unwrap_or((200, vec![], r#"{"agent_id":"parity-agent"}"#));
            Ok(Response {
                status,
                headers: headers.into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
                body: Box::new(std::io::Cursor::new(text.as_bytes().to_vec())),
            })
        });
        (fetch, seen)
    }

    fn client(fetch: Arc<dyn Fetch>, area: Area, waits: Arc<Mutex<Vec<Duration>>>) -> Client {
        Client {
            fetch,
            credentials: Credentials {
                app_id: "11111111111111111111111111111111".into(),
                certificate: Secret::new("22222222222222222222222222222222"),
            },
            area,
            pause: Arc::new(move |d| waits.lock().unwrap().push(d)),
        }
    }

    #[test]
    fn the_agent_is_asked_in_as_the_sdk_asked_agora() {
        vibevalley_i18n::set_locale("zh");
        for c in cases() {
            let keys = VendorKeys {
                asr: Secret::new(c.keys.asr_key.clone().unwrap_or_default()),
                llm: Secret::new(c.keys.llm_key.clone().unwrap_or_default()),
                tts: Secret::new(c.keys.tts_key.clone().unwrap_or_default()),
                deepseek: Secret::new(c.deepseek_key.clone().unwrap_or_default()),
            };
            let line = c.line.as_ref().map(|l| CallLine {
                id: l.id.clone(),
                url: l.url.clone(),
                key: Secret::new(l.key.clone()),
            });
            let token = Secret::new("parity-token");
            let request = join(
                &c.voice,
                &keys,
                line.as_ref(),
                &Joining {
                    name: "parity",
                    channel: "parity-channel",
                    token: &token,
                    user_uid: "10001",
                },
            )
            .unwrap();
            let (fetch, seen) = answering(vec![]);
            let agent = client(fetch, c.voice.area, Arc::default()).start(&request).unwrap();
            assert_eq!(agent, "parity-agent");
            let seen = seen.lock().unwrap();
            assert_eq!(seen[0].0, format!("POST {}", c.request_url), "{}", c.name);
            assert!(seen[0].1.starts_with("agora token=007"), "{}", c.name);
            assert_eq!(serde_json::from_str::<Value>(&seen[0].2).unwrap(), c.request, "{}", c.name);
        }
    }

    #[test]
    fn a_missing_key_says_which_and_where_to_fix_it() {
        vibevalley_i18n::set_locale("zh");
        let mut voice = cases().remove(0).voice;
        let token = Secret::new("t");
        let joining = Joining {
            name: "n",
            channel: "c",
            token: &token,
            user_uid: "1",
        };
        let problem = |v: &VoiceSettings, keys: &VendorKeys| join(v, keys, None, &joining).err().map(|e| (e.message, e.detail.settings));
        let none = VendorKeys::default();
        assert_eq!(problem(&voice, &none), None);
        voice.answer = serde_json::from_str(r#"{"vendor":"orchestrator"}"#).unwrap();
        assert_eq!(problem(&voice, &none), Some(("助手的语音线路没接通".into(), None)));
        voice.answer = serde_json::from_str(r#"{"vendor":"deepseek","model":"deepseek-chat"}"#).unwrap();
        assert_eq!(problem(&voice, &none).unwrap().1, Some(VoiceFix::Models));
        let with_deepseek = VendorKeys {
            deepseek: Secret::new("sk-x"),
            ..VendorKeys::default()
        };
        assert_eq!(problem(&voice, &with_deepseek), None);
        voice.asr = serde_json::from_str(r#"{"vendor":"microsoft","region":"eastasia"}"#).unwrap();
        let (message, fix) = problem(&voice, &with_deepseek).unwrap();
        assert!(message.contains("识别") && fix == Some(VoiceFix::Call), "{message}");
    }

    #[test]
    fn a_busy_answer_is_asked_twice_more_and_nothing_else_is() {
        let waits = Arc::new(Mutex::new(vec![]));
        let (fetch, seen) = answering(vec![(503, vec![], "{}"), (502, vec![], "{}"), (200, vec![], "{}")]);
        client(fetch, Area::US, waits.clone()).speak("c", "a1", "hi").unwrap();
        assert_eq!(*waits.lock().unwrap(), [Duration::from_secs(1), Duration::from_secs(2)]);
        assert_eq!(seen.lock().unwrap().len(), 3);
        assert!(seen.lock().unwrap()[0].0.ends_with("/agents/a1/speak"));
        assert_eq!(seen.lock().unwrap()[0].2, r#"{"text":"hi","priority":"APPEND","interruptable":true}"#);

        waits.lock().unwrap().clear();
        let (fetch, _) = answering(vec![(429, vec![("Retry-After", "5")], "{}"), (200, vec![], "{}")]);
        client(fetch, Area::US, waits.clone()).speak("c", "a1", "hi").unwrap();
        assert_eq!(*waits.lock().unwrap(), [Duration::from_secs(5)]);

        let (fetch, seen) = answering(vec![(400, vec![], r#"{"detail":"boom"}"#)]);
        let refused = client(fetch, Area::US, waits.clone()).speak("c", "a1", "hi").unwrap_err();
        assert_eq!((refused.status, refused.message.as_str(), seen.lock().unwrap().len()), (Some(400), "boom", 1));

        let (fetch, seen) = answering(vec![(500, vec![], "{}"), (500, vec![], "{}"), (500, vec![], "down")]);
        let down = client(fetch, Area::US, waits).speak("c", "a1", "hi").unwrap_err();
        assert_eq!((down.status, down.message.as_str(), seen.lock().unwrap().len()), (Some(500), "down", 3));
    }

    #[test]
    fn an_agent_already_gone_or_leaving_has_left() {
        let (fetch, seen) = answering(vec![
            (400, vec![], r#"{"detail":"Agent is already in the process of shutting down"}"#),
            (404, vec![], "{}"),
            (403, vec![], r#"{"detail":"boom"}"#),
        ]);
        let c = client(fetch, Area::CN, Arc::default());
        assert_eq!(c.stop("a1"), Ok(()));
        assert_eq!(c.stop("a1"), Ok(()));
        assert_eq!(c.stop("a1").unwrap_err().status, Some(403));
        assert_eq!(
            seen.lock().unwrap()[0].0,
            "POST https://api-cn-east-1.sd-rtn.com/cn/api/conversational-ai-agent/v2/projects/11111111111111111111111111111111/agents/a1/leave"
        );
    }

    #[test]
    fn words_are_cut_under_agoras_512_bytes_at_a_sentences_end() {
        assert_eq!(speak_pieces("  好的。  ", 480), ["好的。"]);
        let long = format!("{}。{}", "一".repeat(100), "二".repeat(100));
        let pieces = speak_pieces(&long, 480);
        assert_eq!(pieces, [format!("{}。", "一".repeat(100)), "二".repeat(100)]);
        let unbroken = "啊".repeat(400);
        let pieces = speak_pieces(&unbroken, 480);
        assert!(pieces.iter().all(|p| p.len() <= 480));
        assert_eq!(pieces.concat(), unbroken);
        assert!(speak_pieces("   ", 480).is_empty());
    }
}
