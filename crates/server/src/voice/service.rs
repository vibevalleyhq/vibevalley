use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use parking_lot::Mutex;
use tokio::sync::mpsc;
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, ApiErrorDetail, BizCode, Millis, NoticeLevel, Validation, VoiceCall, VoiceFix, VoiceGrant};

use super::moss::{self, HttpTranscriber, Realtime, Transcriber, Verdict};
use crate::context::api::LiveVoiceLine;
use crate::context::{Context, now};
use crate::setting::{Account, Secret, Setting, Use};

/// How long an unused grant stays valid before expiring.
const GRANT_TTL_SECONDS: Millis = 3600;
/// What a MOSS call holds for its model until the session takes its settings.
const MOSS_PENDING_MAX: usize = 8;
const MOSS_PIECE_MAX: usize = 16_000;
/// The tool calls one MOSS session may make, and at once.
const MOSS_TOOL_CALLS: usize = 64;
const MOSS_TOOLS_AT_ONCE: usize = 4;
/// Bounded outbound frame queue capacity for MOSS Live socket delivery.
const MOSS_OUTGOING_CAP: usize = 256;
/// Bounded inbound MOSS Live tool-call queue capacity.
const MOSS_TOOL_QUEUE_CAP: usize = 64;

fn unavailable(reason: impl Into<String>, settings: Option<VoiceFix>) -> ApiError {
    ApiError {
        biz_code: BizCode::VoiceUnavailable,
        message: reason.into(),
        detail: ApiErrorDetail { next: None, settings },
    }
}

pub(crate) fn failed(reason: impl Into<String>) -> ApiError {
    ApiError::new(BizCode::VoiceCallFailed, reason)
}

/// Dependencies for constructing pure [`Voice`].
pub struct Parts {
    pub ctx: Arc<Context>,
    pub setting: Arc<Setting>,
    /// Optional MOSS Live key probe override (tests).
    pub realtime: Option<Arc<dyn Realtime>>,
    /// Optional MOSS transcription client override (tests).
    pub transcriber: Option<Arc<dyn Transcriber>>,
}

#[derive(Clone, PartialEq)]
enum GrantPhase {
    Issued,
    Starting,
    On,
}

struct Grant {
    expires: Millis,
    phase: GrantPhase,
}

/// A MOSS call's way to its model: shared by the call and the host's line,
/// whichever comes first.
#[derive(Default)]
struct MossShared {
    phase: Mutex<MossPhase>,
}

enum MossPhase {
    /// Commentary waits in `pending` until the session takes its settings.
    Waiting {
        out: Option<mpsc::Sender<String>>,
        pending: Vec<String>,
    },
    Ready {
        out: mpsc::Sender<String>,
    },
    Closed,
}

impl Default for MossPhase {
    fn default() -> MossPhase {
        MossPhase::Waiting { out: None, pending: vec![] }
    }
}

struct Call {
    moss: Arc<MossShared>,
    grant: GrantKey,
    greeting: String,
    hung_up: AtomicBool,
}

type GrantKey = (String, String);

#[derive(Default)]
struct State {
    grants: HashMap<GrantKey, Grant>,
    calls: HashMap<String, Arc<Call>>,
    moss: Option<Arc<MossShared>>,
    live_line: bool,
    stopped: bool,
}

/// Inbound MOSS Live tool call emitted by [`MossLine`] for orchestration handling.
pub struct MossToolRequest {
    pub call_id: String,
    pub question: String,
    shared: Arc<MossShared>,
    tools: Arc<Mutex<Tools>>,
    out: mpsc::Sender<String>,
}

impl MossToolRequest {
    /// Sends the orchestrator's answer back onto the active MOSS Live socket.
    pub fn respond(self, answer: &str) {
        let answer = if answer.is_empty() {
            t("server.voice.moss.toolFailed", &[])
        } else {
            answer.to_string()
        };
        let mut tools = self.tools.lock();
        tools.in_flight = tools.in_flight.saturating_sub(1);
        if matches!(*self.shared.phase.lock(), MossPhase::Closed) {
            return;
        }
        tools.awaiting_ack.insert(self.call_id.clone());
        let _ = self.out.try_send(moss::tool_output(&self.call_id, &answer));
    }
}

pub struct Voice {
    ctx: Arc<Context>,
    setting: Arc<Setting>,
    realtime: Arc<dyn Realtime>,
    transcriber: Arc<dyn Transcriber>,
    state: Mutex<State>,
    commentary: AtomicU64,
}

/// A uniform draw below `n`.
fn random_below(n: u128) -> u128 {
    uuid::Uuid::new_v4().as_u128() % n
}

fn new_channel(at: Millis) -> String {
    const LETTERS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let tail: String = (0..6).map(|_| LETTERS[random_below(36) as usize] as char).collect();
    format!("vibevalley-{at}-{tail}")
}

fn new_uid() -> String {
    (random_below(9_999_000) + 1000).to_string()
}

impl Voice {
    pub fn open(p: Parts) -> Arc<Voice> {
        let realtime = p.realtime.unwrap_or_else(|| Arc::new(moss::HttpProbe(p.ctx.http.clone())));
        let transcriber = p.transcriber.unwrap_or_else(|| Arc::new(HttpTranscriber(p.ctx.http.clone())));
        Arc::new(Voice {
            ctx: p.ctx,
            setting: p.setting,
            realtime,
            transcriber,
            state: Mutex::default(),
            commentary: AtomicU64::new(0),
        })
    }

    pub fn warn(&self, what: &str, why: impl std::fmt::Display) {
        self.ctx.live.publish_notice(now(), NoticeLevel::Warn, format!("{what}: {why}"));
    }

    pub(crate) fn stopped() -> ApiError {
        unavailable(t("server.voice.stopped", &[]), None)
    }

    pub fn ensure_running(&self) -> Result<(), ApiError> {
        if self.state.lock().stopped {
            return Err(Self::stopped());
        }
        Ok(())
    }

    pub fn can_transcribe(&self) -> bool {
        self.setting.providers().account(Use::Transcription).is_some()
    }

    /// The account MOSS Live calls on, or why there is none, as the voice page says it.
    fn live_account(&self) -> Result<Account, ApiError> {
        self.setting
            .providers()
            .account(Use::Live)
            .ok_or_else(|| unavailable(t("server.voice.moss.noKey", &[]), Some(VoiceFix::Moss)))
    }

    /// An unused grant expires after its TTL; an active call keeps its own until it stops.
    fn prune(state: &mut State) {
        let at = now();
        state.grants.retain(|_, g| g.phase != GrantPhase::Issued || g.expires > at);
    }

    /// Issues a channel and uid naming a new MOSS Live call.
    pub fn grant(&self) -> Result<VoiceGrant, ApiError> {
        self.live_account()?;
        let channel = new_channel(now());
        let uid = new_uid();
        let mut state = self.state.lock();
        if state.stopped {
            return Err(Self::stopped());
        }
        Self::prune(&mut state);
        state.grants.insert(
            (channel.clone(), uid.clone()),
            Grant {
                expires: now() + GRANT_TTL_SECONDS * 1000,
                phase: GrantPhase::Issued,
            },
        );
        Ok(VoiceGrant { channel, uid })
    }

    /// Begins the granted MOSS Live call. When `rang` is true, suppresses the default greeting.
    pub fn start(&self, channel: &str, uid: &str, rang: bool) -> Result<VoiceCall, ApiError> {
        let key = (channel.to_string(), uid.to_string());
        {
            let mut state = self.state.lock();
            Self::prune(&mut state);
            let grant = state.grants.get_mut(&key).ok_or_else(|| unavailable(t("server.voice.grantGone", &[]), None))?;
            if grant.phase != GrantPhase::Issued {
                return Err(unavailable(t("server.voice.connecting", &[]), None));
            }
            grant.phase = GrantPhase::Starting;
        }
        let agent = match self.start_moss(&key, rang) {
            Ok(agent) => agent,
            Err(e) => {
                self.state.lock().grants.remove(&key);
                return Err(e);
            }
        };
        Ok(VoiceCall { agent_id: agent })
    }

    fn commit(&self, key: &GrantKey, agent: &str, call: Call) -> Result<(), ApiError> {
        let mut state = self.state.lock();
        // The farm stopped, or the grant went, while the call was starting.
        let Some(grant) = state.grants.get_mut(key) else {
            return Err(Self::stopped());
        };
        grant.phase = GrantPhase::On;
        state.calls.insert(agent.to_string(), Arc::new(call));
        Ok(())
    }

    fn start_moss(&self, key: &GrantKey, rang: bool) -> Result<String, ApiError> {
        self.live_account()?;
        let voice = self.setting.voice();
        let agent = format!("moss-{}", key.0);
        let shared = {
            let mut state = self.state.lock();
            if state.stopped {
                return Err(Self::stopped());
            }
            state.moss.get_or_insert_with(Arc::default).clone()
        };
        let call = Call {
            moss: shared,
            grant: key.clone(),
            greeting: if rang { String::new() } else { voice.greeting.trim().to_string() },
            hung_up: AtomicBool::new(false),
        };
        self.commit(key, &agent, call)?;
        Ok(agent)
    }

    /// Closes the call's MOSS session.
    fn hang_up(&self, call: &Call) {
        call.hung_up.store(true, Ordering::SeqCst);
        *call.moss.phase.lock() = MossPhase::Closed;
        let mut state = self.state.lock();
        if state.moss.as_ref().is_some_and(|m| Arc::ptr_eq(m, &call.moss)) {
            state.moss = None;
        }
    }

    /// Ends the call. Stopping an unknown or already-ended call is a no-op.
    pub fn stop(&self, agent: &str) -> Result<(), ApiError> {
        let call = {
            let mut state = self.state.lock();
            let call = state.calls.remove(agent);
            if let Some(c) = &call {
                state.grants.remove(&c.grant);
            }
            call
        };
        if let Some(call) = &call {
            self.hang_up(call);
        }
        Ok(())
    }

    fn call(&self, agent: &str) -> Result<Arc<Call>, ApiError> {
        self.state
            .lock()
            .calls
            .get(agent)
            .filter(|c| !c.hung_up.load(Ordering::SeqCst))
            .cloned()
            .ok_or_else(|| failed(t("server.voice.hungUp", &[])))
    }

    /// Verifies `agent` refers to a live call and returns its greeting text.
    pub fn active_call_greeting(&self, agent: &str) -> Result<String, ApiError> {
        Ok(self.call(agent)?.greeting.clone())
    }

    fn live_calls(&self) -> Vec<String> {
        let state = self.state.lock();
        state
            .calls
            .iter()
            .filter(|(_, c)| !c.hung_up.load(Ordering::SeqCst))
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Queues or sends one commentary piece to the MOSS Live session.
    fn say_piece(&self, call: &Call, piece: &str) -> Result<(), String> {
        let mut phase = call.moss.phase.lock();
        let full = || "MOSS commentary unavailable or full".to_string();
        if piece.encode_utf16().count() > MOSS_PIECE_MAX {
            return Err(full());
        }
        match &mut *phase {
            MossPhase::Closed => Err(full()),
            MossPhase::Waiting { pending, .. } if pending.len() >= MOSS_PENDING_MAX => Err(full()),
            MossPhase::Waiting { pending, .. } => {
                pending.push(piece.to_string());
                Ok(())
            }
            MossPhase::Ready { out } => {
                self.deliver(piece, out);
                Ok(())
            }
        }
    }

    fn deliver(&self, piece: &str, out: &mpsc::Sender<String>) {
        for frame in moss::commentary(piece, || format!("brief-{}-{}", now(), self.commentary.fetch_add(1, Ordering::SeqCst))) {
            let _ = out.try_send(frame);
        }
    }

    pub fn speak_on(&self, agent: &str, text: &str) -> bool {
        let Ok(call) = self.call(agent) else { return false };
        let piece = text.trim();
        if piece.is_empty() {
            return true;
        }
        let still = self.state.lock().calls.get(agent).is_some_and(|c| Arc::ptr_eq(c, &call));
        if !still || call.hung_up.load(Ordering::SeqCst) {
            return false;
        }
        if let Err(why) = self.say_piece(&call, piece) {
            self.warn("voice: the orchestrator's words were not read out", why);
            return false;
        }
        true
    }

    /// Reads `text` out on the call under way; false when there is none or it could not.
    pub fn speak(&self, text: &str) -> bool {
        self.live_calls().first().is_some_and(|agent| self.speak_on(agent, text))
    }

    /// `voice.moss.verify`: whether MOSS Live takes the bound account's key;
    /// the problem is "" when it does. Captures and sends no audio.
    pub async fn verify_moss_async(&self) -> Validation {
        let Ok(account) = self.live_account() else {
            return Validation {
                problem: t("server.voice.moss.noKey", &[]),
            };
        };
        let why = |key: &str, why: String| t(key, &[("why", why.into())]);
        let problem = match self.realtime.verify_async(&account.key, &account.model).await {
            Verdict::Ok => String::new(),
            Verdict::Refused(w) => why("server.voice.moss.refused", w),
            Verdict::Unreachable(w) => why("server.voice.moss.unreachable", w),
            Verdict::Failed(w) => why("server.voice.moss.failed", w),
            Verdict::Silent => t("server.voice.moss.silent", &[]),
        };
        Validation { problem }
    }

    /// Opens a MOSS Live socket framing handle along with a stream of inbound
    /// MOSS tool-call requests to be answered by the caller (e.g. `orchestration::voice`).
    pub fn moss_line(self: &Arc<Self>) -> Result<(MossLine, mpsc::Receiver<MossToolRequest>), ApiError> {
        let account = self.live_account()?;
        let (out, outgoing) = mpsc::channel(MOSS_OUTGOING_CAP);
        let (tool_tx, tool_rx) = mpsc::channel(MOSS_TOOL_QUEUE_CAP);
        let shared = {
            let mut state = self.state.lock();
            if state.stopped {
                return Err(Self::stopped());
            }
            if state.live_line {
                return Err(unavailable(t("server.voice.connecting", &[]), None));
            }
            state.live_line = true;
            state.moss.get_or_insert_with(Arc::default).clone()
        };
        if let MossPhase::Waiting { out: slot, .. } = &mut *shared.phase.lock() {
            *slot = Some(out.clone());
        }
        Ok((
            MossLine {
                url: format!("wss://api.mosi.cn/v1/realtime?model={}", account.model),
                key: account.key,
                outgoing: Mutex::new(Some(outgoing)),
                out,
                voice: self.clone(),
                shared,
                tools: Arc::default(),
                tool_tx,
            },
            tool_rx,
        ))
    }

    /// Ends every active call and rejects new grants.
    pub fn close(&self) {
        let calls: Vec<Arc<Call>> = {
            let mut state = self.state.lock();
            state.stopped = true;
            state.grants.clear();
            state.moss = None;
            state.calls.drain().map(|(_, c)| c).collect()
        };
        for call in calls {
            self.hang_up(&call);
        }
    }

    pub(crate) async fn handle_moss_verify(&self) -> Validation {
        self.verify_moss_async().await
    }

    /// Transcribes raw WAV bytes via MOSS Transcription (`Use::Transcription`).
    pub async fn transcribe_wav_async(&self, wav: Vec<u8>) -> Result<String, ApiError> {
        self.ensure_running()?;
        if wav.len() <= 44 || wav.len() > (16 << 20) || !wav.starts_with(b"RIFF") || &wav[8..12] != b"WAVE" {
            return Err(ApiError::new(BizCode::InvalidInput, t("server.voice.asr.badAudio", &[])));
        }
        let account = self
            .setting
            .providers()
            .account(Use::Transcription)
            .ok_or_else(|| unavailable(t("server.voice.moss.noTranscribeKey", &[]), Some(VoiceFix::Moss)))?;
        self.transcriber.transcribe_wav_async(&account.key, &account.model, wav).await.map_err(failed)
    }

    /// Lightweight dictation-only MOSS Live WebSocket credentials (no tools or commentary).
    pub fn asr_line(&self) -> Result<MossAsrLine, ApiError> {
        let account = self.live_account()?;
        self.ensure_running()?;
        Ok(MossAsrLine {
            url: format!("wss://api.mosi.cn/v1/realtime?model={}", account.model),
            key: account.key,
        })
    }
}

/// Minimal MOSS Live handle used strictly for streaming composer speech dictation.
pub struct MossAsrLine {
    pub url: String,
    pub key: Secret,
}

impl LiveVoiceLine for MossAsrLine {
    fn url(&self) -> &str {
        &self.url
    }

    fn bearer_token(&self) -> &str {
        self.key.expose()
    }

    fn session_update(&self) -> String {
        moss::asr_session_update()
    }

    fn take_outgoing(&self) -> Option<mpsc::Receiver<String>> {
        None
    }

    fn heard(&self, _raw: &str) {}
}

#[derive(Default)]
struct Tools {
    enabled: bool,
    executed: HashSet<String>,
    awaiting_ack: HashSet<String>,
    in_flight: usize,
}

/// The MOSS Live session of a farm call, without its socket: the host
/// connects to `url` with `Authorization: Bearer <key>`, sends
/// [`MossLine::session_update`] first and every frame that arrives on
/// `outgoing`, and hands each text frame MOSS says to [`MossLine::heard`].
pub struct MossLine {
    pub url: String,
    pub key: Secret,
    /// Frames for MOSS, in order (taken once by the socket driver).
    pub outgoing: Mutex<Option<mpsc::Receiver<String>>>,
    out: mpsc::Sender<String>,
    voice: Arc<Voice>,
    shared: Arc<MossShared>,
    tools: Arc<Mutex<Tools>>,
    tool_tx: mpsc::Sender<MossToolRequest>,
}

impl MossLine {
    pub fn take_outgoing(&self) -> Option<mpsc::Receiver<String>> {
        self.outgoing.lock().take()
    }

    /// The session's settings: the voice page's persona, how to open, and
    /// the tool that asks the orchestrator.
    pub fn session_update(&self) -> String {
        let voice = self.voice.setting.voice();
        self.tools.lock().enabled = true;
        moss::session_update(&voice.persona, &voice.greeting)
    }

    pub fn closed(&self) -> bool {
        matches!(*self.shared.phase.lock(), MossPhase::Closed)
    }

    /// A text frame from MOSS: settings taken let the waiting commentary
    /// go; tool calls are emitted on `tool_tx`; tool acks trigger responses.
    fn hear_line(&self, raw: &str) {
        if moss::session_updated(raw) {
            let mut phase = self.shared.phase.lock();
            if let MossPhase::Waiting { pending, .. } = &mut *phase {
                for piece in std::mem::take(pending) {
                    self.voice.deliver(&piece, &self.out);
                }
                *phase = MossPhase::Ready { out: self.out.clone() };
            }
        }
        if let Some(call) = moss::tool_ack(raw)
            && self.tools.lock().awaiting_ack.remove(&call)
        {
            let _ = self.out.try_send(moss::response_create(&call));
        }
        for call in moss::tool_calls(raw) {
            {
                let mut tools = self.tools.lock();
                if self.closed() || !tools.enabled || tools.executed.contains(&call.call_id) {
                    continue;
                }
                if tools.executed.len() >= MOSS_TOOL_CALLS || tools.in_flight >= MOSS_TOOLS_AT_ONCE {
                    *self.shared.phase.lock() = MossPhase::Closed;
                    return;
                }
                tools.executed.insert(call.call_id.clone());
                tools.in_flight += 1;
            }
            let req = MossToolRequest {
                call_id: call.call_id,
                question: call.question,
                shared: self.shared.clone(),
                tools: self.tools.clone(),
                out: self.out.clone(),
            };
            if self.tool_tx.try_send(req).is_err() {
                let mut tools = self.tools.lock();
                tools.in_flight = tools.in_flight.saturating_sub(1);
            }
        }
    }
}

impl Drop for MossLine {
    /// The line ended (the host's socket closed): its calls end with it.
    fn drop(&mut self) {
        *self.shared.phase.lock() = MossPhase::Closed;
        let ended: Vec<Arc<Call>> = {
            let mut state = self.voice.state.lock();
            state.live_line = false;
            if state.moss.as_ref().is_some_and(|m| Arc::ptr_eq(m, &self.shared)) {
                state.moss = None;
            }
            let ids: Vec<String> = state
                .calls
                .iter()
                .filter(|(_, c)| Arc::ptr_eq(&c.moss, &self.shared))
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter()
                .filter_map(|id| {
                    let call = state.calls.remove(id)?;
                    state.grants.remove(&call.grant);
                    Some(call)
                })
                .collect()
        };
        for call in ended {
            call.hung_up.store(true, Ordering::SeqCst);
        }
    }
}

impl LiveVoiceLine for MossLine {
    fn url(&self) -> &str {
        &self.url
    }

    fn bearer_token(&self) -> &str {
        self.key.expose()
    }

    fn session_update(&self) -> String {
        MossLine::session_update(self)
    }

    fn take_outgoing(&self) -> Option<mpsc::Receiver<String>> {
        MossLine::take_outgoing(self)
    }

    fn heard(&self, raw: &str) {
        self.hear_line(raw)
    }
}
