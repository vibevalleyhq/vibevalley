use vibevalley_i18n::{list, t};
use vibevalley_protocol::{ApiError, Channel, ChannelLast, ChannelUnread, DEFAULT_ORCHESTRATOR, EVERYONE, SubjectKind, USER_ID};

use super::db::{self, ChannelRow, Connection, EventRow, MsgRow, ParticipantRow};
use super::model::ChatModel;
use super::types::{
    AddressedMessage, ArtifactRef, Committed, FileAt, Place, Seat, ThreadSubject, actor_of, channel_type, meta_of, meta_text, new_id, notify_of, subject_kind,
};
use super::words::{self, ChatTarget, Nameable};
use super::{CALLERS_MAX, LAST_MAX, THREAD_TITLE_MAX, line_of, refused};
use crate::base::{LookIn, internal, missing};
use crate::modules::content::attachment::Attachments;
use crate::now;

pub(super) trait Q<T> {
    fn q(self) -> Result<T, ApiError>;
}

impl<T> Q<T> for sqlx::Result<T> {
    fn q(self) -> Result<T, ApiError> {
        self.map_err(internal)
    }
}

/// The tables and the places in memory, under one lock (`locked`).
pub struct Inner {
    pub(super) db: Connection,
    pub(super) transaction_depth: usize,
    pub(super) model: ChatModel,
}

/// A savepoint around `work`: on failure the tables and the model are as
/// they were. The outermost one takes the write lock at once: other modules
/// write to the same file, and a read that later wants to write would be
/// refused (`SQLITE_BUSY`) rather than wait.
pub(super) fn tx<T>(inner: &mut Inner, work: impl FnOnce(&mut Inner) -> Result<T, ApiError>) -> Result<T, ApiError> {
    struct Savepoint<'a> {
        inner: &'a mut Inner,
        previous: Option<ChatModel>,
        undo: &'static str,
    }
    impl Drop for Savepoint<'_> {
        fn drop(&mut self) {
            self.inner.transaction_depth -= 1;
            if let Some(previous) = self.previous.take() {
                let _ = db::control(&self.inner.db, self.undo);
                self.inner.model = previous;
            }
        }
    }
    let (begin, commit, undo) = if inner.transaction_depth == 0 {
        ("begin immediate", "commit", "rollback")
    } else {
        ("savepoint chat", "release chat", "rollback to chat; release chat")
    };
    let previous = inner.model.clone();
    db::control(&inner.db, begin).q()?;
    inner.transaction_depth += 1;
    let mut guard = Savepoint {
        inner,
        previous: Some(previous),
        undo,
    };
    let value = work(guard.inner)?;
    db::control(&guard.inner.db, commit).q()?;
    guard.previous = None;
    Ok(value)
}

impl Inner {
    pub(super) fn add_member(&mut self, channel: &str, participant: &str, reason: &str, from: i64) -> Result<(), ApiError> {
        db::add_member(&self.db, channel, participant, reason, from).q()?;
        self.model.member_added(channel, participant);
        Ok(())
    }

    fn upsert_participant(&mut self, p: ParticipantRow) -> Result<(), ApiError> {
        db::upsert_participant(&self.db, &p).q()?;
        self.model.joined(p);
        Ok(())
    }

    /// An agent's seat as it goes now; one already so is left as it is.
    pub(super) fn seat(&mut self, p: &Seat) -> Result<(), ApiError> {
        if let Some(held) = self.model.participant(&p.id)
            && held.kind == "agent"
            && held.name == p.name
            && held.agent_id == p.agent
            && held.left_at.is_none()
            && p.home.as_ref().is_none_or(|h| Some(h) == held.home_id.as_ref())
        {
            return Ok(());
        }
        self.upsert_participant(ParticipantRow {
            id: p.id.clone(),
            kind: "agent".into(),
            name: p.name.clone(),
            agent_id: p.agent.clone(),
            home_id: p.home.clone(),
            joined_at: now(),
            left_at: None,
        })
    }

    pub(super) fn set_read(&mut self, who: &str, channel: &str, upto: i64, at: i64) -> Result<(), ApiError> {
        db::set_read_cursor(&self.db, who, channel, upto, at).q()?;
        if who == USER_ID {
            self.model.user_read_to(channel, upto);
        }
        Ok(())
    }

    pub(super) fn touch_channel(&mut self, id: &str, number: i64) -> Result<(), ApiError> {
        db::touch_channel(&self.db, id, number).q()?;
        self.model.touched(id, number);
        Ok(())
    }

    /// The thread under a message, made if there is none.
    pub(super) fn thread_for(&mut self, root_id: &str, root_number: i64, channel: &str, subject: &ThreadSubject) -> Result<String, ApiError> {
        if let Some(existing) = self.model.thread_of_root(root_id).filter(|t| !t.is_empty()) {
            return Ok(existing.to_string());
        }
        let id = new_id();
        let at = now();
        let subject_id = (!subject.id.is_empty()).then_some(subject.id.as_str());
        db::create_thread(&self.db, &id, root_id, root_number, subject.kind.as_str(), subject_id, channel, at).q()?;
        self.model.created(ChannelRow {
            root_id: Some(root_id.into()),
            root_number: Some(root_number),
            subject_kind: Some(subject.kind.as_str().into()),
            subject_id: subject_id.map(str::to_string),
            parent_id: Some(channel.into()),
            ..ChannelRow::empty(&id, "thread", at)
        });
        if !subject.owner.is_empty() {
            self.add_member(&id, &subject.owner, "user", root_number)?;
        }
        Ok(id)
    }

    pub(super) fn is_orchestrator_seat(&self, id: &str) -> bool {
        self.model
            .participant(id)
            .is_some_and(|p| p.kind == "agent" && p.agent_id.is_none() && p.left_at.is_none())
    }

    fn orchestrator_seats(&self) -> Vec<String> {
        self.model
            .participants()
            .iter()
            .filter(|p| self.is_orchestrator_seat(&p.id))
            .map(|p| p.id.clone())
            .collect()
    }

    fn top_of_row<'a>(&'a self, row: Option<&'a ChannelRow>) -> Option<&'a ChannelRow> {
        match row {
            Some(r) if r.r#type == "thread" => self.top_of_row(r.parent_id.as_deref().and_then(|p| self.model.channel(p))),
            other => other,
        }
    }

    fn members_of_row(&self, row: Option<&ChannelRow>) -> Vec<String> {
        match self.top_of_row(row) {
            Some(top) if top.r#type != "direct" => self.model.members_of(&top.id),
            _ => vec![],
        }
    }

    /// The orchestrator a place's unaddressed words go to.
    fn orchestrator_in_row(&self, row: Option<&ChannelRow>) -> String {
        if let Some(top) = self.top_of_row(row)
            && top.r#type == "direct"
        {
            return top
                .peer_id
                .clone()
                .filter(|p| self.is_orchestrator_seat(p))
                .unwrap_or_else(|| DEFAULT_ORCHESTRATOR.into());
        }
        let members = self.members_of_row(row);
        if members.iter().any(|m| m == DEFAULT_ORCHESTRATOR) {
            return DEFAULT_ORCHESTRATOR.into();
        }
        members
            .into_iter()
            .find(|m| self.is_orchestrator_seat(m))
            .unwrap_or_else(|| DEFAULT_ORCHESTRATOR.into())
    }

    pub(super) fn orchestrator_in(&self, id: &str) -> String {
        self.orchestrator_in_row(self.model.channel(id))
    }

    fn channel_name(&self, id: &str) -> Option<String> {
        self.model.channel(id).filter(|c| c.r#type != "thread").and_then(|c| c.name.clone())
    }

    pub(super) fn channel_tags(&self) -> String {
        let mut named: Vec<&ChannelRow> = vec![];
        let all = self.model.channels("channel");
        for c in &all {
            if c.name.is_some() {
                named.push(c);
            }
        }
        named.sort_by(|a, b| a.id.cmp(&b.id));
        list(&named.iter().map(|c| format!("#{}", c.name.as_deref().unwrap_or(""))).collect::<Vec<_>>())
    }

    fn direct_with(&self, who: &str, other: &str) -> Option<ChannelRow> {
        let peer = if who == USER_ID {
            other
        } else if other == USER_ID {
            who
        } else {
            ""
        };
        self.model.channels("direct").into_iter().find(|c| c.peer_id.as_deref() == Some(peer))
    }

    pub(super) fn target_of_row(
        &self,
        kind: &str,
        root_number: Option<i64>,
        name: Option<&str>,
        channel_id: Option<&str>,
        channel_name_of: Option<&str>,
    ) -> String {
        let shown = name.or(channel_name_of);
        let channel = channel_name_of
            .map(str::to_string)
            .or_else(|| channel_id.and_then(|c| self.channel_name(c)))
            .unwrap_or_default();
        words::target_of(kind, root_number, shown, &channel)
    }

    pub(super) fn target_of_channel(&self, row: &ChannelRow) -> String {
        self.target_of_row(&row.r#type, row.root_number, row.name.as_deref(), row.parent_id.as_deref(), None)
    }

    pub(super) fn to_channel(&self, row: &ChannelRow, unread: i64, title: String, last: Option<&MsgRow>) -> Channel {
        Channel {
            id: row.id.clone(),
            r#type: channel_type(&row.r#type),
            default: row.is_default,
            peer: row.peer_id.clone(),
            orchestrator: Some(self.orchestrator_in_row(Some(row))),
            members: (row.r#type != "direct").then(|| self.model.members_of(&row.id)),
            parent: row.parent_id.clone(),
            category: row.category.clone().unwrap_or_default(),
            position: row.position,
            archived: row.archived_at,
            notify: notify_of(&row.notify),
            root: row.root_id.clone(),
            root_number: row.root_number,
            name: row.name.clone(),
            description: row.description.clone().unwrap_or_default(),
            repo: row.repo.clone(),
            subject_kind: subject_kind(row.subject_kind.as_deref()),
            subject_id: row.subject_id.clone(),
            last_number: row.last_number,
            replies: row.reply_count,
            read: self.model.user_read_in(&row.id),
            unread: (unread > 0).then_some(unread),
            title,
            last: last.map(|m| ChannelLast {
                from: m.sender_id.clone(),
                name: m.sender_name.clone(),
                text: line_of(&m.body, LAST_MAX),
                at: m.created_at,
            }),
            at: row.created_at,
        }
    }

    /// `counted`: a channel as a page lists it, with the user's unread and
    /// a title.
    pub(super) fn counted(&self, row: &ChannelRow) -> Result<Channel, ApiError> {
        let n = match row.notify.as_str() {
            "none" => 0,
            "mentions" => db::user_mentions(&self.db).q()?.iter().filter(|m| m.row.channel_id == row.id).count() as i64,
            _ => db::user_unread(&self.db, &row.id, self.model.user_read_in(&row.id).unwrap_or(0)).q()?,
        };
        let sk = row.subject_kind.as_deref();
        let mut title = String::new();
        if row.r#type == "thread" && row.name.as_deref().is_some_and(|n| !n.is_empty()) {
            title = row.name.clone().unwrap_or_default();
        } else if row.r#type == "direct"
            && let Some(peer) = &row.peer_id
        {
            title = self.model.participant(peer).map(|p| p.name.clone()).unwrap_or_default();
        } else if row.r#type == "thread"
            && sk == Some("talk")
            && let Some(s) = &row.subject_id
        {
            title = self.model.participant(s).map(|p| p.name.clone()).unwrap_or_default();
        }
        if title.is_empty()
            && row.r#type == "thread"
            && let Some(root) = &row.root_id
        {
            let body = db::message_by_id(&self.db, root).q()?.map(|m| m.body).unwrap_or_default();
            title = line_of(&body, THREAD_TITLE_MAX);
        }
        let last = match row.last_number {
            Some(n) if n != 0 => db::message_by_number(&self.db, &row.id, n).q()?,
            _ => None,
        };
        Ok(self.to_channel(row, n, title, last.as_ref()))
    }

    pub(super) fn home_of(&self, participant: &str) -> Option<String> {
        self.model
            .participant(participant)
            .and_then(|p| p.home_id.clone())
            .filter(|h| self.model.channel(h).is_some())
    }

    pub(super) fn place_of(&self, row: &ChannelRow) -> Place {
        Place {
            id: row.id.clone(),
            r#type: channel_type(&row.r#type),
            peer: row.peer_id.clone(),
            parent: row.parent_id.clone(),
            name: row.name.clone(),
            last_number: row.last_number.unwrap_or(0),
            root: row.root_id.clone().zip(row.root_number),
            topic: subject_kind(row.subject_kind.as_deref()).zip(row.subject_id.clone()),
        }
    }

    pub(super) fn addressed_of(&self, row: &MsgRow, files: &Attachments) -> AddressedMessage {
        let meta = meta_of(row.meta.as_deref());
        let gone = row.deleted_at.is_some_and(|d| d != 0);
        let attached = meta.attachments.unwrap_or_default();
        AddressedMessage {
            id: row.id.clone(),
            number: row.number,
            target: self.model.channel(&row.channel_id).map(|p| self.target_of_channel(p)).unwrap_or_default(),
            from: row.sender_id.clone(),
            actor: actor_of(&row.sender_kind, row.sender_agent.as_deref(), &row.sender_id, Some(&row.sender_name)),
            name: row.sender_name.clone(),
            text: row.body.clone(),
            reply_to: row.reply_number,
            edited: row.edited_at.is_some_and(|e| e != 0).then_some(true),
            deleted: gone.then_some(true),
            attachments: (!attached.is_empty()).then(|| {
                attached
                    .iter()
                    .map(|f| FileAt {
                        name: f.name.clone(),
                        path: files.path_of(&f.id).to_string_lossy().into_owned(),
                    })
                    .collect()
            }),
            artifact: meta.artifact.filter(|_| !gone).map(|a| ArtifactRef {
                id: a.id,
                title: a.title,
                version: a.version,
            }),
            blocks: meta.blocks.filter(|b| !b.is_empty() && !gone),
            view_context: meta.view_context.filter(|_| !gone),
            picked: meta.picked,
            response_port: meta.response_port.filter(|s| !s.is_empty()),
            voice_mode: meta.voice_mode.filter(|s| !s.is_empty()),
        }
    }

    /// A participant's unread: the channel given, or the one its home is
    /// in (else the default), and the threads it follows.
    pub(super) fn unread_of(&self, who: &str, in_channel: Option<&str>) -> Result<Vec<ChannelUnread>, ApiError> {
        let channel = in_channel
            .map(str::to_string)
            .or_else(|| self.home_of(who).and_then(|h| self.top_of_row(self.model.channel(&h)).map(|t| t.id.clone())))
            .unwrap_or_else(|| self.model.default_id());
        Ok(db::unread_of(&self.db, who, &channel)
            .q()?
            .into_iter()
            .map(|r| ChannelUnread {
                channel: words::target_of(&r.r#type, r.root_number, None, &r.channel_name),
                unread: r.unread,
                mentions_you: r.mentions_you,
                latest: r.latest_sender_name.filter(|n| !n.is_empty()),
            })
            .collect())
    }

    /// `resolveTarget`: an address as `who` would mean it.
    pub(super) fn resolve_target(&mut self, who: &str, target: &str) -> Result<(String, Option<String>), ApiError> {
        if target.trim().is_empty() {
            return Ok((self.home_of(who).unwrap_or_else(|| self.model.default_id()), None));
        }
        let parsed = words::parse_chat_target(target).ok_or_else(|| refused(t("server.channel.badTarget", &[("target", target.into())])))?;
        let root = match parsed {
            ChatTarget::Direct(peer) => {
                let direct = self
                    .direct_with(who, &peer)
                    .ok_or_else(|| refused(t("server.channel.noDirect", &[("target", target.trim().into())])))?;
                return Ok((direct.id, None));
            }
            ChatTarget::Channel(_) => None,
            ChatTarget::Thread(n) => Some(n),
        };
        let trimmed = target.trim();
        let text = trimmed.strip_prefix('#').unwrap_or(trimmed);
        let name = text.split(':').next().unwrap_or("");
        let mut channel = self.model.default_id();
        if !name.is_empty() {
            let found = self.model.channel_by_name(name).ok_or_else(|| {
                missing(
                    t("server.channel.noChannelNamed", &[("name", name.into()), ("tags", self.channel_tags().into())]),
                    LookIn::Channel,
                )
            })?;
            channel = found.id.clone();
        }
        let Some(root) = root else { return Ok((channel, None)) };
        let row = db::message_by_number(&self.db, &channel, root)
            .q()?
            .ok_or_else(|| refused(t("server.channel.noMessage", &[("n", root.into())])))?;
        let talk = ThreadSubject {
            kind: SubjectKind::Talk,
            id: String::new(),
            owner: String::new(),
        };
        let thread = tx(self, |me| me.thread_for(&row.id, row.number, &row.channel_id, &talk))?;
        Ok((thread.clone(), Some(thread)))
    }

    pub(super) fn answered(&self, channel: &str, number: Option<i64>) -> Result<(), ApiError> {
        if let Some(n) = number
            && db::message_by_number(&self.db, channel, n).q()?.is_none()
        {
            return Err(refused(t("server.channel.noMessage", &[("n", n.into())])));
        }
        Ok(())
    }

    pub(super) fn message_of(&self, id: &str) -> Result<MsgRow, ApiError> {
        db::message_by_id(&self.db, id)
            .q()?
            .ok_or_else(|| missing(t("server.channel.noMessageId", &[("id", id.into())]), LookIn::Channel))
    }

    /// `settle`: who a message names, and who follows the thread from it.
    pub(super) fn settle(&mut self, inserted: MsgRow) -> Result<(MsgRow, Vec<String>), ApiError> {
        let mut row = inserted;
        let ch = self
            .model
            .channel(&row.channel_id)
            .cloned()
            .ok_or_else(|| internal(format!("no channel {}", row.channel_id)))?;
        let mut meta = meta_of(row.meta.as_deref());
        let orchestrators = self.orchestrator_seats();
        let here = self.orchestrator_in_row(Some(&ch));
        let mentions = if ch.r#type == "direct" {
            vec![]
        } else {
            words::mentions_in(
                &row.body,
                &Nameable {
                    here: &here,
                    orchestrators: &orchestrators,
                },
            )
        };
        let helper = |p: &ParticipantRow| p.kind == "agent" && p.agent_id.is_some() && p.left_at.is_none();
        let present: Vec<String> = self.model.participants().iter().filter(|p| helper(p)).map(|p| p.id.clone()).collect();
        let mut named: Vec<(String, &str)> = vec![];
        for m in &mentions {
            let how = if orchestrators.contains(m) || m == USER_ID || m == EVERYONE || present.contains(m) {
                "delivered"
            } else if self.model.participant(m).is_some() {
                "absent"
            } else {
                "unknown"
            };
            db::insert_mention(&self.db, &row.id, m, how).q()?;
            named.push((m.clone(), how));
        }
        if !mentions.is_empty() {
            meta.mentions = Some(mentions);
            row.meta = meta_text(Some(&meta));
            db::update_message_meta(&self.db, &row.id, row.meta.as_deref()).q()?;
        }
        if ch.r#type == "thread" {
            // A dispatch handing the issue on makes no one a member: the orchestrator would be woken by every word in it.
            if row.sender_id != "system" && row.kind != "dispatch" {
                self.add_member(&ch.id, &row.sender_id, "replied", row.number)?;
            }
            for (m, how) in &named {
                if *how == "delivered" && (orchestrators.contains(m) || present.contains(m)) {
                    self.add_member(&ch.id, m, "mentioned", row.number - 1)?;
                }
            }
        }
        let absent = named.into_iter().filter(|(_, how)| *how != "delivered").map(|(m, _)| m).collect();
        Ok((row, absent))
    }

    pub(super) fn committed_from(&self, row: &MsgRow, event: &EventRow) -> Option<Committed> {
        let ch = self.model.channel(&row.channel_id)?;
        let topic = if ch.r#type != "channel" {
            subject_kind(ch.subject_kind.as_deref()).zip(ch.subject_id.clone())
        } else {
            None
        };
        Some(Committed {
            event: event.clone(),
            row: row.clone(),
            place: self.place_of(ch),
            channel_name: ch
                .parent_id
                .as_deref()
                .and_then(|p| self.model.channel(p))
                .and_then(|p| p.name.clone())
                .or_else(|| ch.name.clone())
                .unwrap_or_default(),
            mentions: meta_of(row.meta.as_deref()).mentions.unwrap_or_default(),
            channel_type: channel_type(&ch.r#type),
            peer: ch.peer_id.clone(),
            orchestrator: self.orchestrator_in_row(Some(ch)),
            channel_members: self.members_of_row(Some(ch)),
            members: if ch.r#type == "thread" { self.model.members_of(&ch.id) } else { vec![] },
            topic,
        })
    }

    /// `answersOf`: a helper's words answer the session that last named it
    /// there since it last spoke.
    pub(super) fn answers_of(&self, row: &MsgRow) -> Result<Option<String>, ApiError> {
        if row.kind != "chat" || row.sender_kind != "agent" || self.is_orchestrator_seat(&row.sender_id) {
            return Ok(None);
        }
        let callers = db::callers_of(&self.db, &row.sender_id, &row.channel_id, &row.id, CALLERS_MAX).q()?;
        Ok(callers
            .into_iter()
            .find(|c| self.model.participant(c).is_some_and(|p| p.kind == "agent" && p.agent_id.is_some())))
    }
}
