use sqlx::SqliteConnection;

use super::queries;

pub type Sql<T> = sqlx::Result<T>;
pub const SCHEMA: &str = crate::db::schema::COLLAB_CHANNEL;

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

pub async fn default_id(conn: &mut SqliteConnection) -> Sql<Option<String>> {
    optional(queries::default_id(conn).await).map(|row| row.map(|r| r.id))
}

pub async fn create_channel(
    conn: &mut SqliteConnection,
    id: &str,
    is_default: bool,
    name: &str,
    description: Option<&str>,
    repo: Option<&str>,
    at: i64,
) -> Sql<()> {
    queries::create_channel(
        conn,
        queries::CreateChannelParams {
            id: id.to_owned(),
            is_default: i64::from(is_default),
            name: Some(name.to_owned()),
            description: description.map(str::to_owned),
            repo: repo.map(str::to_owned),
            created_at: at,
        },
    )
    .await
}

pub async fn create_direct(conn: &mut SqliteConnection, id: &str, peer: &str, at: i64) -> Sql<()> {
    queries::create_direct(
        conn,
        queries::CreateDirectParams {
            id: id.to_owned(),
            peer_id: Some(peer.to_owned()),
            created_at: at,
        },
    )
    .await
}

pub async fn clear_default(conn: &mut SqliteConnection) -> Sql<()> {
    queries::clear_default(conn).await
}

pub async fn make_default(conn: &mut SqliteConnection, id: &str) -> Sql<()> {
    queries::make_default(conn, queries::MakeDefaultParams { id: id.to_owned() }).await
}

pub async fn update_channel(conn: &mut SqliteConnection, id: &str, description: Option<&str>, repo: Option<&str>) -> Sql<()> {
    queries::update_channel(
        conn,
        queries::UpdateChannelParams {
            description: description.map(str::to_owned),
            repo: repo.map(str::to_owned),
            id: id.to_owned(),
        },
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn create_thread(
    conn: &mut SqliteConnection,
    id: &str,
    root_id: &str,
    root_number: i64,
    subject_kind: &str,
    subject_id: Option<&str>,
    parent_id: &str,
    at: i64,
) -> Sql<()> {
    queries::create_thread(
        conn,
        queries::CreateThreadParams {
            id: id.to_owned(),
            root_id: Some(root_id.to_owned()),
            root_number: Some(root_number),
            subject_kind: Some(subject_kind.to_owned()),
            subject_id: subject_id.map(str::to_owned),
            parent_id: Some(parent_id.to_owned()),
            created_at: at,
        },
    )
    .await
}

pub async fn all_channels(conn: &mut SqliteConnection) -> Sql<Vec<ChannelRow>> {
    queries::all_channels(conn).await.map(|rows| rows.into_iter().map(Into::into).collect())
}

pub async fn recent_channels(conn: &mut SqliteConnection, n: i64) -> Sql<Vec<ChannelRow>> {
    queries::recent_channels(conn, queries::RecentChannelsParams { limit: n })
        .await
        .map(|rows| rows.into_iter().map(Into::into).collect())
}

pub async fn touch_channel(conn: &mut SqliteConnection, id: &str, number: i64) -> Sql<()> {
    queries::touch_channel(
        conn,
        queries::TouchChannelParams {
            last_number: number,
            id: id.to_owned(),
        },
    )
    .await
}

pub async fn unread_of(conn: &mut SqliteConnection, participant: &str, channel: &str) -> Sql<Vec<UnreadRow>> {
    queries::unread_of(
        conn,
        queries::UnreadOfParams {
            target_id: participant.to_owned(),
            id: channel.to_owned(),
        },
    )
    .await
    .map(|rows| rows.into_iter().map(Into::into).collect())
}

pub async fn bump_revision(conn: &mut SqliteConnection, id: &str) -> Sql<i64> {
    queries::bump_revision(conn, queries::BumpRevisionParams { id: id.to_owned() })
        .await
        .map(|r| r.revision)
}

pub async fn rename_channel(conn: &mut SqliteConnection, id: &str, name: Option<&str>) -> Sql<()> {
    queries::rename_channel(
        conn,
        queries::RenameChannelParams {
            name: name.map(str::to_owned),
            id: id.to_owned(),
        },
    )
    .await
}

pub async fn set_category(conn: &mut SqliteConnection, id: &str, category: Option<&str>) -> Sql<()> {
    queries::set_category(
        conn,
        queries::SetCategoryParams {
            category: category.map(str::to_owned),
            id: id.to_owned(),
        },
    )
    .await
}

pub async fn place_channel(conn: &mut SqliteConnection, id: &str, position: i64) -> Sql<()> {
    queries::place_channel(
        conn,
        queries::PlaceChannelParams {
            position: Some(position),
            id: id.to_owned(),
        },
    )
    .await
}

pub async fn set_archived(conn: &mut SqliteConnection, id: &str, at: Option<i64>) -> Sql<()> {
    queries::set_archived(
        conn,
        queries::SetArchivedParams {
            archived_at: at,
            id: id.to_owned(),
        },
    )
    .await
}

pub async fn set_notify(conn: &mut SqliteConnection, id: &str, notify: &str) -> Sql<()> {
    queries::set_notify(
        conn,
        queries::SetNotifyParams {
            notify: notify.to_owned(),
            id: id.to_owned(),
        },
    )
    .await
}

pub async fn topic_threads_in(conn: &mut SqliteConnection, id: &str) -> Sql<i64> {
    queries::topic_threads_in(
        conn,
        queries::TopicThreadsInParams {
            parent_id: Some(id.to_owned()),
        },
    )
    .await
    .map(|r| r.total)
}

pub async fn upsert_participant(conn: &mut SqliteConnection, p: &ParticipantRow) -> Sql<()> {
    queries::upsert_participant(
        conn,
        queries::UpsertParticipantParams {
            id: p.id.clone(),
            kind: p.kind.clone(),
            name: p.name.clone(),
            agent_id: p.agent_id.clone(),
            home_id: p.home_id.clone(),
            joined_at: p.joined_at,
        },
    )
    .await
}

pub async fn add_participant(conn: &mut SqliteConnection, id: &str, kind: &str, name: &str, at: i64) -> Sql<()> {
    queries::add_participant(
        conn,
        queries::AddParticipantParams {
            id: id.to_owned(),
            kind: kind.to_owned(),
            name: name.to_owned(),
            joined_at: at,
        },
    )
    .await
}

pub async fn participant_left(conn: &mut SqliteConnection, id: &str, at: i64) -> Sql<()> {
    queries::participant_left(
        conn,
        queries::ParticipantLeftParams {
            left_at: Some(at),
            id: id.to_owned(),
        },
    )
    .await
}

pub async fn participants(conn: &mut SqliteConnection) -> Sql<Vec<ParticipantRow>> {
    queries::participants(conn).await.map(|rows| rows.into_iter().map(Into::into).collect())
}

pub async fn add_member(conn: &mut SqliteConnection, channel: &str, participant: &str, reason: &str, from: i64) -> Sql<()> {
    queries::add_member(
        conn,
        queries::AddMemberParams {
            channel_id: channel.to_owned(),
            participant_id: participant.to_owned(),
            reason: reason.to_owned(),
            from_number: from,
        },
    )
    .await
}

pub async fn remove_member(conn: &mut SqliteConnection, channel: &str, participant: &str, at: i64) -> Sql<()> {
    queries::remove_member(
        conn,
        queries::RemoveMemberParams {
            left_at: Some(at),
            channel_id: channel.to_owned(),
            participant_id: participant.to_owned(),
        },
    )
    .await
}

pub async fn all_members(conn: &mut SqliteConnection) -> Sql<Vec<(String, String)>> {
    queries::all_members(conn)
        .await
        .map(|rows| rows.into_iter().map(|r| (r.channel_id, r.participant_id)).collect())
}

pub async fn remove_from_all(conn: &mut SqliteConnection, participant: &str, at: i64) -> Sql<()> {
    queries::remove_from_all(
        conn,
        queries::RemoveFromAllParams {
            left_at: Some(at),
            participant_id: participant.to_owned(),
        },
    )
    .await
}

pub async fn insert_mention(conn: &mut SqliteConnection, message: &str, target: &str, resolved: &str) -> Sql<()> {
    queries::insert_mention(
        conn,
        queries::InsertMentionParams {
            message_id: message.to_owned(),
            target_id: target.to_owned(),
            resolved: resolved.to_owned(),
        },
    )
    .await
}

pub async fn delete_mentions_for_message(conn: &mut SqliteConnection, message: &str) -> Sql<()> {
    queries::delete_mentions_for_message(
        conn,
        queries::DeleteMentionsForMessageParams {
            message_id: message.to_owned(),
        },
    )
    .await
}

pub async fn mark_seen(conn: &mut SqliteConnection, participant: &str, message: &str, at: i64) -> Sql<()> {
    queries::mark_seen(
        conn,
        queries::MarkSeenParams {
            seen_at: at,
            message_id: message.to_owned(),
            participant_id: participant.to_owned(),
        },
    )
    .await
}

pub async fn set_read_cursor(conn: &mut SqliteConnection, participant: &str, channel: &str, upto: i64, at: i64) -> Sql<()> {
    queries::set_read_cursor(
        conn,
        queries::SetReadCursorParams {
            participant_id: participant.to_owned(),
            channel_id: channel.to_owned(),
            read_number: upto,
            updated_at: at,
        },
    )
    .await
}

pub async fn read_cursor(conn: &mut SqliteConnection, participant: &str, channel: &str) -> Sql<Option<i64>> {
    optional(
        queries::read_cursor(
            conn,
            queries::ReadCursorParams {
                participant_id: participant.to_owned(),
                channel_id: channel.to_owned(),
            },
        )
        .await,
    )
    .map(|row| row.map(|r| r.read_number))
}

pub async fn read_cursors_of(conn: &mut SqliteConnection, participant: &str) -> Sql<Vec<(String, i64)>> {
    queries::read_cursors_of(
        conn,
        queries::ReadCursorsOfParams {
            participant_id: participant.to_owned(),
        },
    )
    .await
    .map(|rows| rows.into_iter().map(|r| (r.channel_id, r.read_number)).collect())
}

pub async fn mark_unread(conn: &mut SqliteConnection, channel: &str, upto: i64, at: i64) -> Sql<()> {
    queries::mark_unread(
        conn,
        queries::MarkUnreadParams {
            channel_id: channel.to_owned(),
            read_number: upto,
            updated_at: at,
        },
    )
    .await
}

pub async fn insert_event(conn: &mut SqliteConnection, kind: &str, channel: &str, message: &str, at: i64) -> Sql<i64> {
    queries::insert_event(
        conn,
        queries::InsertEventParams {
            kind: kind.to_owned(),
            channel_id: channel.to_owned(),
            message_id: message.to_owned(),
            at,
        },
    )
    .await
    .map(|r| r.seq)
}

pub async fn events_after(conn: &mut SqliteConnection, after: i64, n: i64) -> Sql<Vec<EventRow>> {
    queries::events_after(conn, queries::EventsAfterParams { seq: after, limit: n })
        .await
        .map(|rows| rows.into_iter().map(Into::into).collect())
}

pub async fn event_of(conn: &mut SqliteConnection, message: &str) -> Sql<Option<EventRow>> {
    optional(
        queries::event_of(
            conn,
            queries::EventOfParams {
                message_id: message.to_owned(),
            },
        )
        .await,
    )
    .map(|row| row.map(Into::into))
}

#[allow(clippy::too_many_arguments)]
pub async fn insert_message(
    conn: &mut SqliteConnection,
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
    queries::insert_message(
        conn,
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
    )
    .await
    .map(|r| r.number)
}

pub async fn update_message_meta(conn: &mut SqliteConnection, id: &str, meta: Option<&str>) -> Sql<()> {
    queries::update_message_meta(
        conn,
        queries::UpdateMessageMetaParams {
            meta: meta.map(str::to_owned),
            id: id.to_owned(),
        },
    )
    .await
}

pub async fn message_by_id(conn: &mut SqliteConnection, id: &str) -> Sql<Option<MsgRow>> {
    optional(queries::message_by_id(conn, queries::MessageByIdParams { id: id.to_owned() }).await).map(|row| row.map(Into::into))
}

pub async fn message_by_send_key(conn: &mut SqliteConnection, sender: &str, key: &str) -> Sql<Option<MsgRow>> {
    optional(
        queries::message_by_send_key(
            conn,
            queries::MessageBySendKeyParams {
                sender_id: sender.to_owned(),
                send_key: Some(key.to_owned()),
            },
        )
        .await,
    )
    .map(|row| row.map(Into::into))
}

pub async fn message_by_number(conn: &mut SqliteConnection, channel: &str, number: i64) -> Sql<Option<MsgRow>> {
    optional(
        queries::message_by_number(
            conn,
            queries::MessageByNumberParams {
                channel_id: channel.to_owned(),
                number,
            },
        )
        .await,
    )
    .map(|row| row.map(Into::into))
}

pub async fn user_mentions(conn: &mut SqliteConnection) -> Sql<Vec<PlacedRow>> {
    queries::user_mentions(conn).await.map(|rows| rows.into_iter().map(Into::into).collect())
}

pub async fn messages_before(conn: &mut SqliteConnection, channel: &str, number: i64, n: i64) -> Sql<Vec<MsgRow>> {
    queries::messages_before(
        conn,
        queries::MessagesBeforeParams {
            channel_id: channel.to_owned(),
            number,
            limit: n,
        },
    )
    .await
    .map(|rows| rows.into_iter().map(Into::into).collect())
}

pub async fn messages_after(conn: &mut SqliteConnection, channel: &str, number: i64, n: i64) -> Sql<Vec<MsgRow>> {
    queries::messages_after(
        conn,
        queries::MessagesAfterParams {
            channel_id: channel.to_owned(),
            number,
            limit: n,
        },
    )
    .await
    .map(|rows| rows.into_iter().map(Into::into).collect())
}

pub async fn recent_reports(conn: &mut SqliteConnection, n: i64) -> Sql<Vec<MsgRow>> {
    queries::recent_reports(conn, queries::RecentReportsParams { limit: n })
        .await
        .map(|rows| rows.into_iter().map(Into::into).collect())
}

pub async fn reports_after(conn: &mut SqliteConnection, after: &str, n: i64) -> Sql<Vec<MsgRow>> {
    queries::reports_after(
        conn,
        queries::ReportsAfterParams {
            id: after.to_owned(),
            limit: n,
        },
    )
    .await
    .map(|rows| rows.into_iter().map(Into::into).collect())
}

pub async fn recent_duplicate(conn: &mut SqliteConnection, sender: &str, channel: &str, body: &str, since: i64) -> Sql<Option<String>> {
    optional(
        queries::recent_duplicate(
            conn,
            queries::RecentDuplicateParams {
                sender_id: sender.to_owned(),
                channel_id: channel.to_owned(),
                body: body.to_owned(),
                created_at: since,
            },
        )
        .await,
    )
    .map(|row| row.map(|r| r.id))
}

pub async fn dispatches_in(conn: &mut SqliteConnection, channel: &str) -> Sql<i64> {
    queries::dispatches_in(
        conn,
        queries::DispatchesInParams {
            channel_id: channel.to_owned(),
        },
    )
    .await
    .map(|r| r.total)
}

pub async fn user_unread(conn: &mut SqliteConnection, channel: &str, read: i64) -> Sql<i64> {
    queries::user_unread(
        conn,
        queries::UserUnreadParams {
            channel_id: channel.to_owned(),
            number: read,
        },
    )
    .await
    .map(|r| r.total)
}

pub async fn latest_number(conn: &mut SqliteConnection, channel: &str) -> Sql<i64> {
    queries::latest_number(
        conn,
        queries::LatestNumberParams {
            channel_id: channel.to_owned(),
        },
    )
    .await
    .map(|r| r.number)
}

pub async fn callers_of(conn: &mut SqliteConnection, speaker: &str, channel: &str, before: &str, n: i64) -> Sql<Vec<String>> {
    queries::callers_of(
        conn,
        queries::CallersOfParams {
            target_id: speaker.to_owned(),
            channel_id: channel.to_owned(),
            id: before.to_owned(),
            limit: n,
        },
    )
    .await
    .map(|rows| rows.into_iter().map(|r| r.sender_id).collect())
}

pub async fn unseen_in(conn: &mut SqliteConnection, channel: &str, participant: &str) -> Sql<Vec<String>> {
    queries::unseen_in(
        conn,
        queries::UnseenInParams {
            channel_id: channel.to_owned(),
            sender_id: participant.to_owned(),
        },
    )
    .await
    .map(|rows| rows.into_iter().map(|r| r.id).collect())
}

pub async fn notice_since_user(conn: &mut SqliteConnection, channel: &str, code: &str) -> Sql<i64> {
    queries::notice_since_user(
        conn,
        queries::NoticeSinceUserParams {
            channel_id: channel.to_owned(),
            meta: Some(code.to_owned()),
        },
    )
    .await
    .map(|r| r.total)
}

pub async fn messages_changed_after(conn: &mut SqliteConnection, channel: &str, revision: i64, n: i64) -> Sql<Vec<MsgRow>> {
    queries::messages_changed_after(
        conn,
        queries::MessagesChangedAfterParams {
            channel_id: channel.to_owned(),
            revision,
            limit: n,
        },
    )
    .await
    .map(|rows| rows.into_iter().map(Into::into).collect())
}

pub async fn edit_message(conn: &mut SqliteConnection, id: &str, body: &str, at: i64, revision: i64) -> Sql<()> {
    queries::edit_message(
        conn,
        queries::EditMessageParams {
            body: body.to_owned(),
            edited_at: Some(at),
            revision,
            id: id.to_owned(),
        },
    )
    .await
}

pub async fn delete_message(conn: &mut SqliteConnection, id: &str, at: i64, revision: i64) -> Sql<()> {
    queries::delete_message(
        conn,
        queries::DeleteMessageParams {
            deleted_at: Some(at),
            revision,
            id: id.to_owned(),
        },
    )
    .await
}

pub async fn set_reactions(conn: &mut SqliteConnection, id: &str, reactions: Option<&str>, revision: i64) -> Sql<()> {
    queries::set_reactions(
        conn,
        queries::SetReactionsParams {
            reactions: reactions.map(str::to_owned),
            revision,
            id: id.to_owned(),
        },
    )
    .await
}

pub async fn set_pinned(conn: &mut SqliteConnection, id: &str, at: Option<i64>, revision: i64) -> Sql<()> {
    queries::set_pinned(
        conn,
        queries::SetPinnedParams {
            pinned_at: at,
            revision,
            id: id.to_owned(),
        },
    )
    .await
}

pub async fn set_meta(conn: &mut SqliteConnection, id: &str, meta: Option<&str>, revision: i64) -> Sql<()> {
    queries::set_meta(
        conn,
        queries::SetMetaParams {
            meta: meta.map(str::to_owned),
            revision,
            id: id.to_owned(),
        },
    )
    .await
}

pub async fn pinned_in(conn: &mut SqliteConnection, channel: &str) -> Sql<Vec<MsgRow>> {
    queries::pinned_in(
        conn,
        queries::PinnedInParams {
            channel_id: channel.to_owned(),
        },
    )
    .await
    .map(|rows| rows.into_iter().map(Into::into).collect())
}

pub async fn search_messages(conn: &mut SqliteConnection, q: &SearchParams<'_>) -> Sql<Vec<PlacedRow>> {
    queries::search_messages(
        conn,
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
    )
    .await
    .map(|rows| rows.into_iter().map(Into::into).collect())
}

pub async fn notification_receipt(conn: &mut SqliteConnection, id: &str) -> Sql<Option<(Option<i64>, bool)>> {
    optional(queries::notification_receipt(conn, queries::NotificationReceiptParams { id: id.to_owned() }).await)
        .map(|row| row.map(|r| (r.updated_at, r.superseded != 0)))
}

pub async fn user_read_reports(conn: &mut SqliteConnection) -> Sql<Vec<(String, i64, i64)>> {
    queries::user_read_reports(conn)
        .await
        .map(|rows| rows.into_iter().map(|r| (r.sender_id, r.created_at, r.updated_at)).collect())
}

#[allow(clippy::too_many_arguments)]
pub async fn insert_delivery(
    conn: &mut SqliteConnection,
    message_id: &str,
    channel_id: &str,
    recipient_kind: &str,
    recipient_id: &str,
    reason: &str,
    wakes: bool,
    held_by: Option<&str>,
    at: i64,
) -> Sql<i64> {
    queries::insert_delivery(
        conn,
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
    )
    .await
    .map(|r| r.id)
}

pub async fn pending_deliveries_by_kind(conn: &mut SqliteConnection, recipient_kind: &str) -> Sql<Vec<DeliveryRow>> {
    queries::pending_deliveries_by_kind(
        conn,
        queries::PendingDeliveriesByKindParams {
            recipient_kind: recipient_kind.to_owned(),
        },
    )
    .await
    .map(|rows| rows.into_iter().map(Into::into).collect())
}

pub async fn pending_deliveries_for_recipient(conn: &mut SqliteConnection, recipient_kind: &str, recipient_id: &str, max_id: i64) -> Sql<Vec<DeliveryRow>> {
    queries::pending_deliveries_for_recipient(
        conn,
        queries::PendingDeliveriesForRecipientParams {
            recipient_kind: recipient_kind.to_owned(),
            recipient_id: recipient_id.to_owned(),
            id: max_id,
        },
    )
    .await
    .map(|rows| rows.into_iter().map(Into::into).collect())
}

pub async fn delivery_is_pending(conn: &mut SqliteConnection, id: i64) -> Sql<bool> {
    queries::delivery_is_pending(conn, queries::DeliveryIsPendingParams { id })
        .await
        .map(|r| r.total > 0)
}

pub async fn pending_deliveries_for_message(conn: &mut SqliteConnection, message_id: &str) -> Sql<i64> {
    queries::pending_deliveries_for_message(
        conn,
        queries::PendingDeliveriesForMessageParams {
            message_id: message_id.to_owned(),
        },
    )
    .await
    .map(|r| r.total)
}

pub async fn settle_delivery(conn: &mut SqliteConnection, id: i64, status: &str, at: i64) -> Sql<()> {
    queries::settle_delivery(
        conn,
        queries::SettleDeliveryParams {
            status: status.to_owned(),
            settled_at: Some(at),
            id,
        },
    )
    .await
}

pub async fn withdraw_deliveries_for_message(conn: &mut SqliteConnection, message_id: &str, at: i64) -> Sql<()> {
    queries::withdraw_deliveries_for_message(
        conn,
        queries::WithdrawDeliveriesForMessageParams {
            settled_at: Some(at),
            message_id: message_id.to_owned(),
        },
    )
    .await
}

pub async fn withdraw_deliveries_for_recipient(conn: &mut SqliteConnection, recipient_kind: &str, recipient_id: &str, at: i64) -> Sql<()> {
    queries::withdraw_deliveries_for_recipient(
        conn,
        queries::WithdrawDeliveriesForRecipientParams {
            settled_at: Some(at),
            recipient_kind: recipient_kind.to_owned(),
            recipient_id: recipient_id.to_owned(),
        },
    )
    .await
}

pub async fn delete_channel(conn: &mut SqliteConnection, id: &str) -> Sql<()> {
    queries::remove_channel_deliveries(&mut *conn, queries::RemoveChannelDeliveriesParams { channel_id: id.to_owned() }).await?;
    queries::remove_thread_messages(
        &mut *conn,
        queries::RemoveThreadMessagesParams {
            parent_id: Some(id.to_owned()),
        },
    )
    .await?;
    queries::remove_channel_members(&mut *conn, queries::RemoveChannelMembersParams { channel_id: id.to_owned() }).await?;
    queries::remove_channel_cursors(&mut *conn, queries::RemoveChannelCursorsParams { channel_id: id.to_owned() }).await?;
    queries::remove_threads(
        &mut *conn,
        queries::RemoveThreadsParams {
            parent_id: Some(id.to_owned()),
        },
    )
    .await?;
    queries::remove_messages(&mut *conn, queries::RemoveMessagesParams { channel_id: id.to_owned() }).await?;
    queries::remove_channel(&mut *conn, queries::RemoveChannelParams { id: id.to_owned() }).await?;
    Ok(())
}
