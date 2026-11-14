//! The layer over the chat and the sessions (VibeValley
//! `modules/watch/watch.ts`): it reads the chat's committed events in order
//! after a cursor of its own (`watch_cursor` in server.db) and routes each
//! to the sessions, opens their issue threads, and posts their reports and
//! the farm's receipts (👀, the hop limit, the wake breaker).
//!
//! The issue board runs the sessions (`modules::issue`, `modules::session`), so a delivery
//! that wakes a session is words told to its issue (`Board::tell`): it
//! steers a working turn or starts the next round. One that does not wake
//! waits, in memory, and goes with the next that does.
//!
//! Threads: one reads the chat's events (the chat's writes wait on it
//! through `await_reader`), one reads the sessions' news from the hub (a
//! hub watcher must not write to the chat: the write would wait on the
//! router, which may be the thread that applied the fact).

pub mod hearers;

use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::ThreadId;
use std::time::Duration;

use vibevalley_core::Transition;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    Actor, AgentRole, ApiError, ChannelType, Fact, FactSessionReported, MessageKind, NoticeLevel, Outcome, Preview, Session, SubjectKind, USER_ID, ops,
};

use self::hearers::{Audience, BrakeInput, HeldBy, Reach, Recipient, WakeBreaker, brakes, who_hears};
use crate::Hub;
use crate::modules::agent::Agents;
use crate::modules::channel::{Chat, Committed, Meta, Note, Noticing, Saying, Seat, ThreadSubject, Told, actor_of, meta_of, profile_id};
use crate::modules::issue::Board;
use crate::modules::orchestrator::{Input, Orchestrator, words::Source};
use crate::now;

/// What a participant says by reacting when a message that wakes it is handed to it.
const HANDED_EMOJI: &str = "👀";
const REPORT_MAX: usize = 1500;
/// The cursor's name in watch_cursor: how far the chat's events were routed.
const ROUTED: &str = "channel";
/// A write waits this long for its routing at most.
const READER_WAIT: Duration = Duration::from_secs(120);

/// A delivery that did not wake its session: shown with the next that does.
#[derive(Debug, Clone)]
struct Waiting {
    session: String,
    message: String,
    line: String,
}

#[derive(Default)]
struct State {
    reach: Reach,
    breaker: WakeBreaker,
    waiting: Vec<Waiting>,
}

/// What the sessions' news tells the watch.
enum News {
    Hired,
    Left(String),
    Reported(Box<Session>, Box<FactSessionReported>),
}

pub struct Watch {
    hub: Arc<Hub>,
    chat: Arc<Chat>,
    board: Board,
    agents: Arc<Agents>,
    state: Mutex<State>,
    /// The newest event handled; writes wait on it.
    handled: Mutex<i64>,
    moved: Condvar,
    router: Mutex<Option<ThreadId>>,
    orchestrator: Option<Arc<Orchestrator>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn warn(what: &str, e: &ApiError) {
    eprintln!("vibevalley-server: watch: {what}: {}", e.message);
}

/// The first n UTF-16 units (`head` in clip.ts).
fn head(s: &str, n: usize) -> String {
    let mut out = String::new();
    let mut len = 0;
    for ch in s.chars() {
        len += ch.len_utf16();
        if len > n {
            break;
        }
        out.push(ch);
    }
    out
}

fn kind_of(kind: &str) -> MessageKind {
    serde_json::from_value(serde_json::Value::from(kind)).unwrap_or(MessageKind::Chat)
}

/// `wakeInput` without the chat tools' line: VibeValley's sessions answer in
/// their report, not in the chat.
fn wake_input(lines: &[String]) -> String {
    let mut out = format!("[输入] 有 {} 条给你的新消息：", lines.len());
    for l in lines {
        out.push('\n');
        out.push_str(l);
    }
    out
}

impl Watch {
    /// Starts the watch: the events after the cursor routed, then live; the
    /// sessions' threads opened; `issue.comment.create` said in the issue's
    /// thread; `channel.message.previewDelete` with its waiting deliveries.
    pub fn start(hub: &Arc<Hub>, chat: Arc<Chat>, board: Board, agents: Arc<Agents>) -> Arc<Watch> {
        Self::start_with(hub, chat, board, agents, None)
    }

    /// `start`, handing what wakes an orchestrator to `orchestrator`.
    pub fn start_with(hub: &Arc<Hub>, chat: Arc<Chat>, board: Board, agents: Arc<Agents>, orchestrator: Option<Arc<Orchestrator>>) -> Arc<Watch> {
        let watch = Arc::new(Watch {
            orchestrator,
            hub: hub.clone(),
            chat: chat.clone(),
            board,
            agents,
            state: Mutex::default(),
            handled: Mutex::new(0),
            moved: Condvar::new(),
            router: Mutex::new(None),
        });
        let events = chat.committed();
        let through = watch.boot();
        *lock(&watch.handled) = through;
        {
            let w = watch.clone();
            let thread = std::thread::Builder::new()
                .name("vibevalley-watch-chat".into())
                .spawn(move || {
                    for told in events.iter() {
                        let seq = match &told {
                            Told::Posted(c) => c.event.seq,
                            Told::Removed(e) => e.seq,
                        };
                        if seq > *lock(&w.handled) {
                            w.handle(told, false);
                            w.done(seq);
                        }
                    }
                })
                .expect("the watch's thread");
            *lock(&watch.router) = Some(thread.thread().id());
        }
        {
            let w = watch.clone();
            chat.await_reader(move |seq| {
                w.wait_for(seq);
                Ok(())
            });
        }
        {
            let h = hub.clone();
            chat.guard_removal(move |id| {
                let there = h.read(|s| s.sessions.iter().any(|x| x.channel.as_deref() == Some(id)));
                if there { vec![t("server.channel.helpersThere", &[])] } else { vec![] }
            });
        }
        let (tx, rx) = flume::unbounded::<News>();
        hub.watch(Arc::new(move |_, tr: &Transition| {
            let news = match &tr.fact {
                Fact::SessionChanged(f) if !tr.before.sessions.iter().any(|s| s.id == f.session.id) => News::Hired,
                Fact::SessionLeft(f) => News::Left(f.id.clone()),
                Fact::SessionReported(f) => {
                    let Some(s) = tr.after.sessions.iter().chain(&tr.before.sessions).find(|s| s.id == f.id) else {
                        return;
                    };
                    News::Reported(Box::new(s.clone()), Box::new(f.clone()))
                }
                _ => return,
            };
            let _ = tx.send(news);
        }));
        {
            let w = watch.clone();
            std::thread::Builder::new()
                .name("vibevalley-watch-news".into())
                .spawn(move || {
                    w.open_threads();
                    for news in rx.iter() {
                        w.on_news(news);
                    }
                })
                .expect("the watch's news thread");
        }
        watch.install(hub);
        watch
    }

    fn install(self: &Arc<Watch>, hub: &Hub) {
        let w = self.clone();
        hub.on::<ops::ChannelMessagePreviewDelete>(move |_, b| w.preview_remove(&b.id));
        let w = self.clone();
        hub.on::<ops::IssueCommentCreate>(move |ctx, input| {
            w.comment(&input.id, &input.text, input.send_key.as_deref().unwrap_or(""))?;
            Ok(vibevalley_protocol::Applied { seq: ctx.hub.seq() })
        });
    }

    /// `issue.comment`: the user's words in the issue's thread; the routing
    /// tells them to the issue before the call returns.
    pub fn comment(&self, issue: &str, text: &str, send_key: &str) -> Result<(), ApiError> {
        let item = self
            .board
            .issue(issue)
            .ok_or_else(|| crate::base::missing(t("server.issue.notFound", &[("id", issue.into())]), crate::base::LookIn::Issue))?;
        if item.status.is_closed() {
            return Err(crate::base::refused(
                vibevalley_protocol::BizCode::IssueRefused,
                t("server.issue.closedReopen", &[]),
            ));
        }
        if text.trim().is_empty() {
            return Err(crate::base::refused(
                vibevalley_protocol::BizCode::IssueRefused,
                t("server.issue.wordsRequired", &[]),
            ));
        }
        let channel = item
            .latest_session_id()
            .and_then(|s| self.hub.read(|st| st.sessions.iter().find(|x| &x.id == s).and_then(|x| x.channel.clone())));
        let thread = self.chat.issue_thread(&item.id, &item.title, channel.as_deref())?;
        self.chat.say(Saying {
            text: text.into(),
            channel: Some(thread),
            send_key: send_key.into(),
            ..Saying::default()
        })?;
        Ok(())
    }

    /// `previewRemove`: the chat's, and the deliveries still waiting on it.
    pub fn preview_remove(&self, id: &str) -> Result<Preview, ApiError> {
        let mut base = self.chat.preview_remove(id)?;
        let n = self.waiting_on(id);
        if n > 0 {
            base.does.push(t("server.channel.deletesDeliveries", &[("n", n.into())]));
        }
        Ok(base)
    }

    /// The deliveries of a message not handed yet.
    pub fn waiting_on(&self, message: &str) -> usize {
        lock(&self.state).waiting.iter().filter(|w| w.message == message).count()
    }

    fn wait_for(&self, seq: i64) {
        if *lock(&self.router) == Some(std::thread::current().id()) {
            return;
        }
        let handled = lock(&self.handled);
        let (_handled, timeout) = self
            .moved
            .wait_timeout_while(handled, READER_WAIT, |h| *h < seq)
            .unwrap_or_else(|e| e.into_inner());
        if timeout.timed_out() {
            eprintln!("vibevalley-server: watch: event {seq} not routed in time");
        }
    }

    fn done(&self, seq: i64) {
        let mut h = lock(&self.handled);
        *h = (*h).max(seq);
        drop(h);
        self.moved.notify_all();
        if let Err(e) = self.chat.move_cursor(ROUTED, seq) {
            warn("the cursor", &e);
        }
    }

    /// The events after the cursor, each once; the newest seq handled.
    fn boot(&self) -> i64 {
        let mut from = self.chat.cursor_of(ROUTED).unwrap_or(0);
        loop {
            let page = match self.chat.events(from, 200) {
                Ok(p) => p,
                Err(e) => {
                    warn("the events", &e);
                    break;
                }
            };
            let Some(last) = page.last().map(|e| e.seq) else { break };
            for event in page {
                let seq = event.seq;
                if event.kind == "removed" {
                    self.handle(Told::Removed(event), true);
                } else if let Ok(Some(c)) = self.chat.committed_of(&event.message_id) {
                    self.handle(Told::Posted(Box::new(c)), true);
                }
                let _ = self.chat.move_cursor(ROUTED, seq);
            }
            from = last;
        }
        from
    }

    fn handle(&self, told: Told, _again: bool) {
        match told {
            Told::Posted(c) => {
                if let Some(text) = self.route(&c) {
                    self.chat.notice(Noticing {
                        channel: c.row.channel_id.clone(),
                        text,
                        code: "hop_limit".into(),
                        until_user_speaks: true,
                        ..Noticing::default()
                    });
                }
                self.on_direct(&c);
            }
            Told::Removed(e) => lock(&self.state).waiting.retain(|w| w.message != e.message_id),
        }
    }

    /// The helpers on the farm (`isHired`): an orchestrator is on duty, not hired.
    fn hired(&self) -> Vec<Session> {
        self.hub.read(|s| s.sessions.iter().filter(|h| h.role == AgentRole::Worker).cloned().collect())
    }

    fn orchestrators(&self) -> Vec<String> {
        self.agents.profiles.orchestrators().into_iter().map(|a| a.id).collect()
    }

    /// A profile's talk with the user: the session answering in the direct channel.
    fn direct_of_session(&self, h: &Session) -> Option<String> {
        let place = self.chat.place(h.channel.as_deref()?)?;
        (h.issue.is_none() && place.r#type == ChannelType::Direct && place.peer == Some(profile_id(&h.agent))).then_some(place.id)
    }

    fn channel_of_session(&self, h: &Session) -> String {
        if let Some(d) = self.direct_of_session(h) {
            return d;
        }
        match h.channel.as_deref().and_then(|c| self.chat.place(c)) {
            Some(p) if p.r#type != ChannelType::Thread && p.name.is_some() => p.id,
            _ => self.chat.default_channel(),
        }
    }

    /// The helper working the issue now: the latest hired of those on it.
    fn on_issue<'a>(&self, hired: &'a [Session], issue: &str) -> Option<&'a Session> {
        hired.iter().filter(|h| h.issue.as_deref() == Some(issue)).max_by_key(|h| h.hired_at)
    }

    fn owner_of(&self, c: &Committed, hired: &[Session]) -> Option<String> {
        if c.channel_type != ChannelType::Thread {
            return None;
        }
        match &c.topic {
            Some((SubjectKind::Issue, id)) => self.on_issue(hired, id).map(|h| h.id.clone()),
            Some((SubjectKind::Talk, id)) => hired.iter().any(|h| &h.id == id).then(|| id.clone()),
            None => None,
        }
    }

    /// `messageLine`: how a message is shown to a session.
    fn line_of(&self, c: &Committed, actor: &Actor) -> String {
        let name = &c.row.sender_name;
        let from = match actor {
            Actor::Agent { role: AgentRole::Worker, .. } => format!("{} {name}", c.row.sender_id),
            _ => name.clone(),
        };
        let target = self.chat.target_of(&c.row.channel_id).unwrap_or_else(|| format!("#{}", c.channel_name));
        let reply = c.row.reply_number.map(|n| format!(" reply={n}")).unwrap_or_default();
        let edited = if c.row.edited_at.is_some() { "（改过）" } else { "" };
        format!(
            "[target={target} msg={}{reply} from={from}]{edited} {}",
            c.row.number,
            c.row.body.trim().replace('\n', "\n  │ ")
        )
    }

    /// Routes one message; the hop limit's notice when it held one back.
    fn route(&self, c: &Committed) -> Option<String> {
        let meta = meta_of(c.row.meta.as_deref());
        let hired = self.hired();
        let orchestrators = self.orchestrators();
        let actor = actor_of(&c.row.sender_kind, c.row.sender_agent.as_deref(), &c.row.sender_id, Some(&c.row.sender_name));
        let kind = kind_of(&c.row.kind);
        let listening: Vec<String> = hired
            .iter()
            .filter(|h| c.channel_type == ChannelType::Thread || self.channel_of_session(h) == c.row.channel_id)
            .map(|h| h.id.clone())
            .collect();
        let audience = Audience {
            from: c.row.sender_id.clone(),
            actor: actor.clone(),
            kind,
            mentions: c.mentions.clone(),
            channel: c.channel_type,
            peer: c.peer.clone(),
            channel_members: c.channel_members.clone(),
            orchestrators: orchestrators.clone(),
            thread_owner: self.owner_of(c, &hired),
            sessions: listening,
            present: Some(hired.iter().map(|h| h.id.clone()).collect()),
            members: c.members.clone(),
            outcome: meta.outcome,
            spoken: meta.spoken == Some(true) && meta.ingress_source.as_deref() != Some("voice"),
        };
        let candidates = match &meta.ingress_recipient {
            Some(to) => vec![Recipient::new(to.clone(), hearers::Reason::Addressed, true)],
            None => who_hears(&audience),
        };
        let scope = format!("channel:{}", c.row.channel_id);
        let at = now();
        let braked = {
            let mut st = lock(&self.state);
            let ids: Vec<String> = candidates.iter().map(|d| d.recipient.clone()).collect();
            let cooling = st.reach.cooling(&ids, at);
            let broken = st.breaker.tripped();
            let braked = brakes(
                candidates,
                &BrakeInput {
                    actor: &actor,
                    orchestrators: &orchestrators,
                    hops: st.reach.hops(&scope),
                    cooling: &cooling,
                    broken: &broken,
                },
            );
            match actor {
                Actor::User { .. } => {
                    st.reach.user_spoke(&scope);
                    for d in braked.iter().filter(|d| d.wakes) {
                        st.breaker.reset(&d.recipient);
                    }
                }
                Actor::Agent { .. } => {
                    for d in braked.iter().filter(|d| d.wakes && d.held_by.is_none()) {
                        st.reach.woke(&scope, &d.recipient, at);
                    }
                }
                Actor::System { .. } => {}
            }
            braked
        };
        self.deliver(c, &actor, kind, &hired, &braked);
        braked
            .iter()
            .any(|d| d.held_by == Some(HeldBy::HopLimit))
            .then(|| t("server.channel.hopLimit", &[("limit", hearers::HOP_LIMIT.into())]))
    }

    fn deliver(&self, c: &Committed, actor: &Actor, kind: MessageKind, hired: &[Session], braked: &[Recipient]) {
        let line = self.line_of(c, actor);
        // The user's words in an issue's thread go to the issue (its pool,
        // in VibeValley): its session if one is on it, else its next round.
        let pooled = match (&c.topic, actor, kind) {
            (Some((SubjectKind::Issue, issue)), Actor::User { .. }, MessageKind::Chat) if c.channel_type == ChannelType::Thread => Some(issue.clone()),
            _ => None,
        };
        if let Some(issue) = &pooled {
            let on = self.on_issue(hired, issue).map(|h| h.id.clone());
            let mut text = c.row.body.trim().to_string();
            let earlier = on.as_deref().map(|s| self.take_waiting(s)).unwrap_or_default();
            if !earlier.is_empty() {
                let lines: Vec<String> = earlier.iter().map(|w| w.line.clone()).collect();
                text = format!("{text}\n\n{}", wake_input(&lines));
            }
            self.tell(
                issue,
                &text,
                on.as_deref(),
                std::iter::once(c.row.id.clone()).chain(earlier.into_iter().map(|w| w.message)),
            );
        }
        for d in braked {
            let Some(h) = hired.iter().find(|h| h.id == d.recipient) else {
                self.to_orchestrator(c, actor, d);
                continue;
            };
            if pooled.is_some() && h.issue == pooled {
                continue;
            }
            if !d.wakes || d.held_by.is_some() || h.issue.is_none() {
                lock(&self.state).waiting.push(Waiting {
                    session: h.id.clone(),
                    message: c.row.id.clone(),
                    line: line.clone(),
                });
                continue;
            }
            let mut waiting = self.take_waiting(&h.id);
            waiting.push(Waiting {
                session: h.id.clone(),
                message: c.row.id.clone(),
                line: line.clone(),
            });
            let lines: Vec<String> = waiting.iter().map(|w| w.line.clone()).collect();
            let issue = h.issue.clone().unwrap_or_default();
            self.tell(&issue, &wake_input(&lines), Some(&h.id), waiting.into_iter().map(|w| w.message));
        }
    }

    /// A message for an orchestrator: one that wakes it is its input
    /// (`heardInChat`'s line), one that does not is news for its next.
    fn to_orchestrator(&self, c: &Committed, actor: &Actor, d: &Recipient) {
        use crate::modules::orchestrator::words as w;
        let Some(o) = &self.orchestrator else { return };
        if !self.agents.profiles.is_orchestrator(&d.recipient) {
            return;
        }
        let m = self.chat.addressed_of(&c.row);
        let line = w::orchestrator_lines(std::slice::from_ref(&m));
        if !d.wakes || d.held_by.is_some() {
            o.overhear(Some(&d.recipient), line);
            return;
        }
        let meta = meta_of(c.row.meta.as_deref());
        let from_user = matches!(actor, Actor::User { .. });
        let mut picked_note = String::new();
        if let Some(p) = &meta.picked {
            if let Some(a) = p.agent.as_deref().and_then(|a| self.agents.profiles.agent(a)) {
                picked_note += &w::picked_agent(&a.name);
            }
            if let Some(r) = &p.repo {
                picked_note += &w::picked_repo(r);
            }
        }
        let text = c.row.body.trim();
        let said = match meta.voice_mode.as_deref() {
            Some("dictated") => format!("{picked_note}{}{}", w::DICTATED, w::user_line(text)),
            Some("conversation") => format!("{}\n{}", w::PROMPTS.voice, w::user_line(text)),
            _ if from_user && (c.channel_type == ChannelType::Direct || c.row.channel_id == self.chat.default_channel()) => {
                format!("{picked_note}{}", w::user_line(text))
            }
            _ => format!("{picked_note}{}", w::chat_line(&m.target, &line)),
        };
        let input = Input {
            agent: Some(d.recipient.clone()),
            channel: c.row.channel_id.clone(),
            source: if from_user { Source::User } else { Source::Chat },
            line: said,
            user: from_user,
            picked: meta.picked.clone(),
            messages: vec![c.row.id.clone()],
        };
        if o.hear(input)
            && let Err(e) = self.chat.react(&c.row.id, &d.recipient, HANDED_EMOJI, true)
        {
            warn("👀", &e);
        }
    }

    fn take_waiting(&self, session: &str) -> Vec<Waiting> {
        let mut st = lock(&self.state);
        let (mine, rest): (Vec<Waiting>, Vec<Waiting>) = st.waiting.drain(..).partition(|w| w.session == session);
        st.waiting = rest;
        mine
    }

    /// Words to an issue; each message handed is seen and 👀'd by the session.
    fn tell(&self, issue: &str, text: &str, session: Option<&str>, messages: impl Iterator<Item = String>) {
        match self.board.tell(issue, text) {
            Ok(()) => {
                let Some(session) = session else { return };
                for m in messages {
                    if let Err(e) = self.chat.mark_seen(session, &m) {
                        warn("seen", &e);
                    }
                    if let Err(e) = self.chat.react(&m, session, HANDED_EMOJI, true) {
                        warn("👀", &e);
                    }
                }
            }
            // A refusal is the route's answer: the message is kept and passed.
            Err(e) => self.hub.notice(NoticeLevel::Warn, e.to_string()),
        }
    }

    /// The user speaking to a helper profile in its direct channel: its
    /// talking session hears it (hired the first time); a refusal is said there.
    fn on_direct(&self, c: &Committed) {
        if c.row.sender_id != USER_ID || c.row.kind != "chat" || c.channel_type != ChannelType::Direct {
            return;
        }
        let Some(peer) = &c.peer else { return };
        let Some(p) = self.chat.participants().into_iter().find(|p| &p.id == peer) else {
            return;
        };
        let Some(agent) = p.agent_id.as_deref() else { return };
        if p.id != profile_id(agent) {
            return;
        }
        let why = match self.agents.profiles.agent(agent) {
            Some(a) if !a.enabled => t("server.channel.profileDisabled", &[("name", a.name.into())]),
            _ => match self.board.sessions().talk(agent, &c.row.channel_id, &c.row.body) {
                Ok(_) => return,
                Err(e) => e.to_string(),
            },
        };
        self.chat.notice(Noticing {
            channel: c.row.channel_id.clone(),
            text: t("server.channel.talkFailed", &[("why", why.into())]),
            code: "talk_refused".into(),
            ..Noticing::default()
        });
    }

    fn on_news(&self, news: News) {
        match news {
            News::Hired => self.open_threads(),
            News::Left(id) => {
                {
                    let mut st = lock(&self.state);
                    st.reach.left(&id);
                    st.breaker.reset(&id);
                }
                self.sessions_left();
            }
            News::Reported(h, f) => {
                if let Err(e) = self.post_report(&h, &f) {
                    warn("the report", &e);
                }
            }
        }
    }

    fn open_threads(&self) {
        for h in self.hired() {
            if let Err(e) = self.open_thread(&h) {
                warn(&format!("{}'s thread", h.id), &e);
            }
        }
    }

    fn seat(&self, h: &Session, home: Option<String>) -> Result<(), ApiError> {
        self.chat.seat(&Seat {
            id: h.id.clone(),
            name: h.name.clone(),
            agent: Some(h.agent.clone()),
            home,
        })
    }

    fn open_thread(&self, h: &Session) -> Result<(), ApiError> {
        self.seat(h, None)?;
        if let Some(direct) = self.direct_of_session(h) {
            return self.handed_on(h, &direct);
        }
        let (kind, id) = match &h.issue {
            Some(issue) => (SubjectKind::Issue, issue.clone()),
            None => (SubjectKind::Talk, h.id.clone()),
        };
        if let Some(thread) = self.chat.thread_about(kind, &id) {
            return self.handed_on(h, &thread);
        }
        let channel = self.channel_of_session(h);
        self.chat.read_up_to(&h.id, &channel, self.chat.latest(&channel)?)?;
        let what = if h.refining {
            t("server.channel.dispatch.draft", &[])
        } else {
            head(&h.brief.split_whitespace().collect::<Vec<_>>().join(" "), 80)
        };
        let repo = h
            .repo
            .as_deref()
            .map(|r| {
                std::path::Path::new(r)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| r.to_string())
            })
            .unwrap_or_else(|| t("server.channel.dispatch.repo", &[]));
        let text = t(
            "server.channel.dispatch.sent",
            &[
                ("id", h.id.clone().into()),
                ("name", h.name.clone().into()),
                ("repo", repo.into()),
                ("what", what.into()),
            ],
        );
        let thread = self.chat.note(Note {
            channel: channel.clone(),
            from: self.chat.orchestrator_in(&channel),
            kind: MessageKind::Dispatch,
            text,
            meta: Meta {
                session: Some(h.id.clone()),
                ..Meta::default()
            },
            topic: Some(ThreadSubject { kind, id, owner: h.id.clone() }),
            member: None,
        })?;
        if !thread.is_empty() {
            self.seat(h, Some(thread))?;
        }
        Ok(())
    }

    /// The issue already has its thread (reopened, or sent to another session).
    fn handed_on(&self, h: &Session, thread: &str) -> Result<(), ApiError> {
        self.seat(h, Some(thread.to_string()))?;
        if self.chat.members_of(thread).contains(&h.id) {
            return Ok(());
        }
        if self.chat.place(thread).is_some_and(|p| p.r#type == ChannelType::Direct) {
            return self.chat.add_follower(thread, &h.id);
        }
        let channel = self.channel_of_session(h);
        self.chat.read_up_to(&h.id, &channel, self.chat.latest(&channel)?)?;
        let nth = self.chat.dispatches(thread)? + 2;
        let text = if h.refining {
            t(
                "server.channel.dispatch.redraft",
                &[("id", h.id.clone().into()), ("name", h.name.clone().into())],
            )
        } else {
            t(
                "server.channel.dispatch.handedOn",
                &[("id", h.id.clone().into()), ("name", h.name.clone().into()), ("nth", nth.into())],
            )
        };
        self.chat.note(Note {
            channel: thread.to_string(),
            from: self.chat.orchestrator_in(thread),
            kind: MessageKind::Dispatch,
            text,
            meta: Meta {
                session: Some(h.id.clone()),
                ..Meta::default()
            },
            topic: None,
            member: Some(h.id.clone()),
        })?;
        Ok(())
    }

    fn sessions_left(&self) {
        let on: Vec<String> = self.hired().into_iter().map(|h| h.id).collect();
        for p in self.chat.participants() {
            let Some(agent) = p.agent_id.as_deref() else { continue };
            if p.id == profile_id(agent) || p.left_at.is_some() || on.contains(&p.id) {
                continue;
            }
            if let Err(e) = self.chat.leave(&p.id) {
                warn("leave", &e);
            }
            lock(&self.state).waiting.retain(|w| w.session != p.id);
        }
    }

    fn post_report(&self, h: &Session, f: &FactSessionReported) -> Result<(), ApiError> {
        if h.refining {
            // The draft, or why there is none, in the issue's thread (the session itself is let go already).
            let Some(thread) = h.issue.as_deref().and_then(|i| self.chat.issue_thread_id(i)) else {
                return Ok(());
            };
            self.chat.notice(Noticing {
                channel: thread,
                text: f.summary.clone(),
                code: "issue_refinement".into(),
                ..Noticing::default()
            });
            return Ok(());
        }
        if f.outcome == Outcome::Interrupted {
            return Ok(());
        }
        let Some(thread) = self.chat.home_of(&h.id) else { return Ok(()) };
        let meta = Meta {
            outcome: Some(f.outcome),
            spent: f.spent.clone(),
            run: f.run.clone(),
            ..Meta::default()
        };
        self.chat.note(Note {
            channel: thread,
            from: h.id.clone(),
            kind: MessageKind::Report,
            text: head(&f.summary, REPORT_MAX),
            meta,
            topic: None,
            member: None,
        })?;
        Ok(())
    }
}
