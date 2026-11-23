//! `voice.*` (VibeValley `gateway/voice/voice.ts`): dictation, the grant a
//! client joins a call with, and the call itself: an Agora Conversational AI
//! agent asked into the channel over REST, or a MOSS Live session the host
//! holds. What a call's own model heard and said is kept in the chat; the
//! orchestrator answers on the voice line and through the MOSS tool.
//!
//! The server never touches audio: the host (the native app, in process)
//! joins the RTC channel or holds the MOSS socket, see [`Voice::moss_line`].

pub mod agora;
pub mod dictation;
pub mod line;
pub mod moss;
pub mod prompts;
pub mod token;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    AgoraGrant, ApiError, DEFAULT_ORCHESTRATOR, Dictated, Millis, NoticeLevel, Validation, VoiceAnswer, VoiceCall, VoiceFix, VoiceSettings, ops,
};

use self::agora::{CallLine, Client, Credentials, Joining, Pause, TOKEN_SECONDS, VendorKeys, failed, unavailable};
use self::line::{Line, OpenTunnel};
use self::moss::{Realtime, Verdict};
use self::token::Issue;
use crate::modules::collab::channel::{Chat, Picked, Posting, Saying};
use crate::modules::infra::http::Fetch;
use crate::modules::infra::provider::Use;
use crate::modules::infra::setting::{Secret, Setting};
use crate::modules::team::orchestrator::Orchestrator;
use crate::{Hub, now};

/// How long a turn of the orchestrator is waited for before a call gives up on it.
const ANSWER_WAIT: Duration = Duration::from_secs(120);
/// Agora reads out at most 512 bytes at a time.
const SPEAK_BYTES: usize = 480;
/// What a MOSS call holds for its model until the session takes its settings.
const MOSS_PENDING_MAX: usize = 8;
const MOSS_PIECE_MAX: usize = 16_000;
/// The tool calls one MOSS session may make, and at once.
const MOSS_TOOL_CALLS: usize = 64;
const MOSS_TOOLS_AT_ONCE: usize = 4;

/// Where the voice line listens and how the outside reaches it.
#[derive(Clone, Default)]
pub struct LineConfig {
    /// 0 is any free port.
    pub port: u16,
    /// The user's own tunnel to the port; empty opens a cloudflared quick tunnel.
    pub url: String,
    /// Opens the tunnel instead of cloudflared (tests).
    pub tunnel: Option<OpenTunnel>,
}

/// What the voice is made with.
pub struct Parts {
    pub hub: std::sync::Weak<Hub>,
    pub setting: Arc<Setting>,
    pub chat: Arc<Chat>,
    pub orchestrator: Arc<Orchestrator>,
    /// How Agora's REST, the dictation address and MOSS are reached.
    pub fetch: Arc<dyn Fetch>,
    /// Asks MOSS Live whether it takes a key; none asks over `fetch`.
    pub realtime: Option<Arc<dyn Realtime>>,
    pub line: LineConfig,
    /// How a retry waits; none sleeps.
    pub pause: Option<Pause>,
}

#[derive(Clone)]
enum GrantKind {
    Agora(Credentials),
    Moss,
}

#[derive(Clone, PartialEq)]
enum GrantPhase {
    Issued,
    Starting,
    On,
}

struct Grant {
    kind: GrantKind,
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

enum CallKind {
    Agora {
        client: Client,
        channel: String,
        /// Its voice line, when the orchestrator answers.
        line: Option<String>,
    },
    Moss(Arc<MossShared>),
}

struct Call {
    kind: CallKind,
    grant: GrantKey,
    /// A model of the call's own answers, so what was heard and said is kept through `hear` and `say`.
    quick: bool,
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
    hub: std::sync::Weak<Hub>,
    setting: Arc<Setting>,
    chat: Arc<Chat>,
    orchestrator: Arc<Orchestrator>,
    fetch: Arc<dyn Fetch>,
    realtime: Arc<dyn Realtime>,
    pause: Pause,
    line: Line,
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

fn moss_grant(channel: &str, uid: &str) -> AgoraGrant {
    AgoraGrant {
        app_id: "moss".into(),
        channel: channel.into(),
        uid: uid.into(),
        token: "moss".into(),
    }
}

impl Voice {
    pub fn open(p: Parts) -> Arc<Voice> {
        let pause: Pause = p.pause.unwrap_or_else(|| Arc::new(std::thread::sleep));
        let orchestrator = p.orchestrator.clone();
        let answer: line::Answer = Arc::new(move |text, say| {
            let Ok(reply) = orchestrator.answer(text) else { return false };
            let mut answered = false;
            while let Some(words) = reply.next(ANSWER_WAIT) {
                answered = true;
                say(words);
            }
            answered
        });
        let tunnel = p.line.tunnel.clone().unwrap_or_else(|| line::quick_tunnel(p.fetch.clone(), pause.clone()));
        Arc::new(Voice {
            hub: p.hub,
            setting: p.setting,
            chat: p.chat,
            orchestrator: p.orchestrator,
            realtime: p.realtime.unwrap_or_else(|| Arc::new(moss::HttpProbe(p.fetch.clone()))),
            fetch: p.fetch,
            pause,
            line: Line::new(p.line.port, p.line.url, tunnel, answer),
            state: Mutex::default(),
            commentary: AtomicU64::new(0),
        })
    }

    fn warn(&self, what: &str, why: impl std::fmt::Display) {
        if let Some(hub) = self.hub.upgrade() {
            hub.notice(NoticeLevel::Warn, format!("{what}: {why}"));
        }
    }

    fn stopped() -> ApiError {
        unavailable(t("server.voice.stopped", &[]), None)
    }

    /// The account MOSS Live calls on, or why there is none, as the voice page says it.
    fn live_account(&self) -> Result<crate::modules::infra::provider::Account, ApiError> {
        self.setting
            .providers()
            .account(Use::Live)
            .ok_or_else(|| unavailable(t("server.voice.moss.noKey", &[]), Some(VoiceFix::Moss)))
    }

    fn sign(&self, c: &Credentials, channel: &str, uid: &str) -> Result<AgoraGrant, ApiError> {
        let token = token::rtc_with_rtm(&c.app_id, &c.certificate, channel, uid, TOKEN_SECONDS, Issue::now())
            .map_err(|e| unavailable(t("server.voice.noToken", &[("why", e.to_string().into())]), None))?;
        Ok(AgoraGrant {
            app_id: c.app_id.clone(),
            channel: channel.into(),
            uid: uid.into(),
            token: token.expose().into(),
        })
    }

    /// A grant not yet used goes when its token does; a call under way keeps its own until it stops.
    fn prune(state: &mut State) {
        let at = now();
        state.grants.retain(|_, g| g.phase != GrantPhase::Issued || g.expires > at);
    }

    /// `voice.grant.create`: a channel and uid of this call's own and the
    /// token that joins it; for a MOSS call the grant only names the call.
    pub fn grant(&self) -> Result<AgoraGrant, ApiError> {
        let voice = self.setting.voice();
        let channel = new_channel(now());
        let uid = new_uid();
        let (kind, issued) = if matches!(voice.answer, VoiceAnswer::Moss(_)) {
            self.live_account()?;
            (GrantKind::Moss, moss_grant(&channel, &uid))
        } else {
            let (app_id, certificate) = self
                .setting
                .agora()
                .ok_or_else(|| unavailable(t("server.voice.noAgora", &[]), Some(VoiceFix::Call)))?;
            let credentials = Credentials { app_id, certificate };
            let issued = self.sign(&credentials, &channel, &uid)?;
            (GrantKind::Agora(credentials), issued)
        };
        let mut state = self.state.lock();
        if state.stopped {
            return Err(Self::stopped());
        }
        Self::prune(&mut state);
        state.grants.insert(
            (channel, uid),
            Grant {
                kind,
                expires: now() + TOKEN_SECONDS as Millis * 1000,
                phase: GrantPhase::Issued,
            },
        );
        Ok(issued)
    }

    /// `voice.grant.renew`: a new token for the same channel and uid, signed
    /// with the credentials the grant was issued with.
    pub fn renew(&self, channel: &str, uid: &str) -> Result<AgoraGrant, ApiError> {
        let mut state = self.state.lock();
        Self::prune(&mut state);
        let grant = state
            .grants
            .get_mut(&(channel.to_string(), uid.to_string()))
            .ok_or_else(|| unavailable(t("server.voice.grantGone", &[]), None))?;
        let issued = match &grant.kind {
            GrantKind::Moss => moss_grant(channel, uid),
            GrantKind::Agora(c) => self.sign(c, channel, uid)?,
        };
        grant.expires = now() + TOKEN_SECONDS as Millis * 1000;
        Ok(issued)
    }

    /// `voice.call.start`: the grant's call begins. `about` is what rang:
    /// the orchestrator says it first, instead of the greeting.
    pub fn start(self: &Arc<Self>, channel: &str, uid: &str, about: Option<&str>) -> Result<VoiceCall, ApiError> {
        let key = (channel.to_string(), uid.to_string());
        let kind = {
            let mut state = self.state.lock();
            Self::prune(&mut state);
            let grant = state.grants.get_mut(&key).ok_or_else(|| unavailable(t("server.voice.grantGone", &[]), None))?;
            if grant.phase != GrantPhase::Issued {
                return Err(unavailable(t("server.voice.connecting", &[]), None));
            }
            grant.phase = GrantPhase::Starting;
            grant.kind.clone()
        };
        let about = about.map(str::trim).filter(|a| !a.is_empty());
        let started = match kind {
            GrantKind::Moss => self.start_moss(&key, about.is_some()),
            GrantKind::Agora(credentials) => self.start_agora(&key, credentials, about.is_some()),
        };
        let agent = match started {
            Ok(agent) => agent,
            Err(e) => {
                self.state.lock().grants.remove(&key);
                return Err(e);
            }
        };
        if let Some(about) = about {
            self.tell(agent.clone(), prompts::on_call_line(&[], Some(about)));
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
            kind: CallKind::Moss(shared),
            grant: key.clone(),
            quick: true,
            greeting: if rang { String::new() } else { voice.greeting.trim().to_string() },
            hung_up: AtomicBool::new(false),
        };
        self.commit(key, &agent, call)?;
        Ok(agent)
    }

    fn start_agora(&self, key: &GrantKey, credentials: Credentials, rang: bool) -> Result<String, ApiError> {
        let mut voice: VoiceSettings = self.setting.voice();
        if rang {
            voice.greeting = String::new();
        }
        let (asr, llm, tts) = self.setting.voice_keys();
        let keys = VendorKeys {
            asr,
            llm,
            tts,
            deepseek: Secret::new(self.setting.deepseek_api_key().unwrap_or_default()),
        };
        let call_line: Option<CallLine> = match voice.answer {
            VoiceAnswer::Orchestrator(_) => Some(
                self.line
                    .open()
                    .map_err(|why| unavailable(t("server.voice.lineFailed", &[("why", why.into())]), None))?,
            ),
            _ => None,
        };
        let line_id = call_line.as_ref().map(|l| l.id.clone());
        let release = |e: ApiError| {
            if let Some(id) = &line_id {
                self.line.close(id);
            }
            e
        };
        let agent_token = token::rtc_with_rtm(
            &credentials.app_id,
            &credentials.certificate,
            &key.0,
            agora::AGENT_UID,
            TOKEN_SECONDS,
            Issue::now(),
        )
        .map_err(|e| release(unavailable(t("server.voice.noToken", &[("why", e.to_string().into())]), None)))?;
        let request = agora::join(
            &voice,
            &keys,
            call_line.as_ref(),
            &Joining {
                name: &format!("agent-{}", now()),
                channel: &key.0,
                token: &agent_token,
                user_uid: &key.1,
            },
        )
        .map_err(release)?;
        let client = Client {
            fetch: self.fetch.clone(),
            credentials,
            area: voice.area,
            pause: self.pause.clone(),
        };
        let agent = client
            .start(&request)
            .map_err(|e| release(failed(t("server.voice.joinFailed", &[("why", e.to_string().into())]))))?;
        let call = Call {
            kind: CallKind::Agora {
                client,
                channel: key.0.clone(),
                line: line_id.clone(),
            },
            grant: key.clone(),
            quick: call_line.is_none(),
            greeting: voice.greeting.trim().to_string(),
            hung_up: AtomicBool::new(false),
        };
        if let Err(e) = self.commit(key, &agent, call) {
            // The farm stopped while the agent joined: it is asked to leave again.
            if let Some(c) = self.client_now(&voice) {
                let _ = c.stop(&agent);
            }
            return Err(release(e));
        }
        Ok(agent)
    }

    fn client_now(&self, voice: &VoiceSettings) -> Option<Client> {
        let (app_id, certificate) = self.setting.agora()?;
        Some(Client {
            fetch: self.fetch.clone(),
            credentials: Credentials { app_id, certificate },
            area: voice.area,
            pause: self.pause.clone(),
        })
    }

    /// What a call held is let go: its line's key, its MOSS session.
    fn hang_up(&self, call: &Call) {
        call.hung_up.store(true, Ordering::SeqCst);
        match &call.kind {
            CallKind::Agora { line, .. } => {
                if let Some(id) = line {
                    self.line.close(id);
                }
            }
            CallKind::Moss(shared) => {
                *shared.phase.lock() = MossPhase::Closed;
                let mut state = self.state.lock();
                if state.moss.as_ref().is_some_and(|m| Arc::ptr_eq(m, shared)) {
                    state.moss = None;
                }
            }
        }
    }

    /// `voice.call.stop`: the call ends; an agent the farm does not know
    /// (a call of an earlier run) is asked to leave all the same.
    pub fn stop(&self, agent: &str) -> Result<(), ApiError> {
        let call = {
            let mut state = self.state.lock();
            let call = state.calls.remove(agent);
            if let Some(c) = &call {
                state.grants.remove(&c.grant);
            }
            call
        };
        let left = match call.as_deref().map(|c| &c.kind) {
            Some(CallKind::Moss(_)) => Ok(()),
            None if agent.starts_with("moss-") => Ok(()),
            Some(CallKind::Agora { client, .. }) => client.stop(agent),
            None => self
                .client_now(&self.setting.voice())
                .ok_or_else(|| unavailable(t("server.voice.noAgora", &[]), Some(VoiceFix::Call)))?
                .stop(agent),
        };
        if let Some(call) = &call {
            self.hang_up(call);
        }
        left.map_err(|e| failed(t("server.voice.leaveFailed", &[("why", e.to_string().into())])))
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

    /// `voice.call.hear`: what the call's own model heard the user say goes
    /// into the chat as the user's spoken words. A call the orchestrator
    /// answers has them already, through its line.
    pub fn heard(&self, agent: &str, text: &str, picked: Option<&str>, send_key: Option<&str>) -> Result<(), ApiError> {
        if !self.call(agent)?.quick {
            return Ok(());
        }
        self.chat.say(Saying {
            text: text.into(),
            send_key: send_key.unwrap_or("").into(),
            source: Some("voice".into()),
            picked: picked.filter(|a| !a.is_empty()).map(|a| Picked {
                agent: Some(a.into()),
                repo: None,
            }),
            ..Default::default()
        })?;
        Ok(())
    }

    /// `voice.hear`: the same for a client that does not name its call:
    /// only with exactly one call on.
    pub fn heard_current(&self, text: &str, picked: Option<&str>, send_key: Option<&str>) -> Result<(), ApiError> {
        let live = self.live_calls();
        match live.as_slice() {
            [] => Err(failed(t("server.voice.noCall", &[]))),
            [only] => self.heard(only, text, picked, send_key),
            _ => Err(failed(t("server.voice.manyCalls", &[]))),
        }
    }

    /// `voice.call.say`: what the call's own model said is kept in the chat
    /// as the orchestrator's spoken words; its greeting is not.
    pub fn said(&self, agent: &str, text: &str) -> Result<(), ApiError> {
        let call = self.call(agent)?;
        if call.quick
            && text.trim() != call.greeting
            && let Err(e) = self.chat.post(Posting {
                from: DEFAULT_ORCHESTRATOR.into(),
                channel: self.chat.default_channel(),
                text: text.into(),
                spoken: true,
                ..Default::default()
            })
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

    /// One piece for the call's voice to read out.
    fn say_piece(&self, agent: &str, call: &Call, piece: &str) -> Result<(), String> {
        match &call.kind {
            CallKind::Agora { client, channel, .. } => client.speak(channel, agent, piece).map_err(|e| e.to_string()),
            CallKind::Moss(shared) => {
                let mut phase = shared.phase.lock();
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
        }
    }

    fn deliver(&self, piece: &str, out: &flume::Sender<String>) {
        for frame in moss::commentary(piece, || format!("brief-{}-{}", now(), self.commentary.fetch_add(1, Ordering::SeqCst))) {
            let _ = out.send(frame);
        }
    }

    fn speak_on(&self, agent: &str, text: &str) -> bool {
        let Ok(call) = self.call(agent) else { return false };
        for piece in agora::speak_pieces(text, SPEAK_BYTES) {
            // Hung up between pieces: no later piece is sent.
            let still = self.state.lock().calls.get(agent).is_some_and(|c| Arc::ptr_eq(c, &call));
            if !still || call.hung_up.load(Ordering::SeqCst) {
                return false;
            }
            if let Err(why) = self.say_piece(agent, &call, &piece) {
                self.warn("voice: the orchestrator's words were not read out", why);
                return false;
            }
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
        let _ = std::thread::Builder::new().name("vibevalley-voice-tell".into()).spawn(move || {
            let Some(reply) = voice.orchestrator.brief(line) else { return };
            let said = reply.whole(ANSWER_WAIT);
            if !said.is_empty() {
                voice.speak_on(&agent, &said);
            }
        });
    }

    /// `voice.dictate`: one recording as text.
    pub fn dictate(&self, audio64: &str, format: &str) -> Result<Dictated, ApiError> {
        let to = dictation::transcriber(&self.setting)?;
        let (audio, format) = dictation::recording(audio64, format)?;
        let text = dictation::transcribe(&*self.fetch, &to, &audio, format)?;
        Ok(Dictated { text })
    }

    /// `voice.moss.verify`: whether MOSS Live takes the bound account's key;
    /// the problem is "" when it does. Captures and sends no audio.
    pub fn verify_moss(&self) -> Validation {
        let Ok(account) = self.live_account() else {
            return Validation {
                problem: t("server.voice.moss.noKey", &[]),
            };
        };
        let why = |key: &str, why: String| t(key, &[("why", why.into())]);
        let problem = match self.realtime.verify(&account.key, &account.model) {
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

    pub fn lines(&self) -> usize {
        self.line.lines()
    }

    /// Every call is hung up and the line with its tunnel closed.
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
        self.line.stop();
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
    pub fn heard(&self, raw: &str) {
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
            let _ = std::thread::Builder::new().name("vibevalley-voice-ask".into()).spawn(move || {
                let answer = voice.orchestrator.brief(call.question).map(|r| r.whole(ANSWER_WAIT)).unwrap_or_default();
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
                .filter(|(_, c)| matches!(&c.kind, CallKind::Moss(m) if Arc::ptr_eq(m, &self.shared)))
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

pub fn install(hub: &Hub, voice: Arc<Voice>) {
    let v = voice.clone();
    hub.on::<ops::VoiceGrantCreate>(move |_, ()| v.grant());
    let v = voice.clone();
    hub.on::<ops::VoiceGrantRenew>(move |_, r| v.renew(&r.channel, &r.uid));
    let v = voice.clone();
    hub.on::<ops::VoiceCallStart>(move |_, s| v.start(&s.channel, &s.uid, s.about.as_deref()));
    let v = voice.clone();
    hub.on::<ops::VoiceCallStop>(move |_, c| v.stop(&c.agent_id));
    let v = voice.clone();
    hub.on::<ops::VoiceCallHear>(move |_, h| v.heard(&h.agent_id, &h.text, h.agent.as_deref(), h.send_key.as_deref()));
    let v = voice.clone();
    hub.on::<ops::VoiceHear>(move |_, h| v.heard_current(&h.text, h.agent.as_deref(), h.send_key.as_deref()));
    let v = voice.clone();
    hub.on::<ops::VoiceCallSay>(move |_, s| v.said(&s.agent_id, &s.text));
    let v = voice.clone();
    hub.on::<ops::VoiceDictate>(move |_, r| v.dictate(&r.audio, &r.format));
    hub.on::<ops::VoiceMossVerify>(move |_, ()| Ok(voice.verify_moss()));
}
