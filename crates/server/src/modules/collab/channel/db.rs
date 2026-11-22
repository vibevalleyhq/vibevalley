use std::cell::RefCell;

use pollster::block_on;
use sqlx::SqliteConnection;

use super::queries;

pub type Sql<T> = sqlx::Result<T>;
// Inner serializes access; a read borrows mutably only while the SQLx worker executes its statement.
pub type Connection = RefCell<SqliteConnection>;
pub const SCHEMA: &str = crate::db::schema::COLLAB_CHANNEL;

pub(super) fn control(db: &Connection, statement: &'static str) -> Sql<()> {
    block_on(sqlx::raw_sql(statement).execute(&mut *db.borrow_mut())).map(|_| ())
}

fn optional<T>(result: Sql<T>) -> Sql<Option<T>> {
    match result {
        Err(sqlx::Error::RowNotFound) => Ok(None),
        other => other.map(Some),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChannelRow {
    pub id: String,
    pub r#type: String,
    pub is_default: bool,
    pub root_id: Option<String>,
    pub root_number: Option<i64>,
    pub subject_kind: Option<String>,
    pub subject_id: Option<String>,
    pub last_number: Option<i64>,
    pub reply_count: i64,
    pub created_at: i64,
    pub name: Option<String>,
    pub description: Option<String>,
    pub repo: Option<String>,
    pub parent_id: Option<String>,
    pub peer_id: Option<String>,
    pub revision: i64,
    pub category: Option<String>,
    pub position: Option<i64>,
    pub archived_at: Option<i64>,
    pub notify: String,
}

impl ChannelRow {
    pub fn empty(id: &str, kind: &str, created_at: i64) -> ChannelRow {
        ChannelRow {
            id: id.into(),
            r#type: kind.into(),
            is_default: false,
            root_id: None,
            root_number: None,
            subject_kind: None,
            subject_id: None,
            last_number: None,
            reply_count: 0,
            created_at,
            name: None,
            description: None,
            repo: None,
            parent_id: None,
            peer_id: None,
            revision: 0,
            category: None,
            position: None,
            archived_at: None,
            notify: "all".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParticipantRow {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub agent_id: Option<String>,
    pub home_id: Option<String>,
    pub joined_at: i64,
    pub left_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MsgRow {
    pub id: String,
    pub channel_id: String,
    pub number: i64,
    pub sender_id: String,
    pub kind: String,
    pub body: String,
    pub meta: Option<String>,
    pub send_key: Option<String>,
    pub created_at: i64,
    pub revision: i64,
    pub reply_number: Option<i64>,
    pub edited_at: Option<i64>,
    pub deleted_at: Option<i64>,
    pub pinned_at: Option<i64>,
    pub reactions: Option<String>,
    pub sender_name: String,
    pub sender_kind: String,
    pub sender_agent: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PlacedRow {
    pub row: MsgRow,
    pub channel_type: String,
    pub root_number: Option<i64>,
    pub top_id: String,
    pub channel_name: String,
}

pub struct UnreadRow {
    pub r#type: String,
    pub root_number: Option<i64>,
    pub channel_name: String,
    pub unread: i64,
    pub mentions_you: bool,
    pub latest_sender_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EventRow {
    pub seq: i64,
    pub kind: String,
    pub channel_id: String,
    pub message_id: String,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeliveryRow {
    pub id: i64,
    pub message_id: String,
    pub channel_id: String,
    pub recipient_kind: String,
    pub recipient_id: String,
    pub reason: String,
    pub wakes: bool,
    pub held_by: Option<String>,
    pub status: String,
    pub created_at: i64,
    pub settled_at: Option<i64>,
}

pub struct SearchParams<'a> {
    pub text: &'a str,
    pub channel: &'a str,
    pub sender: &'a str,
    pub has_file: bool,
    pub has_image: bool,
    pub has_link: bool,
    pub after: i64,
    pub before: i64,
    pub n: i64,
}

impl From<queries::AllChannelsRow> for ChannelRow {
    fn from(r: queries::AllChannelsRow) -> Self {
        Self {
            id: r.id,
            r#type: r.r#type,
            is_default: r.is_default != 0,
            root_id: r.root_id,
            root_number: r.root_number,
            subject_kind: r.subject_kind,
            subject_id: r.subject_id,
            last_number: r.last_number,
            reply_count: r.reply_count,
            created_at: r.created_at,
            name: r.name,
            description: r.description,
            repo: r.repo,
            parent_id: r.parent_id,
            peer_id: r.peer_id,
            revision: r.revision,
            category: r.category,
            position: r.position,
            archived_at: r.archived_at,
            notify: r.notify,
        }
    }
}

impl From<queries::MessageByIdRow> for MsgRow {
    fn from(r: queries::MessageByIdRow) -> Self {
        Self {
            id: r.id,
            channel_id: r.channel_id,
            number: r.number,
            sender_id: r.sender_id,
            kind: r.kind,
            body: r.body,
            meta: r.meta,
            send_key: r.send_key,
            created_at: r.created_at,
            revision: r.revision,
            reply_number: r.reply_number,
            edited_at: r.edited_at,
            deleted_at: r.deleted_at,
            pinned_at: r.pinned_at,
            reactions: r.reactions,
            sender_name: r.sender_name,
            sender_kind: r.sender_kind,
            sender_agent: r.sender_agent,
        }
    }
}

impl From<queries::EventsAfterRow> for EventRow {
    fn from(r: queries::EventsAfterRow) -> Self {
        Self {
            seq: r.seq,
            kind: r.kind,
            channel_id: r.channel_id,
            message_id: r.message_id,
            at: r.at,
        }
    }
}

impl From<queries::PendingDeliveriesByKindRow> for DeliveryRow {
    fn from(r: queries::PendingDeliveriesByKindRow) -> Self {
        Self {
            id: r.id,
            message_id: r.message_id,
            channel_id: r.channel_id,
            recipient_kind: r.recipient_kind,
            recipient_id: r.recipient_id,
            reason: r.reason,
            wakes: r.wakes != 0,
            held_by: r.held_by,
            status: r.status,
            created_at: r.created_at,
            settled_at: r.settled_at,
        }
    }
}

impl From<queries::UnreadOfRow> for UnreadRow {
    fn from(r: queries::UnreadOfRow) -> Self {
        Self {
            r#type: r.r#type,
            root_number: r.root_number,
            channel_name: r.channel_name,
            unread: r.unread,
            mentions_you: r.mentions_you != 0,
            latest_sender_name: r.latest_sender_name,
        }
    }
}

impl From<queries::ParticipantsRow> for ParticipantRow {
    fn from(r: queries::ParticipantsRow) -> Self {
        Self {
            id: r.id,
            kind: r.kind,
            name: r.name,
            agent_id: r.agent_id,
            home_id: r.home_id,
            joined_at: r.joined_at,
            left_at: r.left_at,
        }
    }
}

impl From<queries::UserMentionsRow> for PlacedRow {
    fn from(r: queries::UserMentionsRow) -> Self {
        Self {
            row: MsgRow {
                id: r.id,
                channel_id: r.channel_id,
                number: r.number,
                sender_id: r.sender_id,
                kind: r.kind,
                body: r.body,
                meta: r.meta,
                send_key: r.send_key,
                created_at: r.created_at,
                revision: r.revision,
                reply_number: r.reply_number,
                edited_at: r.edited_at,
                deleted_at: r.deleted_at,
                pinned_at: r.pinned_at,
                reactions: r.reactions,
                sender_name: r.sender_name,
                sender_kind: r.sender_kind,
                sender_agent: r.sender_agent,
            },
            channel_type: r.channel_type,
            root_number: r.root_number,
            top_id: r.top_id,
            channel_name: r.channel_name,
        }
    }
}

pub fn default_id(db: &Connection) -> Sql<Option<String>> {
    optional(block_on(queries::default_id(&mut *db.borrow_mut()))).map(|row| row.map(|r| r.id))
}

pub fn create_channel(db: &Connection, id: &str, is_default: bool, name: &str, description: Option<&str>, repo: Option<&str>, at: i64) -> Sql<()> {
    block_on(queries::create_channel(
        &mut *db.borrow_mut(),
        queries::CreateChannelParams {
            id: id.to_owned(),
            is_default: i64::from(is_default),
            name: Some(name.to_owned()),
            description: description.map(str::to_owned),
            repo: repo.map(str::to_owned),
            created_at: at,
        },
    ))
}

pub fn create_direct(db: &Connection, id: &str, peer: &str, at: i64) -> Sql<()> {
    block_on(queries::create_direct(
        &mut *db.borrow_mut(),
        queries::CreateDirectParams {
            id: id.to_owned(),
            peer_id: Some(peer.to_owned()),
            created_at: at,
        },
    ))
}

pub fn clear_default(db: &Connection) -> Sql<()> {
    block_on(queries::clear_default(&mut *db.borrow_mut()))
}

pub fn make_default(db: &Connection, id: &str) -> Sql<()> {
    block_on(queries::make_default(&mut *db.borrow_mut(), queries::MakeDefaultParams { id: id.to_owned() }))
}

pub fn update_channel(db: &Connection, id: &str, description: Option<&str>, repo: Option<&str>) -> Sql<()> {
    block_on(queries::update_channel(
        &mut *db.borrow_mut(),
        queries::UpdateChannelParams {
            description: description.map(str::to_owned),
            repo: repo.map(str::to_owned),
            id: id.to_owned(),
        },
    ))
}

#[allow(clippy::too_many_arguments)]
pub fn create_thread(
    db: &Connection,
    id: &str,
    root_id: &str,
    root_number: i64,
    subject_kind: &str,
    subject_id: Option<&str>,
    parent_id: &str,
    at: i64,
) -> Sql<()> {
    block_on(queries::create_thread(
        &mut *db.borrow_mut(),
        queries::CreateThreadParams {
            id: id.to_owned(),
            root_id: Some(root_id.to_owned()),
            root_number: Some(root_number),
            subject_kind: Some(subject_kind.to_owned()),
            subject_id: subject_id.map(str::to_owned),
            parent_id: Some(parent_id.to_owned()),
            created_at: at,
        },
    ))
}

pub fn all_channels(db: &Connection) -> Sql<Vec<ChannelRow>> {
    block_on(queries::all_channels(&mut *db.borrow_mut())).map(|rows| rows.into_iter().map(Into::into).collect())
}

pub fn recent_channels(db: &Connection, n: i64) -> Sql<Vec<ChannelRow>> {
    block_on(queries::recent_channels(&mut *db.borrow_mut(), queries::RecentChannelsParams { limit: n })).map(|rows| rows.into_iter().map(Into::into).collect())
}

pub fn touch_channel(db: &Connection, id: &str, number: i64) -> Sql<()> {
    block_on(queries::touch_channel(
        &mut *db.borrow_mut(),
        queries::TouchChannelParams {
            last_number: number,
            id: id.to_owned(),
        },
    ))
}

pub fn unread_of(db: &Connection, participant: &str, channel: &str) -> Sql<Vec<UnreadRow>> {
    block_on(queries::unread_of(
        &mut *db.borrow_mut(),
        queries::UnreadOfParams {
            target_id: participant.to_owned(),
            id: channel.to_owned(),
        },
    ))
    .map(|rows| rows.into_iter().map(Into::into).collect())
}

pub fn bump_revision(db: &Connection, id: &str) -> Sql<i64> {
    block_on(queries::bump_revision(&mut *db.borrow_mut(), queries::BumpRevisionParams { id: id.to_owned() })).map(|r| r.revision)
}

pub fn rename_channel(db: &Connection, id: &str, name: Option<&str>) -> Sql<()> {
    block_on(queries::rename_channel(
        &mut *db.borrow_mut(),
        queries::RenameChannelParams {
            name: name.map(str::to_owned),
            id: id.to_owned(),
        },
    ))
}

pub fn set_category(db: &Connection, id: &str, category: Option<&str>) -> Sql<()> {
    block_on(queries::set_category(
        &mut *db.borrow_mut(),
        queries::SetCategoryParams {
            category: category.map(str::to_owned),
            id: id.to_owned(),
        },
    ))
}

pub fn place_channel(db: &Connection, id: &str, position: i64) -> Sql<()> {
    block_on(queries::place_channel(
        &mut *db.borrow_mut(),
        queries::PlaceChannelParams {
            position: Some(position),
            id: id.to_owned(),
        },
    ))
}

pub fn set_archived(db: &Connection, id: &str, at: Option<i64>) -> Sql<()> {
    block_on(queries::set_archived(
        &mut *db.borrow_mut(),
        queries::SetArchivedParams {
            archived_at: at,
            id: id.to_owned(),
        },
    ))
}

pub fn set_notify(db: &Connection, id: &str, notify: &str) -> Sql<()> {
    block_on(queries::set_notify(
        &mut *db.borrow_mut(),
        queries::SetNotifyParams {
            notify: notify.to_owned(),
            id: id.to_owned(),
        },
    ))
}

pub fn topic_threads_in(db: &Connection, id: &str) -> Sql<i64> {
    block_on(queries::topic_threads_in(
        &mut *db.borrow_mut(),
        queries::TopicThreadsInParams {
            parent_id: Some(id.to_owned()),
        },
    ))
    .map(|r| r.total)
}

pub fn upsert_participant(db: &Connection, p: &ParticipantRow) -> Sql<()> {
    block_on(queries::upsert_participant(
        &mut *db.borrow_mut(),
        queries::UpsertParticipantParams {
            id: p.id.clone(),
            kind: p.kind.clone(),
            name: p.name.clone(),
            agent_id: p.agent_id.clone(),
            home_id: p.home_id.clone(),
            joined_at: p.joined_at,
        },
    ))
}

pub fn add_participant(db: &Connection, id: &str, kind: &str, name: &str, at: i64) -> Sql<()> {
    block_on(queries::add_participant(
        &mut *db.borrow_mut(),
        queries::AddParticipantParams {
            id: id.to_owned(),
            kind: kind.to_owned(),
            name: name.to_owned(),
            joined_at: at,
        },
    ))
}

pub fn participant_left(db: &Connection, id: &str, at: i64) -> Sql<()> {
    block_on(queries::participant_left(
        &mut *db.borrow_mut(),
        queries::ParticipantLeftParams {
            left_at: Some(at),
            id: id.to_owned(),
        },
    ))
}

pub fn participants(db: &Connection) -> Sql<Vec<ParticipantRow>> {
    block_on(queries::participants(&mut *db.borrow_mut())).map(|rows| rows.into_iter().map(Into::into).collect())
}

pub fn add_member(db: &Connection, channel: &str, participant: &str, reason: &str, from: i64) -> Sql<()> {
    block_on(queries::add_member(
        &mut *db.borrow_mut(),
        queries::AddMemberParams {
            channel_id: channel.to_owned(),
            participant_id: participant.to_owned(),
            reason: reason.to_owned(),
            from_number: from,
        },
    ))
}

pub fn remove_member(db: &Connection, channel: &str, participant: &str, at: i64) -> Sql<()> {
    block_on(queries::remove_member(
        &mut *db.borrow_mut(),
        queries::RemoveMemberParams {
            left_at: Some(at),
            channel_id: channel.to_owned(),
            participant_id: participant.to_owned(),
        },
    ))
}

pub fn all_members(db: &Connection) -> Sql<Vec<(String, String)>> {
    block_on(queries::all_members(&mut *db.borrow_mut())).map(|rows| rows.into_iter().map(|r| (r.channel_id, r.participant_id)).collect())
}

pub fn remove_from_all(db: &Connection, participant: &str, at: i64) -> Sql<()> {
    block_on(queries::remove_from_all(
        &mut *db.borrow_mut(),
        queries::RemoveFromAllParams {
            left_at: Some(at),
            participant_id: participant.to_owned(),
        },
    ))
}

pub fn insert_mention(db: &Connection, message: &str, target: &str, resolved: &str) -> Sql<()> {
    block_on(queries::insert_mention(
        &mut *db.borrow_mut(),
        queries::InsertMentionParams {
            message_id: message.to_owned(),
            target_id: target.to_owned(),
            resolved: resolved.to_owned(),
        },
    ))
}

pub fn delete_mentions_for_message(db: &Connection, message: &str) -> Sql<()> {
    block_on(queries::delete_mentions_for_message(
        &mut *db.borrow_mut(),
        queries::DeleteMentionsForMessageParams {
            message_id: message.to_owned(),
        },
    ))
}

pub fn mark_seen(db: &Connection, participant: &str, message: &str, at: i64) -> Sql<()> {
    block_on(queries::mark_seen(
        &mut *db.borrow_mut(),
        queries::MarkSeenParams {
            seen_at: at,
            message_id: message.to_owned(),
            participant_id: participant.to_owned(),
        },
    ))
}

pub fn set_read_cursor(db: &Connection, participant: &str, channel: &str, upto: i64, at: i64) -> Sql<()> {
    block_on(queries::set_read_cursor(
        &mut *db.borrow_mut(),
        queries::SetReadCursorParams {
            participant_id: participant.to_owned(),
            channel_id: channel.to_owned(),
            read_number: upto,
            updated_at: at,
        },
    ))
}

pub fn read_cursor(db: &Connection, participant: &str, channel: &str) -> Sql<Option<i64>> {
    optional(block_on(queries::read_cursor(
        &mut *db.borrow_mut(),
        queries::ReadCursorParams {
            participant_id: participant.to_owned(),
            channel_id: channel.to_owned(),
        },
    )))
    .map(|row| row.map(|r| r.read_number))
}

pub fn read_cursors_of(db: &Connection, participant: &str) -> Sql<Vec<(String, i64)>> {
    block_on(queries::read_cursors_of(
        &mut *db.borrow_mut(),
        queries::ReadCursorsOfParams {
            participant_id: participant.to_owned(),
        },
    ))
    .map(|rows| rows.into_iter().map(|r| (r.channel_id, r.read_number)).collect())
}

pub fn mark_unread(db: &Connection, channel: &str, upto: i64, at: i64) -> Sql<()> {
    block_on(queries::mark_unread(
        &mut *db.borrow_mut(),
        queries::MarkUnreadParams {
            channel_id: channel.to_owned(),
            read_number: upto,
            updated_at: at,
        },
    ))
}

pub fn insert_event(db: &Connection, kind: &str, channel: &str, message: &str, at: i64) -> Sql<i64> {
    block_on(queries::insert_event(
        &mut *db.borrow_mut(),
        queries::InsertEventParams {
            kind: kind.to_owned(),
            channel_id: channel.to_owned(),
            message_id: message.to_owned(),
            at,
        },
    ))
    .map(|r| r.seq)
}

pub fn events_after(db: &Connection, after: i64, n: i64) -> Sql<Vec<EventRow>> {
    block_on(queries::events_after(
        &mut *db.borrow_mut(),
        queries::EventsAfterParams { seq: after, limit: n },
    ))
    .map(|rows| rows.into_iter().map(Into::into).collect())
}

pub fn event_of(db: &Connection, message: &str) -> Sql<Option<EventRow>> {
    optional(block_on(queries::event_of(
        &mut *db.borrow_mut(),
        queries::EventOfParams {
            message_id: message.to_owned(),
        },
    )))
    .map(|row| row.map(Into::into))
}

#[allow(clippy::too_many_arguments)]
pub fn insert_message(
    db: &Connection,
    id: &str,
    channel: &str,
    sender: &str,
    kind: &str,
    body: &str,
    meta: Option<&str>,
    send_key: Option<&str>,
    at: i64,
    revision: i64,
    reply_number: Option<i64>,
) -> Sql<i64> {
    block_on(queries::insert_message(
        &mut *db.borrow_mut(),
        queries::InsertMessageParams {
            id: id.to_owned(),
            channel_id: channel.to_owned(),
            sender_id: sender.to_owned(),
            kind: kind.to_owned(),
            body: body.to_owned(),
            meta: meta.map(str::to_owned),
            send_key: send_key.map(str::to_owned),
            created_at: at,
            revision,
            reply_number,
        },
    ))
    .map(|r| r.number)
}

pub fn update_message_meta(db: &Connection, id: &str, meta: Option<&str>) -> Sql<()> {
    block_on(queries::update_message_meta(
        &mut *db.borrow_mut(),
        queries::UpdateMessageMetaParams {
            meta: meta.map(str::to_owned),
            id: id.to_owned(),
        },
    ))
}

pub fn message_by_id(db: &Connection, id: &str) -> Sql<Option<MsgRow>> {
    optional(block_on(queries::message_by_id(
        &mut *db.borrow_mut(),
        queries::MessageByIdParams { id: id.to_owned() },
    )))
    .map(|row| row.map(Into::into))
}

pub fn message_by_send_key(db: &Connection, sender: &str, key: &str) -> Sql<Option<MsgRow>> {
    optional(block_on(queries::message_by_send_key(
        &mut *db.borrow_mut(),
        queries::MessageBySendKeyParams {
            sender_id: sender.to_owned(),
            send_key: Some(key.to_owned()),
        },
    )))
    .map(|row| row.map(Into::into))
}

pub fn message_by_number(db: &Connection, channel: &str, number: i64) -> Sql<Option<MsgRow>> {
    optional(block_on(queries::message_by_number(
        &mut *db.borrow_mut(),
        queries::MessageByNumberParams {
            channel_id: channel.to_owned(),
            number,
        },
    )))
    .map(|row| row.map(Into::into))
}

pub fn user_mentions(db: &Connection) -> Sql<Vec<PlacedRow>> {
    block_on(queries::user_mentions(&mut *db.borrow_mut())).map(|rows| rows.into_iter().map(Into::into).collect())
}

pub fn messages_before(db: &Connection, channel: &str, number: i64, n: i64) -> Sql<Vec<MsgRow>> {
    block_on(queries::messages_before(
        &mut *db.borrow_mut(),
        queries::MessagesBeforeParams {
            channel_id: channel.to_owned(),
            number,
            limit: n,
        },
    ))
    .map(|rows| rows.into_iter().map(Into::into).collect())
}

pub fn messages_after(db: &Connection, channel: &str, number: i64, n: i64) -> Sql<Vec<MsgRow>> {
    block_on(queries::messages_after(
        &mut *db.borrow_mut(),
        queries::MessagesAfterParams {
            channel_id: channel.to_owned(),
            number,
            limit: n,
        },
    ))
    .map(|rows| rows.into_iter().map(Into::into).collect())
}

pub fn recent_reports(db: &Connection, n: i64) -> Sql<Vec<MsgRow>> {
    block_on(queries::recent_reports(&mut *db.borrow_mut(), queries::RecentReportsParams { limit: n })).map(|rows| rows.into_iter().map(Into::into).collect())
}

pub fn reports_after(db: &Connection, after: &str, n: i64) -> Sql<Vec<MsgRow>> {
    block_on(queries::reports_after(
        &mut *db.borrow_mut(),
        queries::ReportsAfterParams {
            id: after.to_owned(),
            limit: n,
        },
    ))
    .map(|rows| rows.into_iter().map(Into::into).collect())
}

pub fn recent_duplicate(db: &Connection, sender: &str, channel: &str, body: &str, since: i64) -> Sql<Option<String>> {
    optional(block_on(queries::recent_duplicate(
        &mut *db.borrow_mut(),
        queries::RecentDuplicateParams {
            sender_id: sender.to_owned(),
            channel_id: channel.to_owned(),
            body: body.to_owned(),
            created_at: since,
        },
    )))
    .map(|row| row.map(|r| r.id))
}

pub fn dispatches_in(db: &Connection, channel: &str) -> Sql<i64> {
    block_on(queries::dispatches_in(
        &mut *db.borrow_mut(),
        queries::DispatchesInParams {
            channel_id: channel.to_owned(),
        },
    ))
    .map(|r| r.total)
}

pub fn user_unread(db: &Connection, channel: &str, read: i64) -> Sql<i64> {
    block_on(queries::user_unread(
        &mut *db.borrow_mut(),
        queries::UserUnreadParams {
            channel_id: channel.to_owned(),
            number: read,
        },
    ))
    .map(|r| r.total)
}

pub fn latest_number(db: &Connection, channel: &str) -> Sql<i64> {
    block_on(queries::latest_number(
        &mut *db.borrow_mut(),
        queries::LatestNumberParams {
            channel_id: channel.to_owned(),
        },
    ))
    .map(|r| r.number)
}

pub fn callers_of(db: &Connection, speaker: &str, channel: &str, before: &str, n: i64) -> Sql<Vec<String>> {
    block_on(queries::callers_of(
        &mut *db.borrow_mut(),
        queries::CallersOfParams {
            target_id: speaker.to_owned(),
            channel_id: channel.to_owned(),
            id: before.to_owned(),
            limit: n,
        },
    ))
    .map(|rows| rows.into_iter().map(|r| r.sender_id).collect())
}

pub fn unseen_in(db: &Connection, channel: &str, participant: &str) -> Sql<Vec<String>> {
    block_on(queries::unseen_in(
        &mut *db.borrow_mut(),
        queries::UnseenInParams {
            channel_id: channel.to_owned(),
            sender_id: participant.to_owned(),
        },
    ))
    .map(|rows| rows.into_iter().map(|r| r.id).collect())
}

pub fn notice_since_user(db: &Connection, channel: &str, code: &str) -> Sql<i64> {
    block_on(queries::notice_since_user(
        &mut *db.borrow_mut(),
        queries::NoticeSinceUserParams {
            channel_id: channel.to_owned(),
            meta: Some(code.to_owned()),
        },
    ))
    .map(|r| r.total)
}

pub fn messages_changed_after(db: &Connection, channel: &str, revision: i64, n: i64) -> Sql<Vec<MsgRow>> {
    block_on(queries::messages_changed_after(
        &mut *db.borrow_mut(),
        queries::MessagesChangedAfterParams {
            channel_id: channel.to_owned(),
            revision,
            limit: n,
        },
    ))
    .map(|rows| rows.into_iter().map(Into::into).collect())
}

pub fn edit_message(db: &Connection, id: &str, body: &str, at: i64, revision: i64) -> Sql<()> {
    block_on(queries::edit_message(
        &mut *db.borrow_mut(),
        queries::EditMessageParams {
            body: body.to_owned(),
            edited_at: Some(at),
            revision,
            id: id.to_owned(),
        },
    ))
}

pub fn delete_message(db: &Connection, id: &str, at: i64, revision: i64) -> Sql<()> {
    block_on(queries::delete_message(
        &mut *db.borrow_mut(),
        queries::DeleteMessageParams {
            deleted_at: Some(at),
            revision,
            id: id.to_owned(),
        },
    ))
}

pub fn set_reactions(db: &Connection, id: &str, reactions: Option<&str>, revision: i64) -> Sql<()> {
    block_on(queries::set_reactions(
        &mut *db.borrow_mut(),
        queries::SetReactionsParams {
            reactions: reactions.map(str::to_owned),
            revision,
            id: id.to_owned(),
        },
    ))
}

pub fn set_pinned(db: &Connection, id: &str, at: Option<i64>, revision: i64) -> Sql<()> {
    block_on(queries::set_pinned(
        &mut *db.borrow_mut(),
        queries::SetPinnedParams {
            pinned_at: at,
            revision,
            id: id.to_owned(),
        },
    ))
}

pub fn set_meta(db: &Connection, id: &str, meta: Option<&str>, revision: i64) -> Sql<()> {
    block_on(queries::set_meta(
        &mut *db.borrow_mut(),
        queries::SetMetaParams {
            meta: meta.map(str::to_owned),
            revision,
            id: id.to_owned(),
        },
    ))
}

pub fn pinned_in(db: &Connection, channel: &str) -> Sql<Vec<MsgRow>> {
    block_on(queries::pinned_in(
        &mut *db.borrow_mut(),
        queries::PinnedInParams {
            channel_id: channel.to_owned(),
        },
    ))
    .map(|rows| rows.into_iter().map(Into::into).collect())
}

pub fn search_messages(db: &Connection, q: &SearchParams) -> Sql<Vec<PlacedRow>> {
    block_on(queries::search_messages(
        &mut *db.borrow_mut(),
        queries::SearchMessagesParams {
            needle: q.text.to_owned(),
            place: q.channel.to_owned(),
            sender: q.sender.to_owned(),
            file_only: i64::from(q.has_file),
            image_only: i64::from(q.has_image),
            link_only: i64::from(q.has_link),
            since: q.after,
            until_time: q.before,
            page_size: q.n,
        },
    ))
    .map(|rows| rows.into_iter().map(Into::into).collect())
}

pub fn notification_receipt(db: &Connection, id: &str) -> Sql<Option<(Option<i64>, bool)>> {
    optional(block_on(queries::notification_receipt(
        &mut *db.borrow_mut(),
        queries::NotificationReceiptParams { id: id.to_owned() },
    )))
    .map(|row| row.map(|r| (r.updated_at, r.superseded != 0)))
}

pub fn user_read_reports(db: &Connection) -> Sql<Vec<(String, i64, i64)>> {
    block_on(queries::user_read_reports(&mut *db.borrow_mut())).map(|rows| rows.into_iter().map(|r| (r.sender_id, r.created_at, r.updated_at)).collect())
}

#[allow(clippy::too_many_arguments)]
pub fn insert_delivery(
    db: &Connection,
    message_id: &str,
    channel_id: &str,
    recipient_kind: &str,
    recipient_id: &str,
    reason: &str,
    wakes: bool,
    held_by: Option<&str>,
    at: i64,
) -> Sql<i64> {
    block_on(queries::insert_delivery(
        &mut *db.borrow_mut(),
        queries::InsertDeliveryParams {
            message_id: message_id.to_owned(),
            channel_id: channel_id.to_owned(),
            recipient_kind: recipient_kind.to_owned(),
            recipient_id: recipient_id.to_owned(),
            reason: reason.to_owned(),
            wakes: i64::from(wakes),
            held_by: held_by.map(str::to_owned),
            created_at: at,
        },
    ))
    .map(|r| r.id)
}

pub fn pending_deliveries_by_kind(db: &Connection, recipient_kind: &str) -> Sql<Vec<DeliveryRow>> {
    block_on(queries::pending_deliveries_by_kind(
        &mut *db.borrow_mut(),
        queries::PendingDeliveriesByKindParams {
            recipient_kind: recipient_kind.to_owned(),
        },
    ))
    .map(|rows| rows.into_iter().map(Into::into).collect())
}

pub fn pending_deliveries_for_recipient(db: &Connection, recipient_kind: &str, recipient_id: &str, max_id: i64) -> Sql<Vec<DeliveryRow>> {
    block_on(queries::pending_deliveries_for_recipient(
        &mut *db.borrow_mut(),
        queries::PendingDeliveriesForRecipientParams {
            recipient_kind: recipient_kind.to_owned(),
            recipient_id: recipient_id.to_owned(),
            id: max_id,
        },
    ))
    .map(|rows| rows.into_iter().map(Into::into).collect())
}

pub fn delivery_is_pending(db: &Connection, id: i64) -> Sql<bool> {
    block_on(queries::delivery_is_pending(&mut *db.borrow_mut(), queries::DeliveryIsPendingParams { id })).map(|r| r.total > 0)
}

pub fn pending_deliveries_for_message(db: &Connection, message_id: &str) -> Sql<i64> {
    block_on(queries::pending_deliveries_for_message(
        &mut *db.borrow_mut(),
        queries::PendingDeliveriesForMessageParams {
            message_id: message_id.to_owned(),
        },
    ))
    .map(|r| r.total)
}

pub fn settle_delivery(db: &Connection, id: i64, status: &str, at: i64) -> Sql<()> {
    block_on(queries::settle_delivery(
        &mut *db.borrow_mut(),
        queries::SettleDeliveryParams {
            status: status.to_owned(),
            settled_at: Some(at),
            id,
        },
    ))
}

pub fn withdraw_deliveries_for_message(db: &Connection, message_id: &str, at: i64) -> Sql<()> {
    block_on(queries::withdraw_deliveries_for_message(
        &mut *db.borrow_mut(),
        queries::WithdrawDeliveriesForMessageParams {
            settled_at: Some(at),
            message_id: message_id.to_owned(),
        },
    ))
}

pub fn withdraw_deliveries_for_recipient(db: &Connection, recipient_kind: &str, recipient_id: &str, at: i64) -> Sql<()> {
    block_on(queries::withdraw_deliveries_for_recipient(
        &mut *db.borrow_mut(),
        queries::WithdrawDeliveriesForRecipientParams {
            settled_at: Some(at),
            recipient_kind: recipient_kind.to_owned(),
            recipient_id: recipient_id.to_owned(),
        },
    ))
}

pub fn delete_channel(db: &Connection, id: &str) -> Sql<()> {
    let mut db = db.borrow_mut();
    block_on(async {
        queries::remove_channel_deliveries(&mut *db, queries::RemoveChannelDeliveriesParams { channel_id: id.to_owned() }).await?;
        queries::remove_thread_messages(
            &mut *db,
            queries::RemoveThreadMessagesParams {
                parent_id: Some(id.to_owned()),
            },
        )
        .await?;
        queries::remove_channel_members(&mut *db, queries::RemoveChannelMembersParams { channel_id: id.to_owned() }).await?;
        queries::remove_channel_cursors(&mut *db, queries::RemoveChannelCursorsParams { channel_id: id.to_owned() }).await?;
        queries::remove_threads(
            &mut *db,
            queries::RemoveThreadsParams {
                parent_id: Some(id.to_owned()),
            },
        )
        .await?;
        queries::remove_messages(&mut *db, queries::RemoveMessagesParams { channel_id: id.to_owned() }).await?;
        queries::remove_channel(&mut *db, queries::RemoveChannelParams { id: id.to_owned() }).await?;
        Ok(())
    })
}
