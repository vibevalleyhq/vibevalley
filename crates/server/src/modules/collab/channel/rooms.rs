use std::sync::Arc;

use sqlx::SqliteConnection;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use vibevalley_i18n::{list, t};
use vibevalley_protocol::{
    ApiError, Channel, ChannelEvent as ProtocolChannelEvent, ChannelUnread, ChannelUpdate, ChatMessage, DEFAULT_ORCHESTRATOR, Fact, FactChannelRemoved,
    MessageKind, Notify, Preview, SubjectKind, USER_ID,
};

use super::db::{self, ChannelRow, DeliveryRow, EventRow, MsgRow, ParticipantRow};
use super::dispatch::{ChannelDispatched, DeliveryTargetKind, HeldBy, QueuedDelivery, Reason};
use super::model::ChatModel;
use super::store::{Q, WriteTx};
use super::types::{
    AddressedMessage, ChannelEvent, Committed, Info, Place, ReadOptions, ReadResult, Seat, head, info_of, new_id, notify_of, optional, to_message,
};
use super::words;
use super::{CATCH_UP_MAX, Chat, FIRST_CHANNEL, LOG_KEEP, NO_NUMBER, READ_LIMIT, THREAD_TITLE_MAX, no_channel, refused};
use crate::base::{LookIn, missing};
use crate::{Sink, now};

impl Chat {
    /// `placeOf`: a place's id, or an address as `from` would say it.
    pub fn place_of(&self, from: &str, channel: &str) -> Result<String, ApiError> {
        vibevalley_runtime::rt::block_on(self.place_of_async(from, channel))
    }

    pub async fn place_of_async(&self, from: &str, channel: &str) -> Result<String, ApiError> {
        if self.model().channel(channel).is_some() {
            return Ok(channel.into());
        }
        let mut inner = self.locked().await;
        if inner.model.channel(channel).is_some() {
            return Ok(channel.into());
        }
        let (place, opened) = self.resolve_target_async(&mut inner, from, channel).await?;
        if let Some(thread) = opened {
            self.publish_channel_async(&inner.model, &thread).await?;
        }
        Ok(place)
    }

    /// `read`: an agent reads a place; a read of the newest moves its
    /// cursor.
    pub fn read(&self, who: &str, opt: ReadOptions) -> Result<ReadResult, ApiError> {
        vibevalley_runtime::rt::block_on(self.read_async(who, opt))
    }

    pub async fn read_async(&self, who: &str, opt: ReadOptions) -> Result<ReadResult, ApiError> {
        self.prepare_seat(who);
        let mut inner = self.locked().await;
        let (channel, opened) = self.resolve_target_async(&mut inner, who, opt.target.as_deref().unwrap_or("")).await?;
        if let Some(thread) = opened {
            self.publish_channel_async(&inner.model, &thread).await?;
        }
        let row = inner
            .model
            .channel(&channel)
            .cloned()
            .ok_or_else(|| refused(t("server.channel.channelGone", &[])))?;
        let target = inner.model.target_of_channel(&row);
        let limit = match opt.limit {
            Some(l) if l != 0 => l.clamp(1, 100),
            _ => READ_LIMIT,
        };
        let before = opt.before.filter(|b| *b != 0);
        let rows = {
            let mut rconn = self.db.read_pool().acquire().await.q()?;
            let cursor = db::read_cursor(&mut rconn, who, &channel).await.q()?.unwrap_or(0);
            if opt.unread {
                db::messages_after(&mut rconn, &channel, cursor, limit).await.q()?
            } else {
                let mut rows = db::messages_before(&mut rconn, &channel, before.unwrap_or(NO_NUMBER), limit).await.q()?;
                rows.reverse();
                rows
            }
        };
        if let Some(newest) = rows.last()
            && before.is_none()
        {
            self.read_through_async(&mut inner, who, &channel, newest.number).await?;
        }
        let keep: Vec<String> = inner.model.last_read.keys().cloned().collect();
        for p in keep {
            if inner.model.participant(&p).is_none_or(|x| x.left_at.is_some()) {
                inner.model.last_read.remove(&p);
            }
        }
        inner.model.last_read.insert(who.into(), target.clone());
        let older = match rows.first() {
            Some(oldest) => {
                let mut rconn = self.db.read_pool().acquire().await.q()?;
                !db::messages_before(&mut rconn, &channel, oldest.number, 1).await.q()?.is_empty()
            }
            None => false,
        };
        let messages = rows.iter().map(|r| inner.model.addressed_of(r, &self.files)).collect();
        Ok(ReadResult { target, messages, older })
    }

    /// `unread`: a hint for the one asking; a failure is none, logged.
    pub fn unread(&self, who: &str, channel: Option<&str>) -> Vec<ChannelUnread> {
        vibevalley_runtime::rt::block_on(self.unread_async(who, channel))
    }

    pub async fn unread_async(&self, who: &str, channel: Option<&str>) -> Vec<ChannelUnread> {
        self.prepare_seat(who);
        let model = self.snapshot.load_full();
        let res = async {
            let mut conn = self.db.read_pool().acquire().await.q()?;
            model.unread_of_async(&mut conn, who, channel).await
        }
        .await;
        res.unwrap_or_else(|e| {
            eprintln!("vibevalley-server: chat: unread of {who}: {}", e.message);
            vec![]
        })
    }

    /// Every channel and direct channel, the default first.
    pub fn list(&self) -> Result<Vec<Channel>, ApiError> {
        vibevalley_runtime::rt::block_on(self.list_async())
    }

    pub async fn list_async(&self) -> Result<Vec<Channel>, ApiError> {
        let model = self.snapshot.load_full();
        let mut conn = self.db.read_pool().acquire().await.q()?;
        let mut out = vec![];
        for row in model.channels("channel").iter().chain(model.channels("direct").iter()) {
            out.push(model.counted_async(&mut conn, row).await?);
        }
        Ok(out)
    }

    /// `history`: a place's messages before a number, oldest first.
    pub fn history(&self, channel: &str, before: Option<i64>, limit: Option<i64>) -> Result<Vec<ChatMessage>, ApiError> {
        vibevalley_runtime::rt::block_on(self.history_async(channel, before, limit))
    }

    pub async fn history_async(&self, channel: &str, before: Option<i64>, limit: Option<i64>) -> Result<Vec<ChatMessage>, ApiError> {
        let at = if self.model().channel(channel).is_some() {
            channel.to_string()
        } else {
            let mut inner = self.locked().await;
            if inner.model.channel(channel).is_some() {
                channel.to_string()
            } else {
                let (place, opened) = self.resolve_target_async(&mut inner, USER_ID, channel).await?;
                if let Some(thread) = opened {
                    self.publish_channel_async(&inner.model, &thread).await?;
                }
                place
            }
        };
        let mut conn = self.db.read_pool().acquire().await.q()?;
        let mut rows = db::messages_before(&mut conn, &at, before.unwrap_or(NO_NUMBER), limit.unwrap_or(50).clamp(1, 200))
            .await
            .q()?;
        rows.reverse();
        Ok(rows.iter().map(to_message).collect())
    }

    pub fn mark_read(&self, channel: &str, number: i64) -> Result<(), ApiError> {
        vibevalley_runtime::rt::block_on(self.mark_read_async(channel, number))
    }

    pub async fn mark_read_async(&self, channel: &str, number: i64) -> Result<(), ApiError> {
        let mut inner = self.locked().await;
        if inner.model.channel(channel).is_none() {
            return Err(no_channel(channel));
        }
        self.read_through_async(&mut inner, USER_ID, channel, number).await?;
        self.publish_channel_async(&inner.model, channel).await
    }

    /// Unified broadcast subscription for committed channel events.
    pub fn subscribe_events(&self) -> broadcast::Receiver<ChannelEvent> {
        self.events.subscribe()
    }

    /// `messageLocation`: a message's place and the channel it is in.
    pub fn message_location(&self, id: &str) -> Result<Option<(Channel, String)>, ApiError> {
        vibevalley_runtime::rt::block_on(self.message_location_async(id))
    }

    pub async fn message_location_async(&self, id: &str) -> Result<Option<(Channel, String)>, ApiError> {
        let m = {
            let mut conn = self.db.read_pool().acquire().await.q()?;
            let Some(m) = db::message_by_id(&mut conn, id).await.q()? else {
                return Ok(None);
            };
            m
        };
        let model = self.model();
        let Some(row) = model.channel(&m.channel_id) else { return Ok(None) };
        let top = if row.r#type == "thread" {
            row.parent_id.clone().unwrap_or(row.id.clone())
        } else {
            row.id.clone()
        };
        Ok(Some((model.to_channel(row, 0, String::new(), None), top)))
    }

    /// `userReceipt`: when the user read a message, and whether a later one
    /// took its place; none once it is deleted.
    pub fn user_receipt(&self, id: &str) -> Result<Option<(ChatMessage, Option<i64>, bool)>, ApiError> {
        vibevalley_runtime::rt::block_on(self.user_receipt_async(id))
    }

    pub async fn user_receipt_async(&self, id: &str) -> Result<Option<(ChatMessage, Option<i64>, bool)>, ApiError> {
        let mut conn = self.db.read_pool().acquire().await.q()?;
        let Some(row) = db::message_by_id(&mut conn, id).await.q()?.filter(|r| r.deleted_at.is_none()) else {
            return Ok(None);
        };
        let Some((read_at, superseded)) = db::notification_receipt(&mut conn, id).await.q()? else {
            return Ok(None);
        };
        Ok(Some((to_message(&row), read_at, superseded)))
    }

    /// Each speaker's newest report the user has read: (from, at, readAt).
    pub fn user_read_reports(&self) -> Result<Vec<(String, i64, i64)>, ApiError> {
        vibevalley_runtime::rt::block_on(self.user_read_reports_async())
    }

    pub async fn user_read_reports_async(&self) -> Result<Vec<(String, i64, i64)>, ApiError> {
        let mut conn = self.db.read_pool().acquire().await.q()?;
        db::user_read_reports(&mut conn).await.q()
    }

    pub fn home_of(&self, participant: &str) -> Option<String> {
        self.model().home_of(participant)
    }

    /// The events after `after`, oldest first, at most n.
    pub fn events(&self, after: i64, n: i64) -> Result<Vec<EventRow>, ApiError> {
        vibevalley_runtime::rt::block_on(self.events_async(after, n))
    }

    pub async fn events_async(&self, after: i64, n: i64) -> Result<Vec<EventRow>, ApiError> {
        let mut conn = self.db.read_pool().acquire().await.q()?;
        db::events_after(&mut conn, after, n).await.q()
    }

    /// A posted message as it is now, told as when it was committed.
    pub fn committed_of(&self, message: &str) -> Result<Option<Committed>, ApiError> {
        vibevalley_runtime::rt::block_on(self.committed_of_async(message))
    }

    pub async fn committed_of_async(&self, message: &str) -> Result<Option<Committed>, ApiError> {
        let (row, event) = {
            let mut conn = self.db.read_pool().acquire().await.q()?;
            let row = db::message_by_id(&mut conn, message).await.q()?;
            let event = db::event_of(&mut conn, message).await.q()?;
            (row, event)
        };
        let model = self.model();
        Ok(match (row, event) {
            (Some(row), Some(e)) if row.deleted_at.is_none() => model.committed_from(&row, &e),
            _ => None,
        })
    }

    /// Non-blocking stream of committed messages with their pending deliveries.
    pub fn dispatches(&self) -> flume::Receiver<ChannelDispatched> {
        let (tx, rx) = flume::unbounded();
        self.dispatches.lock().push(tx);
        rx
    }

    pub fn pending_deliveries(&self, kind: DeliveryTargetKind) -> Result<Vec<QueuedDelivery>, ApiError> {
        vibevalley_runtime::rt::block_on(self.pending_deliveries_async(kind))
    }

    pub async fn pending_deliveries_async(&self, kind: DeliveryTargetKind) -> Result<Vec<QueuedDelivery>, ApiError> {
        let mut conn = self.db.read_pool().acquire().await.q()?;
        Ok(db::pending_deliveries_by_kind(&mut conn, kind.as_str())
            .await
            .q()?
            .into_iter()
            .map(queued_from_row)
            .collect())
    }

    pub fn pending_deliveries_for(&self, kind: DeliveryTargetKind, recipient: &str, max_id: i64) -> Result<Vec<QueuedDelivery>, ApiError> {
        vibevalley_runtime::rt::block_on(self.pending_deliveries_for_async(kind, recipient, max_id))
    }

    pub async fn pending_deliveries_for_async(&self, kind: DeliveryTargetKind, recipient: &str, max_id: i64) -> Result<Vec<QueuedDelivery>, ApiError> {
        let mut conn = self.db.read_pool().acquire().await.q()?;
        Ok(db::pending_deliveries_for_recipient(&mut conn, kind.as_str(), recipient, max_id)
            .await
            .q()?
            .into_iter()
            .map(queued_from_row)
            .collect())
    }

    pub fn delivery_is_pending(&self, id: i64) -> Result<bool, ApiError> {
        vibevalley_runtime::rt::block_on(self.delivery_is_pending_async(id))
    }

    pub async fn delivery_is_pending_async(&self, id: i64) -> Result<bool, ApiError> {
        let mut conn = self.db.read_pool().acquire().await.q()?;
        db::delivery_is_pending(&mut conn, id).await.q()
    }

    pub fn settle_delivery(&self, id: i64, delivered: bool) -> Result<(), ApiError> {
        vibevalley_runtime::rt::block_on(self.settle_delivery_async(id, delivered))
    }

    pub async fn settle_delivery_async(&self, id: i64, delivered: bool) -> Result<(), ApiError> {
        let status = if delivered { "delivered" } else { "failed" };
        let mut conn = self.db.write_pool().acquire().await.q()?;
        db::settle_delivery(&mut conn, id, status, now()).await.q()
    }

    pub fn withdraw_delivery(&self, id: i64) -> Result<(), ApiError> {
        vibevalley_runtime::rt::block_on(self.withdraw_delivery_async(id))
    }

    pub async fn withdraw_delivery_async(&self, id: i64) -> Result<(), ApiError> {
        let mut conn = self.db.write_pool().acquire().await.q()?;
        db::settle_delivery(&mut conn, id, "withdrawn", now()).await.q()
    }

    /// Ensures a session's thread is opened and seated before it speaks or reads.
    pub fn ensure_seated(&self, seater: impl Fn(&str) + Send + Sync + 'static) {
        self.seaters.write().push(Arc::new(seater));
    }

    pub(super) fn prepare_seat(&self, who: &str) {
        if who == USER_ID || who == DEFAULT_ORCHESTRATOR || who == "system" || self.home_of(who).is_some() {
            return;
        }
        let seaters = self.seaters.read().clone();
        for f in seaters {
            f(who);
        }
    }

    /// Seats an agent under the name it goes by now.
    pub fn seat(&self, seat: &Seat) -> Result<(), ApiError> {
        vibevalley_runtime::rt::block_on(self.seat_async(seat))
    }

    pub async fn seat_async(&self, seat: &Seat) -> Result<(), ApiError> {
        if self.model().seat_matches(seat) {
            return Ok(());
        }
        let mut inner = self.locked().await;
        let mut conn = self.db.write_pool().acquire().await.q()?;
        let mut wtx = WriteTx::begin(&mut inner, &mut conn).await?;
        wtx.seat(seat).await?;
        wtx.commit().await
    }

    /// A participant gone: in nothing, never back; pending session deliveries withdrawn.
    pub fn leave(&self, participant: &str) -> Result<(), ApiError> {
        vibevalley_runtime::rt::block_on(self.leave_async(participant))
    }

    pub async fn leave_async(&self, participant: &str) -> Result<(), ApiError> {
        let mut inner = self.locked().await;
        let at = now();
        let mut conn = self.db.write_pool().acquire().await.q()?;
        let mut wtx = WriteTx::begin(&mut inner, &mut conn).await?;
        db::participant_left(&mut wtx.tx, participant, at).await.q()?;
        db::remove_from_all(&mut wtx.tx, participant, at).await.q()?;
        db::withdraw_deliveries_for_recipient(&mut wtx.tx, DeliveryTargetKind::Session.as_str(), participant, at)
            .await
            .q()?;
        wtx.model.left(participant, at);
        wtx.reach.left(participant);
        wtx.commit().await
    }

    pub fn participants(&self) -> Vec<ParticipantRow> {
        self.model().participants().to_vec()
    }

    /// Makes a participant a member of a place from its newest message on.
    pub fn add_follower(&self, channel: &str, participant: &str) -> Result<(), ApiError> {
        vibevalley_runtime::rt::block_on(self.add_follower_async(channel, participant))
    }

    pub async fn add_follower_async(&self, channel: &str, participant: &str) -> Result<(), ApiError> {
        let mut inner = self.locked().await;
        let Some(last) = inner.model.channel(channel).map(|r| r.last_number.unwrap_or(0)) else {
            return Ok(());
        };
        let mut conn = self.db.write_pool().acquire().await.q()?;
        let mut wtx = WriteTx::begin(&mut inner, &mut conn).await?;
        wtx.add_member(channel, participant, "user", last).await?;
        wtx.commit().await
    }

    pub fn members_of(&self, channel: &str) -> Vec<String> {
        self.model().members_of(channel)
    }

    pub fn thread_about(&self, kind: SubjectKind, id: &str) -> Option<String> {
        self.model().thread_of_subject(kind.as_str(), id).map(str::to_string)
    }

    pub fn place(&self, id: &str) -> Option<Place> {
        let model = self.model();
        model.channel(id).map(|r| model.place_of(r))
    }

    pub fn mark_seen(&self, participant: &str, message: &str) -> Result<(), ApiError> {
        vibevalley_runtime::rt::block_on(self.mark_seen_async(participant, message))
    }

    pub async fn mark_seen_async(&self, participant: &str, message: &str) -> Result<(), ApiError> {
        let mut conn = self.db.write_pool().acquire().await.q()?;
        db::mark_seen(&mut conn, participant, message, now()).await.q()
    }

    pub fn read_up_to(&self, participant: &str, channel: &str, number: i64) -> Result<(), ApiError> {
        vibevalley_runtime::rt::block_on(self.read_up_to_async(participant, channel, number))
    }

    pub async fn read_up_to_async(&self, participant: &str, channel: &str, number: i64) -> Result<(), ApiError> {
        let mut inner = self.locked().await;
        let mut conn = self.db.write_pool().acquire().await.q()?;
        let mut wtx = WriteTx::begin(&mut inner, &mut conn).await?;
        wtx.set_read(participant, channel, number, now()).await?;
        wtx.commit().await
    }

    pub fn latest(&self, channel: &str) -> Result<i64, ApiError> {
        vibevalley_runtime::rt::block_on(self.latest_async(channel))
    }

    pub async fn latest_async(&self, channel: &str) -> Result<i64, ApiError> {
        let mut conn = self.db.read_pool().acquire().await.q()?;
        db::latest_number(&mut conn, channel).await.q()
    }

    pub fn dispatch_count(&self, thread: &str) -> Result<i64, ApiError> {
        vibevalley_runtime::rt::block_on(self.dispatch_count_async(thread))
    }

    pub async fn dispatch_count_async(&self, thread: &str) -> Result<i64, ApiError> {
        let mut conn = self.db.read_pool().acquire().await.q()?;
        db::dispatches_in(&mut conn, thread).await.q()
    }

    /// The newest n messages of a place, oldest first.
    pub fn recent_rows(&self, channel: &str, n: i64) -> Result<Vec<MsgRow>, ApiError> {
        vibevalley_runtime::rt::block_on(self.recent_rows_async(channel, n))
    }

    pub async fn recent_rows_async(&self, channel: &str, n: i64) -> Result<Vec<MsgRow>, ApiError> {
        let mut conn = self.db.read_pool().acquire().await.q()?;
        let mut rows = db::messages_before(&mut conn, channel, NO_NUMBER, n).await.q()?;
        rows.reverse();
        Ok(rows)
    }

    pub fn rows_after(&self, channel: &str, after: i64) -> Result<Vec<MsgRow>, ApiError> {
        vibevalley_runtime::rt::block_on(self.rows_after_async(channel, after))
    }

    pub async fn rows_after_async(&self, channel: &str, after: i64) -> Result<Vec<MsgRow>, ApiError> {
        let mut conn = self.db.read_pool().acquire().await.q()?;
        db::messages_after(&mut conn, channel, after, 1000).await.q()
    }

    pub fn addressed_of(&self, row: &MsgRow) -> AddressedMessage {
        self.model().addressed_of(row, &self.files)
    }

    /// A place as an agent addresses it (`#general`, `#general/12`, `@name`).
    pub fn target_of(&self, channel: &str) -> Option<String> {
        let model = self.model();
        model.channel(channel).map(|row| model.target_of_channel(row))
    }

    pub fn orchestrator_in(&self, channel: &str) -> String {
        self.model().orchestrator_in(channel)
    }

    pub fn default_channel(&self) -> String {
        self.model().default_id()
    }

    /// The state's chat now.
    pub fn now(&self) -> Option<vibevalley_protocol::Chat> {
        self.hub.upgrade().and_then(|h| h.read(|s| s.chat.clone()))
    }

    /// A refusal of removals: what still points at a channel.
    pub fn guard_removal(&self, guard: impl Fn(&str) -> Vec<String> + Send + Sync + 'static) {
        self.guards.write().push(Arc::new(guard));
    }

    pub fn channels(&self) -> Vec<Info> {
        self.model().channels("channel").iter().map(info_of).collect()
    }

    pub fn channel_by_name(&self, name: &str) -> Option<Info> {
        let trimmed = name.trim();
        self.model().channel_by_name(trimmed.strip_prefix('#').unwrap_or(trimmed)).map(info_of)
    }

    /// `topOf`: a thread's parent channel, or the default one.
    pub fn top_of(&self, channel: &str) -> Info {
        let model = self.model();
        model.top_channel(channel).map(info_of).unwrap_or_else(|| Info {
            id: model.default_id(),
            name: FIRST_CHANNEL.into(),
            description: String::new(),
            repo: String::new(),
            default: true,
        })
    }

    /// `addressOf`: (direct, target).
    pub fn address_of(&self, channel: &str) -> (bool, String) {
        let model = self.model();
        if let Some(row) = model.channel(channel).filter(|r| r.r#type == "direct") {
            return (true, model.target_of_channel(row));
        }
        (
            false,
            model
                .top_channel(channel)
                .map(|t| model.target_of_channel(t))
                .unwrap_or_else(|| "#general".into()),
        )
    }

    pub fn open_channel(&self, name: &str, description: &str, repo: &str) -> Result<Info, ApiError> {
        vibevalley_runtime::rt::block_on(self.open_channel_async(name, description, repo))
    }

    pub async fn open_channel_async(&self, name: &str, description: &str, repo: &str) -> Result<Info, ApiError> {
        let mut inner = self.locked().await;
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
        {
            let mut conn = self.db.write_pool().acquire().await.q()?;
            let mut wtx = WriteTx::begin(&mut inner, &mut conn).await?;
            db::create_channel(&mut wtx.tx, &id, false, &clean, desc.as_deref(), proj.as_deref(), at)
                .await
                .q()?;
            wtx.model.created(ChannelRow {
                name: Some(clean.clone()),
                description: desc.clone(),
                repo: proj.clone(),
                ..ChannelRow::empty(&id, "channel", at)
            });
            wtx.add_member(&id, DEFAULT_ORCHESTRATOR, "manual", 0).await?;
            wtx.commit().await?;
        }
        self.publish_channel_async(&inner.model, &id).await?;
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
        vibevalley_runtime::rt::block_on(self.update_channel_async(id, upd))
    }

    pub async fn update_channel_async(&self, id: &str, upd: ChannelUpdate) -> Result<(), ApiError> {
        let mut inner = self.locked().await;
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
        if let Some(not_one) = wanted.iter().flatten().find(|m| !inner.model.is_orchestrator_seat(m)) {
            return Err(refused(t("server.channel.notOrchestrator", &[("id", not_one.as_str().into())])));
        }
        let had = inner.model.members_of(id);
        let joining: Vec<String> = wanted.iter().flatten().filter(|m| !had.contains(m)).cloned().collect();
        let leaving: Vec<String> = match &wanted {
            None => vec![],
            Some(w) => had.iter().filter(|m| inner.model.is_orchestrator_seat(m) && !w.contains(m)).cloned().collect(),
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
        {
            let mut conn = self.db.write_pool().acquire().await.q()?;
            let mut wtx = WriteTx::begin(&mut inner, &mut conn).await?;
            if row.r#type == "channel" {
                db::update_channel(&mut wtx.tx, id, desc.as_deref(), proj.as_deref()).await.q()?;
            }
            if name != row.name {
                db::rename_channel(&mut wtx.tx, id, name.as_deref()).await.q()?;
            }
            if category != row.category {
                db::set_category(&mut wtx.tx, id, category.as_deref()).await.q()?;
            }
            for m in &joining {
                wtx.add_member(id, m, "manual", 0).await?;
            }
            let at = now();
            for m in &leaving {
                db::remove_member(&mut wtx.tx, id, m, at).await.q()?;
                wtx.model.member_removed(id, m);
            }
            for (position, each) in order.iter().flatten().enumerate() {
                db::place_channel(&mut wtx.tx, each, position as i64).await.q()?;
            }
            let row_type = row.r#type.clone();
            wtx.model.patch(id, |c| {
                if row_type == "channel" {
                    c.description = desc.clone();
                    c.repo = proj.clone();
                }
                c.name = name.clone();
                c.category = category.clone();
            });
            for (position, each) in order.iter().flatten().enumerate() {
                wtx.model.patch(each, |c| c.position = Some(position as i64));
            }
            wtx.commit().await?;
        }
        for each in order.clone().unwrap_or_else(|| vec![id.to_string()]) {
            self.publish_channel_async(&inner.model, &each).await?;
        }
        // Its threads are in the same channel: they show who is in it now too.
        if !joining.is_empty() || !leaving.is_empty() {
            for thread in inner.model.threads_of(id) {
                self.publish_channel_async(&inner.model, &thread.id).await?;
            }
        }
        Ok(())
    }

    pub fn archive(&self, id: &str, on: bool) -> Result<(), ApiError> {
        vibevalley_runtime::rt::block_on(self.archive_async(id, on))
    }

    pub async fn archive_async(&self, id: &str, on: bool) -> Result<(), ApiError> {
        let mut inner = self.locked().await;
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
        {
            let mut conn = self.db.write_pool().acquire().await.q()?;
            let mut wtx = WriteTx::begin(&mut inner, &mut conn).await?;
            db::set_archived(&mut wtx.tx, id, at).await.q()?;
            wtx.model.patch(id, |c| c.archived_at = at);
            wtx.commit().await?;
        }
        self.publish_channel_async(&inner.model, id).await
    }

    /// `removable`: a channel nothing points at; (target, threads, said).
    async fn removable_with_async(&self, model: &ChatModel, conn: &mut SqliteConnection, id: &str) -> Result<(String, usize, i64), ApiError> {
        let row = model.channel(id).filter(|r| r.r#type == "channel").ok_or_else(|| no_channel(id))?;
        if row.is_default {
            return Err(refused(t("server.channel.defaultStays", &[])));
        }
        let topics = db::topic_threads_in(conn, id).await.q()?;
        let guards = self.guards.read().clone();
        let mut why: Vec<String> = guards.iter().flat_map(|g| g(id)).collect();
        if self.hub.upgrade().is_some_and(|h| {
            h.read(|s| {
                s.sessions
                    .iter()
                    .any(|x| (x.is_board_worker() || x.is_direct_talker()) && x.channel_id() == Some(id))
            })
        }) {
            why.push(t("server.channel.helpersThere", &[]));
        }
        if topics != 0 {
            why.push(t("server.channel.issuesThere", &[("n", topics.into())]));
        }
        if !why.is_empty() {
            return Err(refused(t("server.channel.inUse", &[("why", list(&why).into())])));
        }
        let threads = model.threads_of(id);
        let said = row.last_number.unwrap_or(0) + threads.iter().map(|t| t.reply_count).sum::<i64>();
        Ok((model.target_of_channel(row), threads.len(), said))
    }

    pub fn preview_remove_channel(&self, id: &str) -> Result<Preview, ApiError> {
        vibevalley_runtime::rt::block_on(self.preview_remove_channel_async(id))
    }

    pub async fn preview_remove_channel_async(&self, id: &str) -> Result<Preview, ApiError> {
        let model = self.snapshot.load_full();
        let mut conn = self.db.read_pool().acquire().await.q()?;
        let (target, threads, said) = self.removable_with_async(&model, &mut conn, id).await?;
        Ok(Preview {
            does: vec![t(
                "server.channel.deletesChannel",
                &[("target", target.into()), ("threads", threads.into()), ("said", said.into())],
            )],
        })
    }

    pub fn remove_channel(&self, id: &str) -> Result<(), ApiError> {
        vibevalley_runtime::rt::block_on(self.remove_channel_async(id))
    }

    pub async fn remove_channel_async(&self, id: &str) -> Result<(), ApiError> {
        let mut inner = self.locked().await;
        {
            let mut rconn = self.db.read_pool().acquire().await.q()?;
            self.removable_with_async(&inner.model, &mut rconn, id).await?;
        }
        let mut gone: Vec<String> = vec![];
        for c in inner.model.channel(id).into_iter().cloned().chain(inner.model.threads_of(id)) {
            gone.push(inner.model.target_of_channel(&c));
        }
        {
            let mut conn = self.db.write_pool().acquire().await.q()?;
            let mut wtx = WriteTx::begin(&mut inner, &mut conn).await?;
            db::delete_channel(&mut wtx.tx, id).await.q()?;
            wtx.model.removed(id);
            wtx.reach.channel_removed(id);
            wtx.model.last_read.retain(|_, target| !gone.contains(target));
            wtx.commit().await?;
        }
        self.apply(vec![Fact::ChannelRemoved(FactChannelRemoved { at: now(), id: id.into() })]);
        Ok(())
    }

    pub fn set_notify(&self, id: &str, notify: Notify) -> Result<(), ApiError> {
        vibevalley_runtime::rt::block_on(self.set_notify_async(id, notify))
    }

    pub async fn set_notify_async(&self, id: &str, notify: Notify) -> Result<(), ApiError> {
        let mut inner = self.locked().await;
        if inner.model.channel(id).is_none() {
            return Err(no_channel(id));
        }
        {
            let mut conn = self.db.write_pool().acquire().await.q()?;
            let mut wtx = WriteTx::begin(&mut inner, &mut conn).await?;
            db::set_notify(&mut wtx.tx, id, notify.as_str()).await.q()?;
            wtx.model.patch(id, |c| c.notify = notify.as_str().into());
            wtx.commit().await?;
        }
        self.publish_channel_async(&inner.model, id).await?;
        self.publish_user_mentions_async(&inner.model).await
    }

    /// `notifyOf`: "none" on the thread or its channel silences both.
    pub fn notify_of(&self, id: &str) -> Notify {
        let model = self.model();
        let c = model.channel(id);
        let top = c.and_then(|c| c.parent_id.as_deref()).and_then(|p| model.channel(p));
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
        vibevalley_runtime::rt::block_on(self.create_direct_async(peer))
    }

    pub async fn create_direct_async(&self, peer: &str) -> Result<String, ApiError> {
        {
            let model = self.model();
            if model.participant(peer).is_some_and(|p| p.kind == "agent")
                && let Some(had) = model.channels("direct").into_iter().find(|c| c.peer_id.as_deref() == Some(peer))
            {
                return Ok(had.id);
            }
        }
        let mut inner = self.locked().await;
        if inner.model.participant(peer).is_none_or(|p| p.kind != "agent") {
            return Err(missing(t("server.channel.noProfileNamed", &[("key", peer.into())]), LookIn::Agent));
        }
        if let Some(had) = inner.model.channels("direct").into_iter().find(|c| c.peer_id.as_deref() == Some(peer)) {
            return Ok(had.id);
        }
        let id = new_id();
        let at = now();
        {
            let mut conn = self.db.write_pool().acquire().await.q()?;
            let mut wtx = WriteTx::begin(&mut inner, &mut conn).await?;
            db::create_direct(&mut wtx.tx, &id, peer, at).await.q()?;
            wtx.model.created(ChannelRow {
                peer_id: Some(peer.into()),
                ..ChannelRow::empty(&id, "direct", at)
            });
            wtx.commit().await?;
        }
        self.publish_channel_async(&inner.model, &id).await?;
        Ok(id)
    }

    pub fn mark_unread(&self, channel: &str, number: i64) -> Result<(), ApiError> {
        vibevalley_runtime::rt::block_on(self.mark_unread_async(channel, number))
    }

    pub async fn mark_unread_async(&self, channel: &str, number: i64) -> Result<(), ApiError> {
        let mut inner = self.locked().await;
        if inner.model.channel(channel).is_none() {
            return Err(no_channel(channel));
        }
        let upto = (number - 1).max(0);
        {
            let mut conn = self.db.write_pool().acquire().await.q()?;
            let mut wtx = WriteTx::begin(&mut inner, &mut conn).await?;
            db::mark_unread(&mut wtx.tx, channel, upto, now()).await.q()?;
            wtx.model.user_read_back(channel, upto);
            wtx.commit().await?;
        }
        self.publish_channel_async(&inner.model, channel).await?;
        self.publish_user_mentions_async(&inner.model).await
    }

    pub fn make_default(&self, id: &str) -> Result<(), ApiError> {
        vibevalley_runtime::rt::block_on(self.make_default_async(id))
    }

    pub async fn make_default_async(&self, id: &str) -> Result<(), ApiError> {
        let mut inner = self.locked().await;
        let row = inner.model.channel(id).cloned().ok_or_else(|| no_channel(id))?;
        if row.r#type != "channel" {
            return Err(refused(t("server.channel.defaultIsChannel", &[])));
        }
        let was = inner.model.default_id();
        if id == was {
            return Ok(());
        }
        {
            let mut conn = self.db.write_pool().acquire().await.q()?;
            let mut wtx = WriteTx::begin(&mut inner, &mut conn).await?;
            db::clear_default(&mut wtx.tx).await.q()?;
            db::make_default(&mut wtx.tx, id).await.q()?;
            wtx.model.default_moved(&was, id);
            wtx.commit().await?;
        }
        self.publish_channel_async(&inner.model, &was).await?;
        self.publish_channel_async(&inner.model, id).await
    }

    /// `follow`: what changed in a channel after revision `after`, then each
    /// change from now on; `Reset` when too far behind.
    pub fn follow(&self, channel: &str, after: i64, sink: Sink) -> Result<(), ApiError> {
        if self.model().channel(channel).is_none() {
            return Err(refused(t("server.channel.channelGone", &[])));
        }
        // Subscribed before the missed ones are read: nothing falls in between.
        let live = self.subscribe_events();
        let db = self.db.clone();
        let channel = channel.to_string();
        let hub = self.hub.upgrade();
        let cancel = hub.as_ref().map(|h| h.child_token()).unwrap_or_default();
        let fut = async move {
            let missed = {
                let Ok(mut conn) = db.read_pool().acquire().await else { return };
                match db::messages_changed_after(&mut conn, &channel, after, CATCH_UP_MAX as i64 + 1).await {
                    Ok(rows) => rows,
                    Err(_) => return,
                }
            };
            if missed.len() > CATCH_UP_MAX {
                sink.send(&ProtocolChannelEvent::Reset {});
                return;
            }
            let upto = missed.last().map_or(after, |m| m.revision);
            for m in &missed {
                if !sink.send(&ProtocolChannelEvent::Message { message: to_message(m) }) {
                    return;
                }
            }
            relay(live, cancel, &sink, |m| m.channel == channel && m.revision > upto).await;
        };
        if let Some(hub) = hub {
            hub.spawn_task(fut);
        } else {
            vibevalley_runtime::rt::current_or_global_handle().spawn(fut);
        }
        Ok(())
    }

    /// `reports`: the reports after the one with id `after` (the newest
    /// ones without it), then each one from now on.
    pub fn reports(&self, after: Option<String>, sink: Sink) -> Result<(), ApiError> {
        let live = self.subscribe_events();
        let db = self.db.clone();
        let hub = self.hub.upgrade();
        let cancel = hub.as_ref().map(|h| h.child_token()).unwrap_or_default();
        let fut = async move {
            let missed = {
                let Ok(mut conn) = db.read_pool().acquire().await else { return };
                let res = match &after {
                    None => db::recent_reports(&mut conn, LOG_KEEP).await.map(|mut rows| {
                        rows.reverse();
                        rows
                    }),
                    Some(a) => db::reports_after(&mut conn, a, CATCH_UP_MAX as i64 + 1).await,
                };
                match res {
                    Ok(rows) => rows,
                    Err(_) => return,
                }
            };
            if missed.len() > CATCH_UP_MAX {
                sink.send(&ProtocolChannelEvent::Reset {});
                return;
            }
            let upto = missed.last().map(|m| m.id.clone()).or(after).unwrap_or_default();
            for m in &missed {
                if !sink.send(&ProtocolChannelEvent::Message { message: to_message(m) }) {
                    return;
                }
            }
            relay(live, cancel, &sink, |m| m.kind == MessageKind::Report && m.id > upto).await;
        };
        if let Some(hub) = hub {
            hub.spawn_task(fut);
        } else {
            vibevalley_runtime::rt::current_or_global_handle().spawn(fut);
        }
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

fn message_of(event: ChannelEvent) -> Option<ChatMessage> {
    match event {
        ChannelEvent::Posted(c) => Some(to_message(&c.row)),
        ChannelEvent::Edited(m) | ChannelEvent::Removed { message: m, .. } | ChannelEvent::Reacted(m) | ChannelEvent::Pinned(m) => Some(m),
        ChannelEvent::UserRead { .. } => None,
    }
}

/// Each message change that `keep` keeps, until the subscriber stops or the hub shuts down.
async fn relay(mut live: broadcast::Receiver<ChannelEvent>, cancel: CancellationToken, sink: &Sink, keep: impl Fn(&ChatMessage) -> bool) {
    loop {
        if sink.stopped() {
            return;
        }
        let next = tokio::select! {
            biased;
            _ = cancel.cancelled() => return,
            _ = sink.stop.recv_async() => return,
            res = live.recv() => res,
        };
        match next {
            Ok(ev) => {
                if let Some(m) = message_of(ev)
                    && keep(&m)
                    && !sink.send(&ProtocolChannelEvent::Message { message: m })
                {
                    return;
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => {
                let _ = sink.send(&ProtocolChannelEvent::Reset {});
                return;
            }
            Err(broadcast::error::RecvError::Closed) => return,
        }
    }
}
