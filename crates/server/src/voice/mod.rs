//! `voice.*`: MOSS Live voice calls.
//!
//! The server never touches audio: the host (the native app, in process)
//! holds the MOSS Live socket via [`Voice::moss_line`]. What the model heard
//! and said is kept in chat through `voice.call.hear`, `voice.hear`, and
//! `voice.call.say`; the orchestrator answers through the MOSS tool and
//! pushes commentary through [`Voice::speak`].

pub mod moss;
pub mod prompt;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use vibevalley_i18n::t;
use vibevalley_protocol::{ApiError, ApiErrorDetail, BizCode, DEFAULT_ORCHESTRATOR, Millis, NoticeLevel, Op, Validation, VoiceCall, VoiceFix, VoiceGrant, ops};

use self::moss::{Realtime, Verdict};
use crate::channel::{Chat, Picked, Posting, Saying};
use crate::context::api::{LiveVoiceLine, LiveVoicePort};
use crate::context::port::VoiceOrchestratorPort;
use crate::context::{Context, now};
use crate::setting::{Account, Secret, Setting, Use};

/// How long an unused grant stays valid before expiring.
const GRANT_TTL_SECONDS: Millis = 3600;
/// How long a turn of the orchestrator is waited for before a call gives up on it.
const ANSWER_WAIT: Duration = Duration::from_secs(120);
/// What a MOSS call holds for its model until the session takes its settings.
const MOSS_PENDING_MAX: usize = 8;
const MOSS_PIECE_MAX: usize = 16_000;
/// The tool calls one MOSS session may make, and at once.
const MOSS_TOOL_CALLS: usize = 64;
const MOSS_TOOLS_AT_ONCE: usize = 4;

fn unavailable(reason: impl Into<String>, settings: Option<VoiceFix>) -> ApiError {
    ApiError {
        biz_code: BizCode::VoiceUnavailable,
        message: reason.into(),
        detail: ApiErrorDetail { next: None, settings },
    }
}

fn failed(reason: impl Into<String>) -> ApiError {
    ApiError::new(BizCode::VoiceCallFailed, reason)
}

/// Dependencies for constructing [`Voice`].
pub struct Parts {
    pub ctx: Arc<Context>,
    pub setting: Arc<Setting>,
    pub chat: Arc<Chat>,
    pub orchestrator: Arc<dyn VoiceOrchestratorPort>,
    /// Optional MOSS Live key probe override (tests).
    pub realtime: Option<Arc<dyn Realtime>>,
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
        out: Option<flume::Sender<String>>,
        pending: Vec<String>,
    },
    Ready {
        out: flume::Sender<String>,
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

pub struct Voice {
    me: Weak<Voice>,
    ctx: Arc<Context>,
    setting: Arc<Setting>,
    chat: Arc<Chat>,
    orchestrator: Arc<dyn VoiceOrchestratorPort>,
    realtime: Arc<dyn Realtime>,
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
        Arc::new_cyclic(|me| Voice {
            me: me.clone(),
            ctx: p.ctx,
            setting: p.setting,
            chat: p.chat,
            orchestrator: p.orchestrator,
            realtime,
            state: Mutex::default(),
            commentary: AtomicU64::new(0),
        })
    }

    fn warn(&self, what: &str, why: impl std::fmt::Display) {
        self.ctx.live.publish_notice(now(), NoticeLevel::Warn, format!("{what}: {why}"));
    }

    fn stopped() -> ApiError {
        unavailable(t("server.voice.stopped", &[]), None)
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

    /// `voice.grant.create`: issues a channel and uid naming a new MOSS Live call.
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

    /// `voice.call.start`: begins the granted MOSS Live call. `about` is what rang:
    /// the orchestrator says it first instead of the greeting.
    pub fn start(self: &Arc<Self>, channel: &str, uid: &str, about: Option<&str>) -> Result<VoiceCall, ApiError> {
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
        let about = about.map(str::trim).filter(|a| !a.is_empty());
        let agent = match self.start_moss(&key, about.is_some()) {
            Ok(agent) => agent,
            Err(e) => {
                self.state.lock().grants.remove(&key);
                return Err(e);
            }
        };
        if let Some(about) = about {
            self.tell(agent.clone(), prompt::on_call_line(&[], Some(about)));
        }
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

    /// `voice.call.stop`: ends the call. Stopping an unknown or already-ended call is a no-op.
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

    pub async fn heard_async(&self, agent: &str, text: &str, picked: Option<&str>, send_key: Option<&str>) -> Result<(), ApiError> {
        self.call(agent)?;
        self.chat
            .say_async(Saying {
                text: text.into(),
                send_key: send_key.unwrap_or("").into(),
                source: Some("voice".into()),
                picked: picked.filter(|a| !a.is_empty()).map(|a| Picked {
                    agent: Some(a.into()),
                    repo: None,
                }),
                ..Default::default()
            })
            .await?;
        Ok(())
    }

    /// Non-blocking host transcript handoff used by [`LiveVoicePort::heard`]: validates
    /// the active call synchronously and records the transcript on `ctx.task`.
    fn heard_background(self: &Arc<Self>, agent: &str, text: &str, send_key: Option<&str>) -> Result<(), ApiError> {
        self.call(agent)?;
        let voice = self.clone();
        let text = text.to_string();
        let send_key = send_key.unwrap_or("").to_string();
        self.ctx.spawn("voice.heard", async move {
            if let Err(e) = voice
                .chat
                .say_async(Saying {
                    text,
                    send_key,
                    source: Some("voice".into()),
                    ..Default::default()
                })
                .await
            {
                voice.warn("voice: the user's spoken words were not kept", e.message);
            }
        });
        Ok(())
    }

    /// `voice.hear`: records spoken user words on the sole active call.
    pub async fn heard_current_async(&self, text: &str, picked: Option<&str>, send_key: Option<&str>) -> Result<(), ApiError> {
        let live = self.live_calls();
        match live.as_slice() {
            [] => Err(failed(t("server.voice.noCall", &[]))),
            [only] => self.heard_async(only, text, picked, send_key).await,
            _ => Err(failed(t("server.voice.manyCalls", &[]))),
        }
    }

    /// Non-blocking host transcript handoff used by [`LiveVoicePort::said`].
    fn said_background(self: &Arc<Self>, agent: &str, text: &str) -> Result<(), ApiError> {
        self.call(agent)?;
        let voice = self.clone();
        let agent = agent.to_string();
        let text = text.to_string();
        self.ctx.spawn("voice.said", async move {
            let _ = voice.said_async(&agent, &text).await;
        });
        Ok(())
    }

    /// `voice.call.say`: records what the MOSS Live session said in chat; its greeting is skipped.
    pub async fn said_async(&self, agent: &str, text: &str) -> Result<(), ApiError> {
        let call = self.call(agent)?;
        if text.trim() != call.greeting
            && let Err(e) = self
                .chat
                .post_async(Posting {
                    from: DEFAULT_ORCHESTRATOR.into(),
                    channel: self.chat.default_channel(),
                    text: text.into(),
                    spoken: true,
                    ..Default::default()
                })
                .await
        {
            self.warn("voice: the orchestrator's spoken words were not kept", e.message);
        }
        Ok(())
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

    fn deliver(&self, piece: &str, out: &flume::Sender<String>) {
        for frame in moss::commentary(piece, || format!("brief-{}-{}", now(), self.commentary.fetch_add(1, Ordering::SeqCst))) {
            let _ = out.send(frame);
        }
    }

    fn speak_on(&self, agent: &str, text: &str) -> bool {
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

    /// Has the orchestrator answer `line` and reads its answer out on the call.
    fn tell(self: &Arc<Self>, agent: String, line: String) {
        let voice = self.clone();
        self.ctx.spawn("voice.tell", async move {
            let Some(said) = voice.orchestrator.brief(line, ANSWER_WAIT).await else {
                return;
            };
            if !said.is_empty() {
                voice.speak_on(&agent, &said);
            }
        });
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

    /// For the host that holds the MOSS Live socket: where to connect and
    /// with which key, the frames to send, and where to bring the frames
    /// MOSS says. One line at a time; dropping it ends its calls.
    pub fn moss_line(self: &Arc<Self>) -> Result<MossLine, ApiError> {
        let account = self.live_account()?;
        let (out, outgoing) = flume::unbounded();
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
        Ok(MossLine {
            url: format!("wss://api.mosi.cn/v1/realtime?model={}", account.model),
            key: account.key,
            outgoing,
            out,
            voice: self.clone(),
            shared,
            tools: Arc::default(),
        })
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

    pub(crate) async fn handle_hear(&self, req: <ops::VoiceHear as Op>::Input) -> Result<(), ApiError> {
        self.heard_current_async(&req.text, req.agent.as_deref(), req.send_key.as_deref()).await
    }

    pub(crate) async fn handle_moss_verify(&self) -> Validation {
        self.verify_moss_async().await
    }

    pub(crate) fn handle_grant_create(&self) -> Result<VoiceGrant, ApiError> {
        self.grant()
    }

    pub(crate) fn handle_call_start(self: &Arc<Self>, req: <ops::VoiceCallStart as Op>::Input) -> Result<VoiceCall, ApiError> {
        self.start(&req.channel, &req.uid, req.about.as_deref())
    }

    pub(crate) fn handle_call_stop(&self, req: <ops::VoiceCallStop as Op>::Input) -> Result<(), ApiError> {
        self.stop(&req.agent_id)
    }

    pub(crate) async fn handle_call_hear(&self, req: <ops::VoiceCallHear as Op>::Input) -> Result<(), ApiError> {
        self.heard_async(&req.agent_id, &req.text, req.agent.as_deref(), req.send_key.as_deref()).await
    }

    pub(crate) async fn handle_call_say(&self, req: <ops::VoiceCallSay as Op>::Input) -> Result<(), ApiError> {
        self.said_async(&req.agent_id, &req.text).await
    }
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
    /// Frames for MOSS, in order.
    pub outgoing: flume::Receiver<String>,
    out: flume::Sender<String>,
    voice: Arc<Voice>,
    shared: Arc<MossShared>,
    tools: Arc<Mutex<Tools>>,
}

impl MossLine {
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
    /// go; a tool call is put to the orchestrator and answered; an answer
    /// MOSS has taken lets its model go on.
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
            let _ = self.out.send(moss::response_create(&call));
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
            let (voice, shared, tools, out) = (self.voice.clone(), self.shared.clone(), self.tools.clone(), self.out.clone());
            self.voice.ctx.spawn("voice.tool", async move {
                let answer = voice.orchestrator.brief(call.question, ANSWER_WAIT).await.unwrap_or_default();
                let answer = if answer.is_empty() { t("server.voice.moss.toolFailed", &[]) } else { answer };
                let mut tools = tools.lock();
                tools.in_flight -= 1;
                if matches!(*shared.phase.lock(), MossPhase::Closed) {
                    return;
                }
                tools.awaiting_ack.insert(call.call_id.clone());
                let _ = out.send(moss::tool_output(&call.call_id, &answer));
            });
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

    fn outgoing(&self) -> flume::Receiver<String> {
        self.outgoing.clone()
    }

    fn heard(&self, raw: &str) {
        self.hear_line(raw)
    }
}

impl LiveVoicePort for Voice {
    fn grant(&self) -> Result<VoiceGrant, ApiError> {
        Voice::grant(self)
    }

    fn moss_line(&self) -> Result<Box<dyn LiveVoiceLine>, ApiError> {
        let me = self.me.upgrade().ok_or_else(Voice::stopped)?;
        Ok(Box::new(Voice::moss_line(&me)?))
    }

    fn start(&self, channel: &str, uid: &str) -> Result<VoiceCall, ApiError> {
        let me = self.me.upgrade().ok_or_else(Voice::stopped)?;
        Voice::start(&me, channel, uid, None)
    }

    fn heard(&self, agent_id: &str, text: &str, turn: Option<&str>) -> Result<(), ApiError> {
        let me = self.me.upgrade().ok_or_else(Voice::stopped)?;
        Voice::heard_background(&me, agent_id, text, turn)
    }

    fn said(&self, agent_id: &str, text: &str) -> Result<(), ApiError> {
        let me = self.me.upgrade().ok_or_else(Voice::stopped)?;
        Voice::said_background(&me, agent_id, text)
    }

    fn stop(&self, agent_id: &str) {
        let _ = Voice::stop(self, agent_id);
    }
}
