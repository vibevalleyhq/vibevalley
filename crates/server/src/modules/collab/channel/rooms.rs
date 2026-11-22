use std::sync::Arc;

use vibevalley_i18n::{list, t};
use vibevalley_protocol::{
    ApiError, Channel, ChannelEvent, ChannelUnread, ChannelUpdate, ChatMessage, DEFAULT_ORCHESTRATOR, Fact, FactChannelRemoved, MessageKind, Notify, Preview,
    SubjectKind, USER_ID,
};

use super::db::{self, ChannelRow, DeliveryRow, EventRow, MsgRow, ParticipantRow};
use super::dispatch::{ChannelDispatched, DeliveryTargetKind, HeldBy, QueuedDelivery, Reason};
use super::store::{Inner, Q, tx};
use super::types::{AddressedMessage, Committed, Info, Place, ReadOptions, ReadResult, Seat, Told, head, info_of, new_id, notify_of, optional, to_message};
use super::words;
use super::{CATCH_UP_MAX, Chat, FIRST_CHANNEL, LOG_KEEP, NO_NUMBER, READ_LIMIT, THREAD_TITLE_MAX, no_channel, refused};
use crate::base::{LookIn, internal, missing};
use crate::{Sink, lock, now};

impl Chat {
    /// `placeOf`: a place's id, or an address as `from` would say it.
    pub fn place_of(&self, from: &str, channel: &str) -> Result<String, ApiError> {
        let mut inner = self.locked();
        if inner.model.channel(channel).is_some() {
            return Ok(channel.into());
        }
        let (place, opened) = inner.resolve_target(from, channel)?;
        if let Some(thread) = opened {
            self.publish_channel(&inner, &thread)?;
        }
        Ok(place)
    }

    /// `read`: an agent reads a place; a read of the newest moves its
    /// cursor.
    pub fn read(&self, who: &str, opt: ReadOptions) -> Result<ReadResult, ApiError> {
        self.prepare_seat(who);
        let mut inner = self.locked();
        let (channel, opened) = inner.resolve_target(who, opt.target.as_deref().unwrap_or(""))?;
        if let Some(thread) = opened {
            self.publish_channel(&inner, &thread)?;
        }
        let row = inner
            .model
            .channel(&channel)
            .cloned()
            .ok_or_else(|| refused(t("server.channel.channelGone", &[])))?;
        let target = inner.target_of_channel(&row);
        let limit = match opt.limit {
            Some(l) if l != 0 => l.clamp(1, 100),
            _ => READ_LIMIT,
        };
        let cursor = db::read_cursor(&inner.db, who, &channel).q()?.unwrap_or(0);
        let before = opt.before.filter(|b| *b != 0);
        let rows = if opt.unread {
            db::messages_after(&inner.db, &channel, cursor, limit).q()?
        } else {
            let mut rows = db::messages_before(&inner.db, &channel, before.unwrap_or(NO_NUMBER), limit).q()?;
            rows.reverse();
            rows
        };
        if let Some(newest) = rows.last()
            && before.is_none()
        {
            self.read_through(&mut inner, who, &channel, newest.number)?;
        }
        let keep: Vec<String> = inner.model.last_read.keys().cloned().collect();
        for p in keep {
            if inner.model.participant(&p).is_none_or(|x| x.left_at.is_some()) {
                inner.model.last_read.remove(&p);
            }
        }
        inner.model.last_read.insert(who.into(), target.clone());
        let older = match rows.first() {
            Some(oldest) => !db::messages_before(&inner.db, &channel, oldest.number, 1).q()?.is_empty(),
            None => false,
        };
        let messages = rows.iter().map(|r| inner.addressed_of(r, &self.files)).collect();
        Ok(ReadResult { target, messages, older })
    }

    /// `unread`: a hint for the one asking; a failure is none, logged.
    pub fn unread(&self, who: &str, channel: Option<&str>) -> Vec<ChannelUnread> {
        self.prepare_seat(who);
        let inner = self.locked();
        inner.unread_of(who, channel).unwrap_or_else(|e| {
            eprintln!("vibevalley-server: chat: unread of {who}: {}", e.message);
            vec![]
        })
    }

    /// Every channel and direct channel, the default first.
    pub fn list(&self) -> Result<Vec<Channel>, ApiError> {
        let inner = self.locked();
        let mut out = vec![];
        for row in inner.model.channels("channel").iter().chain(inner.model.channels("direct").iter()) {
            out.push(inner.counted(row)?);
        }
        Ok(out)
    }

    /// `history`: a place's messages before a number, oldest first.
    pub fn history(&self, channel: &str, before: Option<i64>, limit: Option<i64>) -> Result<Vec<ChatMessage>, ApiError> {
        let mut inner = self.locked();
        let at = if inner.model.channel(channel).is_some() {
            channel.to_string()
        } else {
            let (place, opened) = inner.resolve_target(USER_ID, channel)?;
            if let Some(thread) = opened {
                self.publish_channel(&inner, &thread)?;
            }
            place
        };
        let mut rows = db::messages_before(&inner.db, &at, before.unwrap_or(NO_NUMBER), limit.unwrap_or(50).clamp(1, 200)).q()?;
        rows.reverse();
        Ok(rows.iter().map(to_message).collect())
    }

    pub fn mark_read(&self, channel: &str, number: i64) -> Result<(), ApiError> {
        let mut inner = self.locked();
        if inner.model.channel(channel).is_none() {
            return Err(no_channel(channel));
        }
        self.read_through(&mut inner, USER_ID, channel, number)?;
        self.publish_channel(&inner, channel)
    }

    /// Each read of the user's from now on: (channel, number, at).
    pub fn user_reads(&self) -> flume::Receiver<(String, i64, i64)> {
        let (tx, rx) = flume::unbounded();
        lock(&self.user_reads).push(tx);
        rx
    }

    /// `messageLocation`: a message's place and the channel it is in.
    pub fn message_location(&self, id: &str) -> Result<Option<(Channel, String)>, ApiError> {
        let inner = self.locked();
        let Some(m) = db::message_by_id(&inner.db, id).q()? else { return Ok(None) };
        let Some(row) = inner.model.channel(&m.channel_id) else { return Ok(None) };
        let top = if row.r#type == "thread" {
            row.parent_id.clone().unwrap_or(row.id.clone())
        } else {
            row.id.clone()
        };
        Ok(Some((inner.to_channel(row, 0, String::new(), None), top)))
    }

    /// `userReceipt`: when the user read a message, and whether a later one
    /// took its place; none once it is deleted.
    pub fn user_receipt(&self, id: &str) -> Result<Option<(ChatMessage, Option<i64>, bool)>, ApiError> {
        let inner = self.locked();
        let Some(row) = db::message_by_id(&inner.db, id).q()?.filter(|r| r.deleted_at.is_none()) else {
            return Ok(None);
        };
        let Some((read_at, superseded)) = db::notification_receipt(&inner.db, id).q()? else {
            return Ok(None);
        };
        Ok(Some((to_message(&row), read_at, superseded)))
    }

    /// Each speaker's newest report the user has read: (from, at, readAt).
    pub fn user_read_reports(&self) -> Result<Vec<(String, i64, i64)>, ApiError> {
        db::user_read_reports(&self.locked().db).q()
    }

    pub fn home_of(&self, participant: &str) -> Option<String> {
        self.locked().home_of(participant)
    }

    /// Each event committed from now on, in order.
    pub fn committed(&self) -> flume::Receiver<Told> {
        let (tx, rx) = flume::unbounded();
        lock(&self.told).push(tx);
        rx
    }

    /// The events after `after`, oldest first, at most n.
    pub fn events(&self, after: i64, n: i64) -> Result<Vec<EventRow>, ApiError> {
        db::events_after(&self.locked().db, after, n).q()
    }

    /// A posted message as it is now, told as when it was committed.
    pub fn committed_of(&self, message: &str) -> Result<Option<Committed>, ApiError> {
        let inner = self.locked();
        let row = db::message_by_id(&inner.db, message).q()?;
        let event = db::event_of(&inner.db, message).q()?;
        Ok(match (row, event) {
            (Some(row), Some(e)) if row.deleted_at.is_none() => inner.committed_from(&row, &e),
            _ => None,
        })
    }

    /// Non-blocking stream of committed messages with their pending deliveries.
    pub fn dispatches(&self) -> flume::Receiver<ChannelDispatched> {
        let (tx, rx) = flume::unbounded();
        lock(&self.dispatches).push(tx);
        rx
    }

    pub fn pending_deliveries(&self, kind: DeliveryTargetKind) -> Result<Vec<QueuedDelivery>, ApiError> {
        Ok(db::pending_deliveries_by_kind(&self.locked().db, kind.as_str())
            .q()?
            .into_iter()
            .map(queued_from_row)
            .collect())
    }

    pub fn pending_deliveries_for(&self, kind: DeliveryTargetKind, recipient: &str, max_id: i64) -> Result<Vec<QueuedDelivery>, ApiError> {
        Ok(db::pending_deliveries_for_recipient(&self.locked().db, kind.as_str(), recipient, max_id)
            .q()?
            .into_iter()
            .map(queued_from_row)
            .collect())
    }

    pub fn delivery_is_pending(&self, id: i64) -> Result<bool, ApiError> {
        db::delivery_is_pending(&self.locked().db, id).q()
    }

    pub fn settle_delivery(&self, id: i64, delivered: bool) -> Result<(), ApiError> {
        let status = if delivered { "delivered" } else { "failed" };
        db::settle_delivery(&self.locked().db, id, status, now()).q()
    }

    pub fn withdraw_delivery(&self, id: i64) -> Result<(), ApiError> {
        db::settle_delivery(&self.locked().db, id, "withdrawn", now()).q()
    }

    /// Ensures a session's thread is opened and seated before it speaks or reads.
    pub fn ensure_seated(&self, seater: impl Fn(&str) + Send + Sync + 'static) {
        self.seaters.write().unwrap_or_else(|e| e.into_inner()).push(Arc::new(seater));
    }

    pub(super) fn prepare_seat(&self, who: &str) {
        if who == USER_ID || who == DEFAULT_ORCHESTRATOR || who == "system" || self.home_of(who).is_some() {
            return;
        }
        for f in self.seaters.read().unwrap_or_else(|e| e.into_inner()).iter() {
            f(who);
        }
    }

    /// Seats an agent under the name it goes by now.
    pub fn seat(&self, seat: &Seat) -> Result<(), ApiError> {
        let mut inner = self.locked();
        tx(&mut inner, |me| me.seat(seat))
    }

    /// A participant gone: in nothing, never back; pending session deliveries withdrawn.
    pub fn leave(&self, participant: &str) -> Result<(), ApiError> {
        let mut inner = self.locked();
        let at = now();
        tx(&mut inner, |me| {
            db::participant_left(&me.db, participant, at).q()?;
            db::remove_from_all(&me.db, participant, at).q()?;
            db::withdraw_deliveries_for_recipient(&me.db, DeliveryTargetKind::Session.as_str(), participant, at).q()?;
            me.model.left(participant, at);
            me.reach.left(participant);
            Ok(())
        })
    }

    pub fn participants(&self) -> Vec<ParticipantRow> {
        self.locked().model.participants().to_vec()
    }

    /// Makes a participant a member of a place from its newest message on.
    pub fn add_follower(&self, channel: &str, participant: &str) -> Result<(), ApiError> {
        let mut inner = self.locked();
        let Some(last) = inner.model.channel(channel).map(|r| r.last_number.unwrap_or(0)) else {
            return Ok(());
        };
        tx(&mut inner, |me| me.add_member(channel, participant, "user", last))
    }

    pub fn members_of(&self, channel: &str) -> Vec<String> {
        self.locked().model.members_of(channel)
    }

    pub fn thread_about(&self, kind: SubjectKind, id: &str) -> Option<String> {
        self.locked().model.thread_of_subject(kind.as_str(), id).map(str::to_string)
    }

    pub fn place(&self, id: &str) -> Option<Place> {
        let inner = self.locked();
        inner.model.channel(id).map(|r| inner.place_of(r))
    }

    pub fn mark_seen(&self, participant: &str, message: &str) -> Result<(), ApiError> {
        db::mark_seen(&self.locked().db, participant, message, now()).q()
    }

    pub fn read_up_to(&self, participant: &str, channel: &str, number: i64) -> Result<(), ApiError> {
        let mut inner = self.locked();
        tx(&mut inner, |me| me.set_read(participant, channel, number, now()))
    }

    pub fn latest(&self, channel: &str) -> Result<i64, ApiError> {
        db::latest_number(&self.locked().db, channel).q()
    }

    pub fn dispatch_count(&self, thread: &str) -> Result<i64, ApiError> {
        db::dispatches_in(&self.locked().db, thread).q()
    }

    /// The newest n messages of a place, oldest first.
    pub fn recent_rows(&self, channel: &str, n: i64) -> Result<Vec<MsgRow>, ApiError> {
        let mut rows = db::messages_before(&self.locked().db, channel, NO_NUMBER, n).q()?;
        rows.reverse();
        Ok(rows)
    }

    pub fn rows_after(&self, channel: &str, after: i64) -> Result<Vec<MsgRow>, ApiError> {
        db::messages_after(&self.locked().db, channel, after, 1000).q()
    }

    pub fn addressed_of(&self, row: &MsgRow) -> AddressedMessage {
        self.locked().addressed_of(row, &self.files)
    }

    /// A place as an agent addresses it (`#general`, `#general/12`, `@name`).
    pub fn target_of(&self, channel: &str) -> Option<String> {
        let inner = self.locked();
        inner.model.channel(channel).map(|row| inner.target_of_channel(row))
    }

    pub fn orchestrator_in(&self, channel: &str) -> String {
        self.locked().orchestrator_in(channel)
    }

    pub fn default_channel(&self) -> String {
        self.locked().model.default_id()
    }

    /// The state's chat now.
    pub fn now(&self) -> Option<vibevalley_protocol::Chat> {
        self.hub.upgrade().and_then(|h| h.read(|s| s.chat.clone()))
    }

    /// A refusal of removals: what still points at a channel.
    pub fn guard_removal(&self, guard: impl Fn(&str) -> Vec<String> + Send + Sync + 'static) {
        self.guards.write().unwrap_or_else(|e| e.into_inner()).push(Arc::new(guard));
    }

    pub fn channels(&self) -> Vec<Info> {
        self.locked().model.channels("channel").iter().map(info_of).collect()
    }

    pub fn channel_by_name(&self, name: &str) -> Option<Info> {
        let trimmed = name.trim();
        self.locked().model.channel_by_name(trimmed.strip_prefix('#').unwrap_or(trimmed)).map(info_of)
    }

    /// `topOf`: a thread's parent channel, or the default one.
    pub fn top_of(&self, channel: &str) -> Info {
        let inner = self.locked();
        inner.model.top_channel(channel).map(info_of).unwrap_or_else(|| Info {
            id: inner.model.default_id(),
            name: FIRST_CHANNEL.into(),
            description: String::new(),
            repo: String::new(),
            default: true,
        })
    }

    /// `addressOf`: (direct, target).
    pub fn address_of(&self, channel: &str) -> (bool, String) {
        let inner = self.locked();
        if let Some(row) = inner.model.channel(channel).filter(|r| r.r#type == "direct") {
            return (true, inner.target_of_channel(row));
        }
        (
            false,
            inner
                .model
                .top_channel(channel)
                .map(|t| inner.target_of_channel(t))
                .unwrap_or_else(|| "#general".into()),
        )
    }

    pub fn open_channel(&self, name: &str, description: &str, repo: &str) -> Result<Info, ApiError> {
        let mut inner = self.locked();
        let trimmed = name.trim();
        let clean = trimmed.strip_prefix('#').unwrap_or(trimmed).to_string();
        let taken: Vec<String> = inner.model.channels("channel").into_iter().filter_map(|r| r.name).collect();
        let problem = words::channel_name_problem(&clean, &taken);
        if !problem.is_empty() {
            return Err(refused(problem));
        }
        let (desc, proj) = (optional(Some(description)), optional(Some(repo)));
        let id = new_id();
        let at = now();
        tx(&mut inner, |me| {
            db::create_channel(&me.db, &id, false, &clean, desc.as_deref(), proj.as_deref(), at).q()?;
            me.model.created(ChannelRow {
                name: Some(clean.clone()),
                description: desc.clone(),
                repo: proj.clone(),
                ..ChannelRow::empty(&id, "channel", at)
            });
            me.add_member(&id, DEFAULT_ORCHESTRATOR, "manual", 0)
        })?;
        self.publish_channel(&inner, &id)?;
        Ok(Info {
            id,
            name: clean,
            description: desc.unwrap_or_default(),
            repo: proj.unwrap_or_default(),
            default: false,
        })
    }

    /// `updateChannel`: a thread changes only its title.
    pub fn update_channel(&self, id: &str, upd: ChannelUpdate) -> Result<(), ApiError> {
        let mut inner = self.locked();
        let row = inner
            .model
            .channel(id)
            .filter(|r| r.r#type != "direct")
            .cloned()
            .ok_or_else(|| no_channel(id))?;
        let only_name = upd.description.is_none() && upd.repo.is_none() && upd.category.is_none() && upd.before.is_none() && upd.members.is_none();
        if row.r#type == "thread" && !only_name {
            return Err(refused(t("server.channel.threadOnlyTitle", &[])));
        }
        let mut name = row.name.clone();
        if let Some(n) = &upd.name {
            let trimmed = n.trim();
            let clean = trimmed.strip_prefix('#').unwrap_or(trimmed);
            if row.r#type == "thread" {
                name = (!clean.is_empty()).then(|| head(clean, THREAD_TITLE_MAX * 2));
            } else {
                let taken: Vec<String> = inner
                    .model
                    .channels("channel")
                    .into_iter()
                    .filter(|c| c.id != id)
                    .filter_map(|c| c.name)
                    .collect();
                let problem = words::channel_name_problem(clean, &taken);
                if !problem.is_empty() {
                    return Err(refused(problem));
                }
                name = Some(clean.to_string());
            }
        }
        let desc = upd.description.as_deref().and_then(|d| optional(Some(d))).or(row.description.clone());
        let proj = match &upd.repo {
            Some(r) => optional(Some(r)),
            None => row.repo.clone(),
        };
        let category = match &upd.category {
            Some(c) => optional(Some(c)),
            None => row.category.clone(),
        };
        // Only an orchestrator is put in a channel: a helper is hired into a place, not seated in one.
        let wanted: Option<Vec<String>> = upd.members.as_ref().map(|ms| {
            let mut out: Vec<String> = vec![];
            for m in ms.iter().map(|m| m.trim()).filter(|m| !m.is_empty()) {
                if !out.iter().any(|o| o == m) {
                    out.push(m.to_string());
                }
            }
            out
        });
        if let Some(not_one) = wanted.iter().flatten().find(|m| !inner.is_orchestrator_seat(m)) {
            return Err(refused(t("server.channel.notOrchestrator", &[("id", not_one.as_str().into())])));
        }
        let had = inner.model.members_of(id);
        let joining: Vec<String> = wanted.iter().flatten().filter(|m| !had.contains(m)).cloned().collect();
        let leaving: Vec<String> = match &wanted {
            None => vec![],
            Some(w) => had.iter().filter(|m| inner.is_orchestrator_seat(m) && !w.contains(m)).cloned().collect(),
        };
        let order: Option<Vec<String>> = upd.before.as_ref().map(|before| {
            let mut rest: Vec<String> = inner
                .model
                .channels("channel")
                .into_iter()
                .filter(|c| !c.is_default && c.id != id)
                .map(|c| c.id)
                .collect();
            let at = rest.iter().position(|c| c == before).unwrap_or(rest.len());
            rest.insert(at, id.to_string());
            rest
        });
        tx(&mut inner, |me| {
            if row.r#type == "channel" {
                db::update_channel(&me.db, id, desc.as_deref(), proj.as_deref()).q()?;
            }
            if name != row.name {
                db::rename_channel(&me.db, id, name.as_deref()).q()?;
            }
            if category != row.category {
                db::set_category(&me.db, id, category.as_deref()).q()?;
            }
            for m in &joining {
                me.add_member(id, m, "manual", 0)?;
            }
            let at = now();
            for m in &leaving {
                db::remove_member(&me.db, id, m, at).q()?;
                me.model.member_removed(id, m);
            }
            for (position, each) in order.iter().flatten().enumerate() {
                db::place_channel(&me.db, each, position as i64).q()?;
            }
            let row_type = row.r#type.clone();
            me.model.patch(id, |c| {
                if row_type == "channel" {
                    c.description = desc.clone();
                    c.repo = proj.clone();
                }
                c.name = name.clone();
                c.category = category.clone();
            });
            for (position, each) in order.iter().flatten().enumerate() {
                me.model.patch(each, |c| c.position = Some(position as i64));
            }
            Ok(())
        })?;
        for each in order.clone().unwrap_or_else(|| vec![id.to_string()]) {
            self.publish_channel(&inner, &each)?;
        }
        // Its threads are in the same channel: they show who is in it now too.
        if !joining.is_empty() || !leaving.is_empty() {
            for thread in inner.model.threads_of(id) {
                self.publish_channel(&inner, &thread.id)?;
            }
        }
        Ok(())
    }

    pub fn archive(&self, id: &str, on: bool) -> Result<(), ApiError> {
        let mut inner = self.locked();
        let row = inner
            .model
            .channel(id)
            .filter(|r| r.r#type != "direct")
            .cloned()
            .ok_or_else(|| no_channel(id))?;
        if row.archived_at.is_some() == on {
            return Ok(());
        }
        if row.is_default {
            return Err(refused(t("server.channel.defaultStays", &[])));
        }
        let at = on.then(now);
        tx(&mut inner, |me| {
            db::set_archived(&me.db, id, at).q()?;
            me.model.patch(id, |c| c.archived_at = at);
            Ok(())
        })?;
        self.publish_channel(&inner, id)
    }

    /// `removable`: a channel nothing points at; (target, threads, said).
    fn removable(&self, inner: &Inner, id: &str) -> Result<(String, usize, i64), ApiError> {
        let row = inner.model.channel(id).filter(|r| r.r#type == "channel").ok_or_else(|| no_channel(id))?;
        if row.is_default {
            return Err(refused(t("server.channel.defaultStays", &[])));
        }
        let topics = db::topic_threads_in(&inner.db, id).q()?;
        let guards = self.guards.read().unwrap_or_else(|e| e.into_inner()).clone();
        let mut why: Vec<String> = guards.iter().flat_map(|g| g(id)).collect();
        if topics != 0 {
            why.push(t("server.channel.issuesThere", &[("n", topics.into())]));
        }
        if !why.is_empty() {
            return Err(refused(t("server.channel.inUse", &[("why", list(&why).into())])));
        }
        let threads = inner.model.threads_of(id);
        let said = row.last_number.unwrap_or(0) + threads.iter().map(|t| t.reply_count).sum::<i64>();
        Ok((inner.target_of_channel(row), threads.len(), said))
    }

    pub fn preview_remove_channel(&self, id: &str) -> Result<Preview, ApiError> {
        let inner = self.locked();
        let (target, threads, said) = self.removable(&inner, id)?;
        Ok(Preview {
            does: vec![t(
                "server.channel.deletesChannel",
                &[("target", target.into()), ("threads", threads.into()), ("said", said.into())],
            )],
        })
    }

    pub fn remove_channel(&self, id: &str) -> Result<(), ApiError> {
        let mut inner = self.locked();
        self.removable(&inner, id)?;
        let mut gone: Vec<String> = vec![];
        for c in inner.model.channel(id).into_iter().cloned().chain(inner.model.threads_of(id)) {
            gone.push(inner.target_of_channel(&c));
        }
        tx(&mut inner, |me| {
            db::delete_channel(&me.db, id).q()?;
            me.model.removed(id);
            me.reach.channel_removed(id);
            me.model.last_read.retain(|_, target| !gone.contains(target));
            Ok(())
        })?;
        self.apply(vec![Fact::ChannelRemoved(FactChannelRemoved { at: now(), id: id.into() })]);
        Ok(())
    }

    pub fn set_notify(&self, id: &str, notify: Notify) -> Result<(), ApiError> {
        let mut inner = self.locked();
        if inner.model.channel(id).is_none() {
            return Err(no_channel(id));
        }
        tx(&mut inner, |me| {
            db::set_notify(&me.db, id, notify.as_str()).q()?;
            me.model.patch(id, |c| c.notify = notify.as_str().into());
            Ok(())
        })?;
        self.publish_channel(&inner, id)?;
        self.publish_user_mentions(&inner)
    }

    /// `notifyOf`: "none" on the thread or its channel silences both.
    pub fn notify_of(&self, id: &str) -> Notify {
        let inner = self.locked();
        let c = inner.model.channel(id);
        let top = c.and_then(|c| c.parent_id.as_deref()).and_then(|p| inner.model.channel(p));
        if c.is_some_and(|c| c.notify == "none") || top.is_some_and(|t| t.notify == "none") {
            return Notify::None;
        }
        match c.map(|c| c.notify.as_str()) {
            Some(n) if n != "all" => notify_of(n),
            _ => notify_of(top.map_or("all", |t| t.notify.as_str())),
        }
    }

    /// `createDirect`: the direct channel with a seated agent, made when
    /// there is none.
    pub fn create_direct(&self, peer: &str) -> Result<String, ApiError> {
        let mut inner = self.locked();
        if inner.model.participant(peer).is_none_or(|p| p.kind != "agent") {
            return Err(missing(t("server.channel.noProfileNamed", &[("key", peer.into())]), LookIn::Agent));
        }
        if let Some(had) = inner.model.channels("direct").into_iter().find(|c| c.peer_id.as_deref() == Some(peer)) {
            return Ok(had.id);
        }
        let id = new_id();
        let at = now();
        tx(&mut inner, |me| {
            db::create_direct(&me.db, &id, peer, at).q()?;
            me.model.created(ChannelRow {
                peer_id: Some(peer.into()),
                ..ChannelRow::empty(&id, "direct", at)
            });
            Ok(())
        })?;
        self.publish_channel(&inner, &id)?;
        Ok(id)
    }

    pub fn mark_unread(&self, channel: &str, number: i64) -> Result<(), ApiError> {
        let mut inner = self.locked();
        if inner.model.channel(channel).is_none() {
            return Err(no_channel(channel));
        }
        let upto = (number - 1).max(0);
        tx(&mut inner, |me| {
            db::mark_unread(&me.db, channel, upto, now()).q()?;
            me.model.user_read_back(channel, upto);
            Ok(())
        })?;
        self.publish_channel(&inner, channel)?;
        self.publish_user_mentions(&inner)
    }

    pub fn make_default(&self, id: &str) -> Result<(), ApiError> {
        let mut inner = self.locked();
        let row = inner.model.channel(id).cloned().ok_or_else(|| no_channel(id))?;
        if row.r#type != "channel" {
            return Err(refused(t("server.channel.defaultIsChannel", &[])));
        }
        let was = inner.model.default_id();
        if id == was {
            return Ok(());
        }
        tx(&mut inner, |me| {
            db::clear_default(&me.db).q()?;
            db::make_default(&me.db, id).q()?;
            me.model.default_moved(&was, id);
            Ok(())
        })?;
        self.publish_channel(&inner, &was)?;
        self.publish_channel(&inner, id)
    }

    fn said(&self) -> flume::Receiver<ChatMessage> {
        let (tx, rx) = flume::unbounded();
        lock(&self.said).push(tx);
        rx
    }

    /// `follow`: what changed in a channel after revision `after`, then each
    /// change from now on; `Reset` when too far behind.
    pub fn follow(&self, channel: &str, after: i64, sink: Sink) -> Result<(), ApiError> {
        let (live, missed) = {
            let inner = self.locked();
            if inner.model.channel(channel).is_none() {
                return Err(refused(t("server.channel.channelGone", &[])));
            }
            // Subscribed before the missed ones are read: nothing falls in between.
            let live = self.said();
            (live, db::messages_changed_after(&inner.db, channel, after, CATCH_UP_MAX as i64 + 1).q()?)
        };
        let channel = channel.to_string();
        std::thread::Builder::new()
            .name("vibevalley-chat-follow".into())
            .spawn(move || {
                if missed.len() > CATCH_UP_MAX {
                    sink.send(&ChannelEvent::Reset {});
                    return;
                }
                let upto = missed.last().map_or(after, |m| m.revision);
                for m in &missed {
                    if !sink.send(&ChannelEvent::Message { message: to_message(m) }) {
                        return;
                    }
                }
                relay(live, &sink, |m| m.channel == channel && m.revision > upto);
            })
            .map_err(internal)?;
        Ok(())
    }

    /// `reports`: the reports after the one with id `after` (the newest
    /// ones without it), then each one from now on.
    pub fn reports(&self, after: Option<String>, sink: Sink) -> Result<(), ApiError> {
        let (live, missed) = {
            let inner = self.locked();
            let live = self.said();
            let missed = match &after {
                None => {
                    let mut rows = db::recent_reports(&inner.db, LOG_KEEP).q()?;
                    rows.reverse();
                    rows
                }
                Some(a) => db::reports_after(&inner.db, a, CATCH_UP_MAX as i64 + 1).q()?,
            };
            (live, missed)
        };
        std::thread::Builder::new()
            .name("vibevalley-chat-reports".into())
            .spawn(move || {
                if missed.len() > CATCH_UP_MAX {
                    sink.send(&ChannelEvent::Reset {});
                    return;
                }
                let upto = missed.last().map(|m| m.id.clone()).or(after).unwrap_or_default();
                for m in &missed {
                    if !sink.send(&ChannelEvent::Message { message: to_message(m) }) {
                        return;
                    }
                }
                relay(live, &sink, |m| m.kind == MessageKind::Report && m.id > upto);
            })
            .map_err(internal)?;
        Ok(())
    }
}

fn queued_from_row(r: DeliveryRow) -> QueuedDelivery {
    QueuedDelivery {
        id: r.id,
        message_id: r.message_id,
        channel_id: r.channel_id,
        recipient_kind: DeliveryTargetKind::from_db(&r.recipient_kind),
        recipient_id: r.recipient_id,
        reason: Reason::from_db(&r.reason),
        wakes: r.wakes,
        held_by: r.held_by.as_deref().and_then(HeldBy::from_db),
    }
}

/// Each message said that `keep` keeps, until the subscriber stops.
fn relay(live: flume::Receiver<ChatMessage>, sink: &Sink, keep: impl Fn(&ChatMessage) -> bool) {
    loop {
        if sink.stopped() {
            return;
        }
        match live.recv_timeout(std::time::Duration::from_millis(500)) {
            Ok(m) if keep(&m) => {
                if !sink.send(&ChannelEvent::Message { message: m }) {
                    return;
                }
            }
            Ok(_) | Err(flume::RecvTimeoutError::Timeout) => {}
            Err(flume::RecvTimeoutError::Disconnected) => return,
        }
    }
}
