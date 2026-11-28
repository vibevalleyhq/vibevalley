//! The chat kept in memory beside its tables: changed only after the write it
//! mirrors is committed via [`crate::service::ChannelService`].

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use arc_swap::ArcSwap;
use vibevalley_core::rules::compare_text;
use vibevalley_i18n::{list, t};
use vibevalley_kit::db::tx::PostCommitHooks;
use vibevalley_protocol::{ApiError, Channel, ChannelLast, ChannelUnread, DEFAULT_ORCHESTRATOR, EVERYONE, ParticipantId};

use super::types::{
    AddressedMessage, CALLERS_MAX, Committed, FileAt, LAST_MAX, NoteRef, Place, Reach, Seat, THREAD_TITLE_MAX, ThreadSubject, actor_of, channel_type, line_of,
    local_user_id, meta_of, meta_text, new_id, notify_of, subject_kind,
};
use super::words::{self, Nameable};
use crate::context::{LookIn, internal, missing, now};
use crate::service::channel::{ChannelRow, ChannelService, EventRow, MsgRow, NewThread, ParticipantRow};
use crate::service::{DbError, Service, Tx};
use crate::storage::Storage;

pub(super) trait Q<T> {
    fn q(self) -> Result<T, ApiError>;
}

impl<T> Q<T> for Result<T, DbError> {
    fn q(self) -> Result<T, ApiError> {
        self.map_err(internal)
    }
}

fn subject_key(kind: &str, id: &str) -> String {
    format!("{kind}:{id}")
}

/// Who is in each place.
#[derive(Clone, Default)]
pub struct Members {
    members: HashMap<String, BTreeSet<String>>,
}

impl Members {
    pub fn load(&mut self, follows: &[(String, String)]) {
        self.members.clear();
        for (c, p) in follows {
            self.member_added(c, p);
        }
    }

    pub fn member_added(&mut self, channel: &str, participant: &str) {
        self.members.entry(channel.into()).or_default().insert(participant.into());
    }

    pub fn member_removed(&mut self, channel: &str, participant: &str) {
        if let Some(held) = self.members.get_mut(channel)
            && held.remove(participant)
            && held.is_empty()
        {
            self.members.remove(channel);
        }
    }

    pub fn channel_removed(&mut self, channel: &str) {
        self.members.remove(channel);
    }

    pub fn left(&mut self, participant: &str) {
        self.members.retain(|_, held| {
            held.remove(participant);
            !held.is_empty()
        });
    }

    /// Sorted.
    pub fn members_of(&self, channel: &str) -> Vec<String> {
        self.members.get(channel).map(|m| m.iter().cloned().collect()).unwrap_or_default()
    }
}

#[derive(Clone, Default)]
pub struct ChatModel {
    by_id: HashMap<String, ChannelRow>,
    thread_by_root: HashMap<String, String>,
    thread_by_subject: HashMap<String, String>,
    people: Vec<ParticipantRow>,
    /// Per-participant read cursor `(participant_id, channel_id) -> read_number`.
    read_cursors: HashMap<(String, String), i64>,
    members: Members,
    /// The target each participant last read, for `speak`'s confirmation.
    pub last_read: HashMap<String, String>,
    published_last: HashMap<String, i64>,
}

/// Write-side state under `Chat::inner`: the committed `ChatModel` staged
/// inside transactions, delivery loop-guard state, and the atomic snapshot
/// handle published on commit. Read-only queries bypass this lock and read
/// `Chat::snapshot` + `ctx.service.channel` directly.
pub struct Inner {
    pub(super) model: ChatModel,
    pub(super) reach: Reach,
    pub(super) snapshot: Arc<ArcSwap<ChatModel>>,
}

impl Inner {
    pub(super) fn publish_snapshot(&self) {
        self.snapshot.store(Arc::new(self.model.clone()));
    }
}

/// Stages in-memory `ChatModel` and `Reach` mutations alongside an open
/// write transaction. Dropping without [`WriteTx::commit`]
/// rolls back automatically and leaves [`Inner`] untouched; on commit,
/// the new `ChatModel` is published atomically to lock-free readers via `snapshot`.
pub(super) struct WriteTx<'a> {
    inner: &'a mut Inner,
    service: &'a Service,
    pub(super) model: ChatModel,
    pub(super) reach: Reach,
    pub(super) tx: Tx,
    pub(super) hooks: PostCommitHooks,
}

impl<'a> WriteTx<'a> {
    pub(super) async fn begin(inner: &'a mut Inner, service: &'a Service) -> Result<Self, ApiError> {
        let tx = service.begin_tx().await.q()?;
        Ok(Self {
            model: inner.model.clone(),
            reach: inner.reach.clone(),
            inner,
            service,
            tx,
            hooks: PostCommitHooks::new(),
        })
    }

    pub(super) async fn commit(self) -> Result<(), ApiError> {
        self.service.commit_tx(self.tx).await.q()?;
        self.inner.model = self.model;
        self.inner.reach = self.reach;
        self.inner.publish_snapshot();
        let _ = self.hooks.fire();
        Ok(())
    }

    pub(super) async fn ensure_human(&mut self, participant: &ParticipantId, name: Option<&str>) -> Result<(), ApiError> {
        let id = participant.to_string();
        if self.model.participant(&id).is_some_and(|p| p.kind == "user" && p.left_at.is_none()) {
            return Ok(());
        }
        let display = name.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| {
            if participant == &ParticipantId::local_user() {
                t("server.channel.name.user", &[])
            } else {
                participant.raw_id().to_string()
            }
        });
        self.upsert_participant(ParticipantRow {
            id,
            kind: "user".into(),
            name: display,
            agent_id: None,
            home_id: None,
            joined_at: now(),
            left_at: None,
        })
        .await
    }

    pub(super) async fn add_member(&mut self, channel: &str, participant: &str, reason: &str, from: i64) -> Result<(), ApiError> {
        self.service.channel.add_member_in_tx(&self.tx, channel, participant, reason, from).await.q()?;
        self.model.member_added(channel, participant);
        Ok(())
    }

    async fn upsert_participant(&mut self, p: ParticipantRow) -> Result<(), ApiError> {
        self.service.channel.upsert_participant_in_tx(&self.tx, &p).await.q()?;
        self.model.joined(p);
        Ok(())
    }

    /// An agent's seat as it goes now; one already so is left as it is.
    pub(super) async fn seat(&mut self, p: &Seat) -> Result<(), ApiError> {
        if self.model.seat_matches(p) {
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
        .await
    }

    pub(super) async fn set_read(&mut self, who: &str, channel: &str, upto: i64, at: i64) -> Result<(), ApiError> {
        self.service.channel.set_read_cursor_in_tx(&self.tx, who, channel, upto, at).await.q()?;
        self.model.read_to(who, channel, upto);
        Ok(())
    }

    pub(super) async fn touch_channel(&mut self, id: &str, number: i64) -> Result<(), ApiError> {
        self.service.channel.touch_channel_in_tx(&self.tx, id, number).await.q()?;
        self.model.touched(id, number);
        Ok(())
    }

    /// The thread under a message, made if there is none.
    pub(super) async fn thread_for(&mut self, root_id: &str, root_number: i64, channel: &str, subject: &ThreadSubject) -> Result<String, ApiError> {
        if let Some(existing) = self.model.thread_of_root(root_id).filter(|t| !t.is_empty()) {
            return Ok(existing.to_string());
        }
        let id = new_id();
        let at = now();
        let subject_id = (!subject.id.is_empty()).then_some(subject.id.as_str());
        self.service
            .channel
            .create_thread_in_tx(
                &self.tx,
                &NewThread {
                    id: &id,
                    root_id,
                    root_number,
                    subject_kind: subject.kind.as_str(),
                    subject_id,
                    parent_id: channel,
                    at,
                },
            )
            .await
            .q()?;
        self.model.created(ChannelRow {
            root_id: Some(root_id.into()),
            root_number: Some(root_number),
            subject_kind: Some(subject.kind.as_str().into()),
            subject_id: subject_id.map(str::to_string),
            parent_id: Some(channel.into()),
            ..ChannelRow::empty(&id, "thread", at)
        });
        if !subject.owner.is_empty() {
            self.add_member(&id, &subject.owner, "user", root_number).await?;
        }
        Ok(id)
    }

    /// `settle`: who a message names, and who follows the thread from it.
    pub(super) async fn settle(&mut self, inserted: MsgRow) -> Result<(MsgRow, Vec<String>), ApiError> {
        let mut row = inserted;
        let ch = self
            .model
            .channel(&row.channel_id)
            .cloned()
            .ok_or_else(|| internal(format!("no channel {}", row.channel_id)))?;
        let mut meta = meta_of(row.meta.as_deref());
        let orchestrators = self.model.orchestrator_seats();
        let humans = self.model.human_names();
        let here = self.model.orchestrator_in_row(Some(&ch));
        let mentions = if ch.r#type == "direct" {
            vec![]
        } else {
            words::mentions_in(
                &row.body,
                &Nameable {
                    here: &here,
                    orchestrators: &orchestrators,
                    humans: &humans,
                },
            )
        };
        let helper = |p: &ParticipantRow| p.kind == "agent" && p.agent_id.is_some() && p.left_at.is_none();
        let present: Vec<String> = self.model.participants().iter().filter(|p| helper(p)).map(|p| p.id.clone()).collect();
        let active_humans: Vec<String> = self
            .model
            .participants()
            .iter()
            .filter(|p| p.kind == "user" && p.left_at.is_none())
            .map(|p| p.id.clone())
            .collect();
        let mut named: Vec<(String, &str)> = vec![];
        for m in &mentions {
            let how = if orchestrators.contains(m) || active_humans.contains(m) || m == EVERYONE || present.contains(m) {
                "delivered"
            } else if self.model.participant(m).is_some() {
                "absent"
            } else {
                "unknown"
            };
            self.service.channel.insert_mention_in_tx(&self.tx, &row.id, m, how).await.q()?;
            named.push((m.clone(), how));
        }
        if !mentions.is_empty() {
            meta.mentions = Some(mentions);
            row.meta = meta_text(Some(&meta));
            self.service
                .channel
                .update_message_meta_in_tx(&self.tx, &row.id, row.meta.as_deref())
                .await
                .q()?;
        }
        if ch.r#type == "thread" {
            // A dispatch handing the issue on makes no one a member: the orchestrator would be woken by every word in it.
            if row.sender_id != "system" && row.kind != "dispatch" {
                self.add_member(&ch.id, &row.sender_id, "replied", row.number).await?;
            }
            for (m, how) in &named {
                if *how == "delivered" && (orchestrators.contains(m) || present.contains(m)) {
                    self.add_member(&ch.id, m, "mentioned", row.number - 1).await?;
                }
            }
        }
        let absent = named.into_iter().filter(|(_, how)| *how != "delivered").map(|(m, _)| m).collect();
        Ok((row, absent))
    }

    pub(super) fn committed_from(&self, row: &MsgRow, event: &EventRow) -> Option<Committed> {
        self.model.committed_from(row, event)
    }
}

pub(super) async fn message_of(channels: &ChannelService, id: &str) -> Result<MsgRow, ApiError> {
    channels
        .message_by_id(id)
        .await
        .q()?
        .ok_or_else(|| missing(t("server.channel.noMessageId", &[("id", id.into())]), LookIn::Channel))
}

impl ChatModel {
    pub fn load(&mut self, channels: Vec<ChannelRow>, participants: Vec<ParticipantRow>, user_read: Vec<(String, i64)>, follows: &[(String, String)]) {
        *self = ChatModel::default();
        for c in channels {
            self.created(c);
        }
        self.people = participants;
        let local = local_user_id();
        self.read_cursors = user_read.into_iter().map(|(ch, n)| ((local.clone(), ch), n)).collect();
        self.members.load(follows);
    }

    pub fn channel(&self, id: &str) -> Option<&ChannelRow> {
        self.by_id.get(id)
    }

    pub fn thread_of_root(&self, root: &str) -> Option<&str> {
        self.thread_by_root.get(root).map(String::as_str)
    }

    /// The newest thread about a subject (thread ids sort by time).
    pub fn thread_of_subject(&self, kind: &str, id: &str) -> Option<&str> {
        self.thread_by_subject.get(&subject_key(kind, id)).map(String::as_str)
    }

    pub fn default_channel(&self) -> Option<&ChannelRow> {
        self.by_id.values().find(|c| c.is_default)
    }

    pub fn default_id(&self) -> String {
        self.default_channel().map(|c| c.id.clone()).unwrap_or_default()
    }

    /// A direct channel's, or what is not there's, is the default channel.
    pub fn top_channel(&self, id: &str) -> Option<&ChannelRow> {
        match self.by_id.get(id) {
            None => self.default_channel(),
            Some(row) if row.r#type == "direct" => self.default_channel(),
            Some(row) if row.r#type == "thread" => row.parent_id.as_deref().and_then(|p| self.by_id.get(p)).or_else(|| self.default_channel()),
            Some(row) => Some(row),
        }
    }

    pub fn channel_by_name(&self, name: &str) -> Option<&ChannelRow> {
        self.by_id.values().find(|c| c.name.as_deref() == Some(name) && c.r#type == "channel")
    }

    /// The default first, then by place, then oldest.
    pub fn channels(&self, kind: &str) -> Vec<ChannelRow> {
        let mut all: Vec<ChannelRow> = self.by_id.values().filter(|c| c.r#type == kind).cloned().collect();
        let place = |c: &ChannelRow| c.position.unwrap_or(i64::MAX);
        all.sort_by(|a, b| {
            b.is_default
                .cmp(&a.is_default)
                .then(place(a).cmp(&place(b)))
                .then_with(|| compare_text(&a.id, &b.id))
        });
        all
    }

    pub fn threads_of(&self, channel: &str) -> Vec<ChannelRow> {
        self.by_id.values().filter(|c| c.parent_id.as_deref() == Some(channel)).cloned().collect()
    }

    pub fn created(&mut self, row: ChannelRow) {
        if let Some(root) = &row.root_id {
            self.thread_by_root.insert(root.clone(), row.id.clone());
        }
        if let (Some(kind), Some(id)) = (&row.subject_kind, &row.subject_id) {
            let key = subject_key(kind, id);
            if self.thread_by_subject.get(&key).is_none_or(|held| held.as_str() < row.id.as_str()) {
                self.thread_by_subject.insert(key, row.id.clone());
            }
        }
        self.by_id.insert(row.id.clone(), row);
    }

    pub fn patch(&mut self, id: &str, f: impl FnOnce(&mut ChannelRow)) {
        if let Some(c) = self.by_id.get_mut(id) {
            f(c);
        }
    }

    pub fn removed(&mut self, id: &str) {
        let gone: Vec<ChannelRow> = self
            .by_id
            .values()
            .filter(|c| c.id == id || c.parent_id.as_deref() == Some(id))
            .cloned()
            .collect();
        for c in gone {
            self.by_id.remove(&c.id);
            self.read_cursors.retain(|(_, ch), _| ch != &c.id);
            self.published_last.remove(&c.id);
            self.members.channel_removed(&c.id);
            if let Some(root) = &c.root_id {
                self.thread_by_root.remove(root);
            }
            if let (Some(kind), Some(sid)) = (&c.subject_kind, &c.subject_id) {
                let key = subject_key(kind, sid);
                if self.thread_by_subject.get(&key) == Some(&c.id) {
                    self.thread_by_subject.remove(&key);
                }
            }
        }
    }

    /// `markUnread` moves a participant's cursor back.
    pub fn read_back(&mut self, viewer: &str, channel: &str, number: i64) {
        self.read_cursors.insert((viewer.into(), channel.into()), number);
    }

    pub fn default_moved(&mut self, from: &str, to: &str) {
        self.patch(from, |c| c.is_default = false);
        self.patch(to, |c| c.is_default = true);
    }

    pub fn touched(&mut self, id: &str, number: i64) {
        self.patch(id, |c| {
            c.last_number = Some(c.last_number.unwrap_or(0).max(number));
            if c.r#type == "thread" {
                c.reply_count += 1;
            }
        });
    }

    pub fn participants(&self) -> &[ParticipantRow] {
        &self.people
    }

    pub fn participant(&self, id: &str) -> Option<&ParticipantRow> {
        self.people.iter().find(|p| p.id == id)
    }

    /// One who rejoins keeps its kind and when it first joined; a home of
    /// none keeps the one it had.
    pub fn joined(&mut self, p: ParticipantRow) {
        if let Some(held) = self.people.iter_mut().find(|h| h.id == p.id) {
            held.name = p.name;
            held.agent_id = p.agent_id;
            if p.home_id.is_some() {
                held.home_id = p.home_id;
            }
            held.left_at = None;
        } else {
            self.people.push(ParticipantRow { left_at: None, ..p });
        }
    }

    pub fn left(&mut self, id: &str, at: i64) {
        self.members.left(id);
        self.last_read.remove(id);
        if let Some(p) = self.people.iter_mut().find(|p| p.id == id)
            && p.left_at.is_none()
        {
            p.left_at = Some(at);
        }
    }

    pub fn member_added(&mut self, channel: &str, participant: &str) {
        self.members.member_added(channel, participant);
    }

    pub fn member_removed(&mut self, channel: &str, participant: &str) {
        self.members.member_removed(channel, participant);
    }

    pub fn members_of(&self, channel: &str) -> Vec<String> {
        self.members.members_of(channel)
    }

    pub fn published_number(&self, channel: &str) -> Option<i64> {
        self.published_last.get(channel).copied()
    }

    pub fn note_published(&mut self, channel: &str, number: i64) {
        let n = self.published_last.entry(channel.into()).or_insert(0);
        *n = (*n).max(number);
    }

    pub fn read_in(&self, viewer: &str, channel: &str) -> Option<i64> {
        self.read_cursors.get(&(viewer.into(), channel.into())).copied()
    }

    pub fn read_to(&mut self, viewer: &str, channel: &str, number: i64) {
        let n = self.read_cursors.entry((viewer.into(), channel.into())).or_insert(number);
        *n = (*n).max(number);
    }

    pub(super) fn human_names(&self) -> Vec<(String, String)> {
        self.participants()
            .iter()
            .filter(|p| p.kind == "user" && p.left_at.is_none())
            .map(|p| (p.id.clone(), p.name.clone()))
            .collect()
    }

    pub(super) fn seat_matches(&self, p: &Seat) -> bool {
        self.participant(&p.id).is_some_and(|held| {
            held.kind == "agent"
                && held.name == p.name
                && held.agent_id == p.agent
                && held.left_at.is_none()
                && p.home.as_ref().is_none_or(|h| Some(h) == held.home_id.as_ref())
        })
    }

    pub(super) fn is_orchestrator_seat(&self, id: &str) -> bool {
        self.participant(id)
            .is_some_and(|p| p.kind == "agent" && p.agent_id.is_none() && p.left_at.is_none())
    }

    pub(super) fn orchestrator_seats(&self) -> Vec<String> {
        self.participants()
            .iter()
            .filter(|p| self.is_orchestrator_seat(&p.id))
            .map(|p| p.id.clone())
            .collect()
    }

    pub(super) fn top_of_row<'a>(&'a self, row: Option<&'a ChannelRow>) -> Option<&'a ChannelRow> {
        match row {
            Some(r) if r.r#type == "thread" => self.top_of_row(r.parent_id.as_deref().and_then(|p| self.channel(p))),
            other => other,
        }
    }

    pub(super) fn members_of_row(&self, row: Option<&ChannelRow>) -> Vec<String> {
        match self.top_of_row(row) {
            Some(top) if top.r#type != "direct" => self.members_of(&top.id),
            _ => vec![],
        }
    }

    /// The orchestrator a place's unaddressed words go to.
    pub(super) fn orchestrator_in_row(&self, row: Option<&ChannelRow>) -> String {
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
        self.orchestrator_in_row(self.channel(id))
    }

    fn channel_name(&self, id: &str) -> Option<String> {
        self.channel(id).filter(|c| c.r#type != "thread").and_then(|c| c.name.clone())
    }

    pub(super) fn channel_tags(&self) -> String {
        let mut named: Vec<&ChannelRow> = vec![];
        let all = self.channels("channel");
        for c in &all {
            if c.name.is_some() {
                named.push(c);
            }
        }
        named.sort_by(|a, b| a.id.cmp(&b.id));
        list(&named.iter().map(|c| format!("#{}", c.name.as_deref().unwrap_or(""))).collect::<Vec<_>>())
    }

    pub(super) fn direct_with(&self, who: &str, other: &str) -> Option<ChannelRow> {
        let local = local_user_id();
        self.channels("direct").into_iter().find(|c| {
            let ms = self.members_of(&c.id);
            if ms.iter().any(|m| m == who) && ms.iter().any(|m| m == other) {
                return true;
            }
            if who == local {
                c.peer_id.as_deref() == Some(other)
            } else if other == local {
                c.peer_id.as_deref() == Some(who)
            } else {
                false
            }
        })
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
            members: (row.r#type != "direct").then(|| self.members_of(&row.id)),
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
            read: self.read_in(&local_user_id(), &row.id),
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
    pub(super) async fn counted_async(&self, channels: &ChannelService, row: &ChannelRow) -> Result<Channel, ApiError> {
        let viewer = local_user_id();
        let n = match row.notify.as_str() {
            "none" => 0,
            "mentions" => channels.user_mentions(&viewer).await.q()?.iter().filter(|m| m.row.channel_id == row.id).count() as i64,
            _ => channels.user_unread(&row.id, &viewer, self.read_in(&viewer, &row.id).unwrap_or(0)).await.q()?,
        };
        let sk = row.subject_kind.as_deref();
        let mut title = String::new();
        if row.r#type == "thread" && row.name.as_deref().is_some_and(|n| !n.is_empty()) {
            title = row.name.clone().unwrap_or_default();
        } else if row.r#type == "direct"
            && let Some(peer) = &row.peer_id
        {
            title = self.participant(peer).map(|p| p.name.clone()).unwrap_or_default();
        } else if row.r#type == "thread"
            && sk == Some("talk")
            && let Some(s) = &row.subject_id
        {
            title = self.participant(s).map(|p| p.name.clone()).unwrap_or_default();
        }
        if title.is_empty()
            && row.r#type == "thread"
            && let Some(root) = &row.root_id
        {
            let body = channels.message_by_id(root).await.q()?.map(|m| m.body).unwrap_or_default();
            title = line_of(&body, THREAD_TITLE_MAX);
        }
        let last = match row.last_number {
            Some(n) if n != 0 => channels.message_by_number(&row.id, n).await.q()?,
            _ => None,
        };
        Ok(self.to_channel(row, n, title, last.as_ref()))
    }

    pub(super) fn home_of(&self, participant: &str) -> Option<String> {
        self.participant(participant)
            .and_then(|p| p.home_id.clone())
            .filter(|h| self.channel(h).is_some())
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

    pub(super) fn addressed_of(&self, row: &MsgRow, storage: &Storage) -> AddressedMessage {
        let meta = meta_of(row.meta.as_deref());
        let gone = row.deleted_at.is_some_and(|d| d != 0);
        let attached = meta.attachments.unwrap_or_default();
        AddressedMessage {
            id: row.id.clone(),
            number: row.number,
            target: self.channel(&row.channel_id).map(|p| self.target_of_channel(p)).unwrap_or_default(),
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
                        path: storage.path_of(&f.id).to_string_lossy().into_owned(),
                    })
                    .collect()
            }),
            note: meta.note.filter(|_| !gone).map(|a| NoteRef {
                id: a.id,
                title: a.title,
                version: a.version,
            }),
            view_context: meta.view_context.filter(|_| !gone),
            picked: meta.picked,
            response_port: meta.response_port.filter(|s| !s.is_empty()),
            voice_mode: meta.voice_mode.filter(|s| !s.is_empty()),
        }
    }

    /// A participant's unread: the channel given, or the one its home is
    /// in (else the default), and the threads it follows.
    pub(super) async fn unread_of_async(&self, channels: &ChannelService, who: &str, in_channel: Option<&str>) -> Result<Vec<ChannelUnread>, ApiError> {
        let channel = in_channel
            .map(str::to_string)
            .or_else(|| self.home_of(who).and_then(|h| self.top_of_row(self.channel(&h)).map(|t| t.id.clone())))
            .unwrap_or_else(|| self.default_id());
        Ok(channels
            .unread_of(who, &channel)
            .await
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

    pub(super) fn committed_from(&self, row: &MsgRow, event: &EventRow) -> Option<Committed> {
        let ch = self.channel(&row.channel_id)?;
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
                .and_then(|p| self.channel(p))
                .and_then(|p| p.name.clone())
                .or_else(|| ch.name.clone())
                .unwrap_or_default(),
            mentions: meta_of(row.meta.as_deref()).mentions.unwrap_or_default(),
            channel_type: channel_type(&ch.r#type),
            peer: ch.peer_id.clone(),
            orchestrator: self.orchestrator_in_row(Some(ch)),
            channel_members: self.members_of_row(Some(ch)),
            members: if ch.r#type == "thread" || ch.r#type == "direct" {
                self.members_of(&ch.id)
            } else {
                vec![]
            },
            topic,
        })
    }

    /// `answersOf`: a helper's words answer the session that last named it
    /// there since it last spoke.
    pub(super) async fn answers_of_async(&self, channels: &ChannelService, row: &MsgRow) -> Result<Option<String>, ApiError> {
        if row.kind != "chat" || row.sender_kind != "agent" || self.is_orchestrator_seat(&row.sender_id) {
            return Ok(None);
        }
        let callers = channels.callers_of(&row.sender_id, &row.channel_id, &row.id, CALLERS_MAX).await.q()?;
        Ok(callers
            .into_iter()
            .find(|c| self.participant(c).is_some_and(|p| p.kind == "agent" && p.agent_id.is_some())))
    }
}

#[cfg(test)]
mod tests {
    use super::Members;

    #[test]
    fn members_load_and_update() {
        let mut follows = Members::default();
        follows.load(&[("t".into(), "w3".into())]);
        follows.member_added("t", "w1");
        follows.member_added("t", "w3");
        assert_eq!(follows.members_of("t"), ["w1", "w3"]);
        assert!(follows.members_of("other").is_empty());
    }

    #[test]
    fn a_session_that_left_is_forgotten() {
        let mut follows = Members::default();
        follows.load(&[("t".into(), "w3".into()), ("u".into(), "w3".into()), ("u".into(), "w1".into())]);
        follows.left("w3");
        assert!(follows.members_of("t").is_empty());
        assert_eq!(follows.members_of("u"), ["w1"]);
    }
}
