//! Dual-backend persistence for channels, threads, direct messages, participants,
//! memberships, messages, mentions, read cursors, seen markers, events, and deliveries.

use std::collections::HashMap;
use std::sync::Arc;

use sea_orm::sea_query::{Alias, Condition, Expr, Func, JoinType, LikeExpr, OnConflict, Order, Query, SelectStatement, SubQueryStatement};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait, EntityTrait, ExprTrait, FromQueryResult, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, Update,
};

use crate::db::entity::{
    channel, channel_delivery, channel_event, channel_member, channel_mention, channel_message, channel_participant, channel_read_cursor, channel_seen,
};
use crate::db::{Database, DbError, DbResult, Tx};

#[derive(Debug, Clone, PartialEq, Eq)]
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParticipantRow {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub agent_id: Option<String>,
    pub home_id: Option<String>,
    pub joined_at: i64,
    pub left_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
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

#[derive(Debug, Clone)]
pub struct UnreadRow {
    pub r#type: String,
    pub root_number: Option<i64>,
    pub channel_name: String,
    pub unread: i64,
    pub mentions_you: bool,
    pub latest_sender_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventRow {
    pub seq: i64,
    pub kind: String,
    pub channel_id: String,
    pub message_id: String,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
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

pub struct NewThread<'a> {
    pub id: &'a str,
    pub root_id: &'a str,
    pub root_number: i64,
    pub subject_kind: &'a str,
    pub subject_id: Option<&'a str>,
    pub parent_id: &'a str,
    pub at: i64,
}

pub struct NewMessage<'a> {
    pub id: &'a str,
    pub channel_id: &'a str,
    pub sender: &'a str,
    pub kind: &'a str,
    pub body: &'a str,
    pub meta: Option<&'a str>,
    pub system_code: Option<&'a str>,
    pub send_key: Option<&'a str>,
    pub at: i64,
    pub revision: i64,
    pub reply_number: Option<i64>,
}

pub struct NewDelivery<'a> {
    pub message_id: &'a str,
    pub channel_id: &'a str,
    pub recipient_kind: &'a str,
    pub recipient_id: &'a str,
    pub reason: &'a str,
    pub wakes: bool,
    pub held_by: Option<&'a str>,
    pub at: i64,
}

impl From<channel::Model> for ChannelRow {
    fn from(r: channel::Model) -> Self {
        Self {
            id: r.id,
            r#type: r.channel_type,
            is_default: r.is_default,
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

impl From<channel_participant::Model> for ParticipantRow {
    fn from(r: channel_participant::Model) -> Self {
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

impl From<channel_event::Model> for EventRow {
    fn from(r: channel_event::Model) -> Self {
        Self {
            seq: r.seq,
            kind: r.kind,
            channel_id: r.channel_id,
            message_id: r.message_id,
            at: r.at,
        }
    }
}

impl From<channel_delivery::Model> for DeliveryRow {
    fn from(r: channel_delivery::Model) -> Self {
        Self {
            id: r.id,
            message_id: r.message_id,
            channel_id: r.channel_id,
            recipient_kind: r.recipient_kind,
            recipient_id: r.recipient_id,
            reason: r.reason,
            wakes: r.wakes,
            held_by: r.held_by,
            status: r.status,
            created_at: r.created_at,
            settled_at: r.settled_at,
        }
    }
}

#[derive(FromQueryResult)]
struct MsgQueryRow {
    id: String,
    channel_id: String,
    number: i64,
    sender_id: String,
    kind: String,
    body: String,
    meta: Option<String>,
    send_key: Option<String>,
    created_at: i64,
    revision: i64,
    reply_number: Option<i64>,
    edited_at: Option<i64>,
    deleted_at: Option<i64>,
    pinned_at: Option<i64>,
    reactions: Option<String>,
    sender_name: String,
    sender_kind: String,
    sender_agent: Option<String>,
}

impl From<MsgQueryRow> for MsgRow {
    fn from(r: MsgQueryRow) -> Self {
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

#[derive(FromQueryResult)]
struct PlacedQueryRow {
    id: String,
    channel_id: String,
    number: i64,
    sender_id: String,
    kind: String,
    body: String,
    meta: Option<String>,
    send_key: Option<String>,
    created_at: i64,
    revision: i64,
    reply_number: Option<i64>,
    edited_at: Option<i64>,
    deleted_at: Option<i64>,
    pinned_at: Option<i64>,
    reactions: Option<String>,
    sender_name: String,
    sender_kind: String,
    sender_agent: Option<String>,
    channel_type: String,
    root_number: Option<i64>,
    top_id: String,
    channel_name: String,
}

impl From<PlacedQueryRow> for PlacedRow {
    fn from(r: PlacedQueryRow) -> Self {
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

#[derive(FromQueryResult)]
struct UnreadQueryRow {
    channel_type: String,
    root_number: Option<i64>,
    channel_name: String,
    unread: i64,
    mentions_you: i64,
    latest_sender_name: Option<String>,
}

impl From<UnreadQueryRow> for UnreadRow {
    fn from(r: UnreadQueryRow) -> Self {
        Self {
            r#type: r.channel_type,
            root_number: r.root_number,
            channel_name: r.channel_name,
            unread: r.unread,
            mentions_you: r.mentions_you != 0,
            latest_sender_name: r.latest_sender_name,
        }
    }
}

#[derive(FromQueryResult)]
struct NotificationReceiptRow {
    updated_at: Option<i64>,
    superseded: i64,
}

#[derive(FromQueryResult)]
struct ReadReportRow {
    sender_id: String,
    created_at: i64,
    updated_at: i64,
}

fn select_msg_detail() -> SelectStatement {
    Query::select()
        .expr_as(Expr::col((channel_message::Entity, channel_message::Column::Id)), "id")
        .expr_as(Expr::col((channel_message::Entity, channel_message::Column::ChannelId)), "channel_id")
        .expr_as(Expr::col((channel_message::Entity, channel_message::Column::Number)), "number")
        .expr_as(Expr::col((channel_message::Entity, channel_message::Column::SenderId)), "sender_id")
        .expr_as(Expr::col((channel_message::Entity, channel_message::Column::Kind)), "kind")
        .expr_as(Expr::col((channel_message::Entity, channel_message::Column::Body)), "body")
        .expr_as(Expr::col((channel_message::Entity, channel_message::Column::Meta)), "meta")
        .expr_as(Expr::col((channel_message::Entity, channel_message::Column::SendKey)), "send_key")
        .expr_as(Expr::col((channel_message::Entity, channel_message::Column::CreatedAt)), "created_at")
        .expr_as(Expr::col((channel_message::Entity, channel_message::Column::Revision)), "revision")
        .expr_as(Expr::col((channel_message::Entity, channel_message::Column::ReplyNumber)), "reply_number")
        .expr_as(Expr::col((channel_message::Entity, channel_message::Column::EditedAt)), "edited_at")
        .expr_as(Expr::col((channel_message::Entity, channel_message::Column::DeletedAt)), "deleted_at")
        .expr_as(Expr::col((channel_message::Entity, channel_message::Column::PinnedAt)), "pinned_at")
        .expr_as(Expr::col((channel_message::Entity, channel_message::Column::Reactions)), "reactions")
        .expr_as(Expr::col((channel_participant::Entity, channel_participant::Column::Name)), "sender_name")
        .expr_as(Expr::col((channel_participant::Entity, channel_participant::Column::Kind)), "sender_kind")
        .expr_as(Expr::col((channel_participant::Entity, channel_participant::Column::AgentId)), "sender_agent")
        .from(channel_message::Entity)
        .inner_join(
            channel_participant::Entity,
            Expr::col((channel_participant::Entity, channel_participant::Column::Id)).equals((channel_message::Entity, channel_message::Column::SenderId)),
        )
        .to_owned()
}

fn select_placed_msg(c: &Alias, ch: &Alias) -> SelectStatement {
    let mut stmt = select_msg_detail();
    stmt.expr_as(Expr::col((c.clone(), channel::Column::ChannelType)), "channel_type")
        .expr_as(Expr::col((c.clone(), channel::Column::RootNumber)), "root_number")
        .expr_as(
            Func::coalesce([Expr::col((c.clone(), channel::Column::ParentId)), Expr::col((c.clone(), channel::Column::Id))]),
            "top_id",
        )
        .expr_as(
            Func::coalesce([
                Expr::col((ch.clone(), channel::Column::Name)),
                Expr::col((c.clone(), channel::Column::Name)),
                Expr::val(""),
            ]),
            "channel_name",
        )
        .join_as(
            JoinType::InnerJoin,
            channel::Entity,
            c.clone(),
            Expr::col((c.clone(), channel::Column::Id)).equals((channel_message::Entity, channel_message::Column::ChannelId)),
        )
        .join_as(
            JoinType::LeftJoin,
            channel::Entity,
            ch.clone(),
            Expr::col((ch.clone(), channel::Column::Id)).equals((c.clone(), channel::Column::ParentId)),
        );
    stmt
}

fn escape_like(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

fn limit_u64(n: i64) -> u64 {
    u64::try_from(n).unwrap_or(0)
}

async fn default_id_impl<C: ConnectionTrait>(conn: &C) -> DbResult<Option<String>> {
    Ok(channel::Entity::find()
        .filter(channel::Column::IsDefault.eq(true))
        .one(conn)
        .await?
        .map(|r| r.id))
}

async fn create_channel_impl<C: ConnectionTrait>(
    conn: &C,
    id: &str,
    is_default: bool,
    name: &str,
    description: Option<&str>,
    repo: Option<&str>,
    at: i64,
) -> DbResult<()> {
    channel::ActiveModel {
        id: Set(id.to_owned()),
        channel_type: Set("channel".to_owned()),
        is_default: Set(is_default),
        root_id: Set(None),
        root_number: Set(None),
        subject_kind: Set(None),
        subject_id: Set(None),
        last_number: Set(None),
        reply_count: Set(0),
        created_at: Set(at),
        name: Set(Some(name.to_owned())),
        description: Set(description.map(str::to_owned)),
        repo: Set(repo.map(str::to_owned)),
        parent_id: Set(None),
        peer_id: Set(None),
        revision: Set(0),
        category: Set(None),
        position: Set(None),
        archived_at: Set(None),
        notify: Set("all".to_owned()),
    }
    .insert(conn)
    .await?;
    Ok(())
}

async fn create_direct_impl<C: ConnectionTrait>(conn: &C, id: &str, peer: &str, at: i64) -> DbResult<()> {
    let model = channel::ActiveModel {
        id: Set(id.to_owned()),
        channel_type: Set("direct".to_owned()),
        is_default: Set(false),
        root_id: Set(None),
        root_number: Set(None),
        subject_kind: Set(None),
        subject_id: Set(None),
        last_number: Set(None),
        reply_count: Set(0),
        created_at: Set(at),
        name: Set(None),
        description: Set(None),
        repo: Set(None),
        parent_id: Set(None),
        peer_id: Set(Some(peer.to_owned())),
        revision: Set(0),
        category: Set(None),
        position: Set(None),
        archived_at: Set(None),
        notify: Set("all".to_owned()),
    };
    channel::Entity::insert(model)
        .on_conflict(OnConflict::column(channel::Column::PeerId).do_nothing().to_owned())
        .exec_without_returning(conn)
        .await?;
    Ok(())
}

async fn clear_default_impl<C: ConnectionTrait>(conn: &C) -> DbResult<()> {
    Update::many(channel::Entity)
        .col_expr(channel::Column::IsDefault, Expr::value(false))
        .filter(channel::Column::IsDefault.eq(true))
        .exec(conn)
        .await?;
    Ok(())
}

async fn make_default_impl<C: ConnectionTrait>(conn: &C, id: &str) -> DbResult<()> {
    Update::many(channel::Entity)
        .col_expr(channel::Column::IsDefault, Expr::value(true))
        .filter(channel::Column::Id.eq(id))
        .filter(channel::Column::ChannelType.eq("channel"))
        .exec(conn)
        .await?;
    Ok(())
}

async fn update_channel_impl<C: ConnectionTrait>(conn: &C, id: &str, description: Option<&str>, repo: Option<&str>) -> DbResult<()> {
    Update::many(channel::Entity)
        .col_expr(channel::Column::Description, Expr::value(description.map(str::to_owned)))
        .col_expr(channel::Column::Repo, Expr::value(repo.map(str::to_owned)))
        .filter(channel::Column::Id.eq(id))
        .filter(channel::Column::ChannelType.eq("channel"))
        .exec(conn)
        .await?;
    Ok(())
}

async fn create_thread_impl<C: ConnectionTrait>(conn: &C, thread: &NewThread<'_>) -> DbResult<()> {
    channel::ActiveModel {
        id: Set(thread.id.to_owned()),
        channel_type: Set("thread".to_owned()),
        is_default: Set(false),
        root_id: Set(Some(thread.root_id.to_owned())),
        root_number: Set(Some(thread.root_number)),
        subject_kind: Set(Some(thread.subject_kind.to_owned())),
        subject_id: Set(thread.subject_id.map(str::to_owned)),
        last_number: Set(None),
        reply_count: Set(0),
        created_at: Set(thread.at),
        name: Set(None),
        description: Set(None),
        repo: Set(None),
        parent_id: Set(Some(thread.parent_id.to_owned())),
        peer_id: Set(None),
        revision: Set(0),
        category: Set(None),
        position: Set(None),
        archived_at: Set(None),
        notify: Set("all".to_owned()),
    }
    .insert(conn)
    .await?;
    Ok(())
}

async fn all_channels_impl<C: ConnectionTrait>(conn: &C) -> DbResult<Vec<ChannelRow>> {
    Ok(channel::Entity::find()
        .order_by_asc(channel::Column::Id)
        .all(conn)
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}

async fn recent_channels_impl<C: ConnectionTrait>(conn: &C, n: i64) -> DbResult<Vec<ChannelRow>> {
    let last_or_zero = Func::coalesce([Expr::col(channel::Column::LastNumber), Expr::val(0i64)]);
    Ok(channel::Entity::find()
        .order_by(last_or_zero, Order::Desc)
        .order_by_desc(channel::Column::Id)
        .limit(limit_u64(n))
        .all(conn)
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}

async fn touch_channel_impl<C: ConnectionTrait>(conn: &C, id: &str, number: i64) -> DbResult<()> {
    let current = Func::coalesce([Expr::col(channel::Column::LastNumber), Expr::val(0i64)]);
    let next_last = Expr::case(Expr::expr(current.clone()).gte(number), current).finally(number);
    let reply_inc = Expr::case(Expr::col(channel::Column::ChannelType).eq("thread"), 1i64).finally(0i64);
    Update::many(channel::Entity)
        .col_expr(channel::Column::LastNumber, Expr::expr(next_last))
        .col_expr(channel::Column::ReplyCount, Expr::col(channel::Column::ReplyCount).add(reply_inc))
        .filter(channel::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

async fn unread_of_impl<C: ConnectionTrait>(conn: &C, participant: &str, channel_id: &str) -> DbResult<Vec<UnreadRow>> {
    let c = Alias::new("c");
    let ch = Alias::new("ch");
    let m = Alias::new("m");
    let rc = Alias::new("rc");
    let f = Alias::new("f");
    let x = Alias::new("x");
    let s = Alias::new("s");
    let u = Alias::new("u");
    let lm = Alias::new("lm");
    let p = Alias::new("p");

    let mention_exists = Query::select()
        .expr(Expr::val(1i64))
        .from_as(channel_mention::Entity, x.clone())
        .and_where(Expr::col((x.clone(), channel_mention::Column::MessageId)).equals((m.clone(), channel_message::Column::Id)))
        .and_where(Expr::col((x, channel_mention::Column::TargetId)).eq(participant))
        .to_owned();

    let seen_exists = Query::select()
        .expr(Expr::val(1i64))
        .from_as(channel_seen::Entity, s.clone())
        .and_where(Expr::col((s.clone(), channel_seen::Column::ParticipantId)).eq(participant))
        .and_where(Expr::col((s, channel_seen::Column::MessageId)).equals((m.clone(), channel_message::Column::Id)))
        .to_owned();

    let rc_num = Func::coalesce([Expr::col((rc.clone(), channel_read_cursor::Column::ReadNumber)), Expr::val(0i64)]);
    let f_num = Func::coalesce([Expr::col((f.clone(), channel_member::Column::FromNumber)), Expr::val(0i64)]);
    let floor_expr = Expr::case(Expr::expr(rc_num.clone()).gte(f_num.clone()), rc_num).finally(f_num);

    let mention_flag = Expr::case(Expr::exists(mention_exists), 1i64).finally(0i64);

    let unread_subquery = Query::select()
        .expr_as(Expr::col((c.clone(), channel::Column::Id)), "id")
        .expr_as(Expr::col((c.clone(), channel::Column::ChannelType)), "channel_type")
        .expr_as(Expr::col((c.clone(), channel::Column::RootNumber)), "root_number")
        .expr_as(
            Func::coalesce([
                Expr::col((ch.clone(), channel::Column::Name)),
                Expr::col((c.clone(), channel::Column::Name)),
                Expr::val(""),
            ]),
            "channel_name",
        )
        .expr_as(Expr::col((m.clone(), channel_message::Column::Id)).count(), "unread")
        .expr_as(Func::coalesce([mention_flag.max(), Expr::val(0i64)]), "mentions_you")
        .expr_as(
            Func::coalesce([Expr::col((m.clone(), channel_message::Column::Number)).max(), Expr::val(0i64)]),
            "latest",
        )
        .from_as(channel::Entity, c.clone())
        .join_as(
            JoinType::LeftJoin,
            channel::Entity,
            ch.clone(),
            Expr::col((ch.clone(), channel::Column::Id)).equals((c.clone(), channel::Column::ParentId)),
        )
        .join_as(
            JoinType::InnerJoin,
            channel_message::Entity,
            m.clone(),
            Expr::col((m.clone(), channel_message::Column::ChannelId)).equals((c.clone(), channel::Column::Id)),
        )
        .join_as(
            JoinType::LeftJoin,
            channel_read_cursor::Entity,
            rc.clone(),
            Condition::all()
                .add(Expr::col((rc.clone(), channel_read_cursor::Column::ParticipantId)).eq(participant))
                .add(Expr::col((rc.clone(), channel_read_cursor::Column::ChannelId)).equals((c.clone(), channel::Column::Id))),
        )
        .join_as(
            JoinType::LeftJoin,
            channel_member::Entity,
            f.clone(),
            Condition::all()
                .add(Expr::col((f.clone(), channel_member::Column::ChannelId)).equals((c.clone(), channel::Column::Id)))
                .add(Expr::col((f.clone(), channel_member::Column::ParticipantId)).eq(participant))
                .add(Expr::col((f.clone(), channel_member::Column::LeftAt)).is_null()),
        )
        .and_where(Expr::col((m.clone(), channel_message::Column::SenderId)).ne(participant))
        .and_where(Expr::col((m.clone(), channel_message::Column::Kind)).ne("notice"))
        .cond_where(
            Condition::any()
                .add(Expr::col((c.clone(), channel::Column::Id)).eq(channel_id))
                .add(Expr::col((f.clone(), channel_member::Column::ParticipantId)).is_not_null()),
        )
        .and_where(Expr::col((m.clone(), channel_message::Column::Number)).gt(floor_expr))
        .and_where(Expr::exists(seen_exists).not())
        .group_by_columns([
            (c.clone(), channel::Column::Id),
            (c.clone(), channel::Column::ChannelType),
            (c.clone(), channel::Column::RootNumber),
            (c.clone(), channel::Column::Name),
            (ch.clone(), channel::Column::Name),
        ])
        .to_owned();

    let stmt = Query::select()
        .expr_as(Expr::col((u.clone(), Alias::new("channel_type"))), "channel_type")
        .expr_as(Expr::col((u.clone(), Alias::new("root_number"))), "root_number")
        .expr_as(Expr::col((u.clone(), Alias::new("channel_name"))), "channel_name")
        .expr_as(Expr::col((u.clone(), Alias::new("unread"))), "unread")
        .expr_as(Expr::col((u.clone(), Alias::new("mentions_you"))), "mentions_you")
        .expr_as(Expr::col((p.clone(), channel_participant::Column::Name)), "latest_sender_name")
        .from_subquery(unread_subquery, u.clone())
        .join_as(
            JoinType::LeftJoin,
            channel_message::Entity,
            lm.clone(),
            Condition::all()
                .add(Expr::col((lm.clone(), channel_message::Column::ChannelId)).equals((u.clone(), Alias::new("id"))))
                .add(Expr::col((lm.clone(), channel_message::Column::Number)).equals((u.clone(), Alias::new("latest")))),
        )
        .join_as(
            JoinType::LeftJoin,
            channel_participant::Entity,
            p.clone(),
            Expr::col((p.clone(), channel_participant::Column::Id)).equals((lm.clone(), channel_message::Column::SenderId)),
        )
        .order_by((u, Alias::new("latest")), Order::Desc)
        .limit(20)
        .to_owned();

    let rows = UnreadQueryRow::find_by_statement(conn.get_database_backend().build(&stmt)).all(conn).await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

async fn bump_revision_impl<C: ConnectionTrait>(conn: &C, id: &str) -> DbResult<i64> {
    let rows = Update::many(channel::Entity)
        .col_expr(channel::Column::Revision, Expr::col(channel::Column::Revision).add(1))
        .filter(channel::Column::Id.eq(id))
        .exec_with_returning(conn)
        .await?;
    rows.into_iter()
        .next()
        .map(|r| r.revision)
        .ok_or_else(|| DbError::not_found(format!("channel {id} not found")))
}

async fn rename_channel_impl<C: ConnectionTrait>(conn: &C, id: &str, name: Option<&str>) -> DbResult<()> {
    Update::many(channel::Entity)
        .col_expr(channel::Column::Name, Expr::value(name.map(str::to_owned)))
        .filter(channel::Column::Id.eq(id))
        .filter(channel::Column::ChannelType.ne("direct"))
        .exec(conn)
        .await?;
    Ok(())
}

async fn set_category_impl<C: ConnectionTrait>(conn: &C, id: &str, category: Option<&str>) -> DbResult<()> {
    Update::many(channel::Entity)
        .col_expr(channel::Column::Category, Expr::value(category.map(str::to_owned)))
        .filter(channel::Column::Id.eq(id))
        .filter(channel::Column::ChannelType.eq("channel"))
        .exec(conn)
        .await?;
    Ok(())
}

async fn place_channel_impl<C: ConnectionTrait>(conn: &C, id: &str, position: i64) -> DbResult<()> {
    Update::many(channel::Entity)
        .col_expr(channel::Column::Position, Expr::value(Some(position)))
        .filter(channel::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

async fn set_archived_impl<C: ConnectionTrait>(conn: &C, id: &str, at: Option<i64>) -> DbResult<()> {
    Update::many(channel::Entity)
        .col_expr(channel::Column::ArchivedAt, Expr::value(at))
        .filter(channel::Column::Id.eq(id))
        .filter(channel::Column::IsDefault.eq(false))
        .exec(conn)
        .await?;
    Ok(())
}

async fn set_notify_impl<C: ConnectionTrait>(conn: &C, id: &str, notify: &str) -> DbResult<()> {
    Update::many(channel::Entity)
        .col_expr(channel::Column::Notify, Expr::value(notify.to_owned()))
        .filter(channel::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

async fn topic_threads_in_impl<C: ConnectionTrait>(conn: &C, id: &str) -> DbResult<i64> {
    let count = channel::Entity::find()
        .filter(channel::Column::ParentId.eq(id))
        .filter(channel::Column::SubjectKind.eq("issue"))
        .count(conn)
        .await?;
    Ok(count as i64)
}

async fn upsert_participant_impl<C: ConnectionTrait>(conn: &C, p: &ParticipantRow) -> DbResult<()> {
    let model = channel_participant::ActiveModel {
        id: Set(p.id.clone()),
        kind: Set(p.kind.clone()),
        name: Set(p.name.clone()),
        agent_id: Set(p.agent_id.clone()),
        home_id: Set(p.home_id.clone()),
        joined_at: Set(p.joined_at),
        left_at: Set(None),
    };
    let on_conflict = OnConflict::column(channel_participant::Column::Id)
        .update_columns([channel_participant::Column::Name, channel_participant::Column::AgentId])
        .value(
            channel_participant::Column::HomeId,
            Func::coalesce([
                Expr::col((Alias::new("excluded"), channel_participant::Column::HomeId)),
                Expr::col((channel_participant::Entity, channel_participant::Column::HomeId)),
            ]),
        )
        .value(channel_participant::Column::LeftAt, Expr::val(Option::<i64>::None))
        .to_owned();
    channel_participant::Entity::insert(model)
        .on_conflict(on_conflict)
        .exec_without_returning(conn)
        .await?;
    Ok(())
}

async fn add_participant_impl<C: ConnectionTrait>(conn: &C, id: &str, kind: &str, name: &str, at: i64) -> DbResult<()> {
    let model = channel_participant::ActiveModel {
        id: Set(id.to_owned()),
        kind: Set(kind.to_owned()),
        name: Set(name.to_owned()),
        agent_id: Set(None),
        home_id: Set(None),
        joined_at: Set(at),
        left_at: Set(None),
    };
    channel_participant::Entity::insert(model)
        .on_conflict(OnConflict::column(channel_participant::Column::Id).do_nothing().to_owned())
        .exec_without_returning(conn)
        .await?;
    Ok(())
}

async fn participant_left_impl<C: ConnectionTrait>(conn: &C, id: &str, at: i64) -> DbResult<()> {
    Update::many(channel_participant::Entity)
        .col_expr(channel_participant::Column::LeftAt, Expr::value(Some(at)))
        .filter(channel_participant::Column::Id.eq(id))
        .filter(channel_participant::Column::LeftAt.is_null())
        .exec(conn)
        .await?;
    Ok(())
}

async fn participants_impl<C: ConnectionTrait>(conn: &C) -> DbResult<Vec<ParticipantRow>> {
    Ok(channel_participant::Entity::find()
        .order_by_asc(channel_participant::Column::JoinedAt)
        .order_by_asc(channel_participant::Column::Id)
        .all(conn)
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}

async fn add_member_impl<C: ConnectionTrait>(conn: &C, channel_id: &str, participant: &str, reason: &str, from: i64) -> DbResult<()> {
    let model = channel_member::ActiveModel {
        channel_id: Set(channel_id.to_owned()),
        participant_id: Set(participant.to_owned()),
        reason: Set(reason.to_owned()),
        from_number: Set(from),
        left_at: Set(None),
    };
    let on_conflict = OnConflict::columns([channel_member::Column::ChannelId, channel_member::Column::ParticipantId])
        .value(channel_member::Column::LeftAt, Expr::val(Option::<i64>::None))
        .to_owned();
    channel_member::Entity::insert(model)
        .on_conflict(on_conflict)
        .exec_without_returning(conn)
        .await?;
    Ok(())
}

async fn remove_member_impl<C: ConnectionTrait>(conn: &C, channel_id: &str, participant: &str, at: i64) -> DbResult<()> {
    Update::many(channel_member::Entity)
        .col_expr(channel_member::Column::LeftAt, Expr::value(Some(at)))
        .filter(channel_member::Column::ChannelId.eq(channel_id))
        .filter(channel_member::Column::ParticipantId.eq(participant))
        .filter(channel_member::Column::LeftAt.is_null())
        .exec(conn)
        .await?;
    Ok(())
}

async fn all_members_impl<C: ConnectionTrait>(conn: &C) -> DbResult<Vec<(String, String)>> {
    Ok(channel_member::Entity::find()
        .filter(channel_member::Column::LeftAt.is_null())
        .all(conn)
        .await?
        .into_iter()
        .map(|r| (r.channel_id, r.participant_id))
        .collect())
}

async fn remove_from_all_impl<C: ConnectionTrait>(conn: &C, participant: &str, at: i64) -> DbResult<()> {
    Update::many(channel_member::Entity)
        .col_expr(channel_member::Column::LeftAt, Expr::value(Some(at)))
        .filter(channel_member::Column::ParticipantId.eq(participant))
        .filter(channel_member::Column::LeftAt.is_null())
        .exec(conn)
        .await?;
    Ok(())
}

async fn insert_mention_impl<C: ConnectionTrait>(conn: &C, message: &str, target: &str, resolved: &str) -> DbResult<()> {
    let model = channel_mention::ActiveModel {
        message_id: Set(message.to_owned()),
        target_id: Set(target.to_owned()),
        resolved: Set(resolved.to_owned()),
    };
    channel_mention::Entity::insert(model)
        .on_conflict(
            OnConflict::columns([channel_mention::Column::MessageId, channel_mention::Column::TargetId])
                .do_nothing()
                .to_owned(),
        )
        .exec_without_returning(conn)
        .await?;
    Ok(())
}

async fn delete_mentions_for_message_impl<C: ConnectionTrait>(conn: &C, message: &str) -> DbResult<()> {
    channel_mention::Entity::delete_many()
        .filter(channel_mention::Column::MessageId.eq(message))
        .exec(conn)
        .await?;
    Ok(())
}

async fn mark_seen_impl<C: ConnectionTrait>(conn: &C, participant: &str, message: &str, at: i64) -> DbResult<()> {
    let select_stmt = Query::select()
        .expr(Expr::col((channel_participant::Entity, channel_participant::Column::Id)))
        .expr(Expr::col((channel_message::Entity, channel_message::Column::Id)))
        .expr(Expr::val(at))
        .from(channel_message::Entity)
        .from(channel_participant::Entity)
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::Id)).eq(message))
        .and_where(Expr::col((channel_participant::Entity, channel_participant::Column::Id)).eq(participant))
        .to_owned();
    let stmt = Query::insert()
        .into_table(channel_seen::Entity)
        .columns([
            channel_seen::Column::ParticipantId,
            channel_seen::Column::MessageId,
            channel_seen::Column::SeenAt,
        ])
        .select_from(select_stmt)
        .map_err(|e| DbError::custom(e.to_string()))?
        .on_conflict(
            OnConflict::columns([channel_seen::Column::ParticipantId, channel_seen::Column::MessageId])
                .do_nothing()
                .to_owned(),
        )
        .to_owned();
    conn.execute(&stmt).await?;
    Ok(())
}

async fn set_read_cursor_impl<C: ConnectionTrait>(conn: &C, participant: &str, channel_id: &str, upto: i64, at: i64) -> DbResult<()> {
    let model = channel_read_cursor::ActiveModel {
        participant_id: Set(participant.to_owned()),
        channel_id: Set(channel_id.to_owned()),
        read_number: Set(upto),
        updated_at: Set(at),
    };
    let existing = Expr::col((channel_read_cursor::Entity, channel_read_cursor::Column::ReadNumber));
    let incoming = Expr::col((Alias::new("excluded"), channel_read_cursor::Column::ReadNumber));
    let next_num = Expr::case(existing.clone().gte(incoming.clone()), existing).finally(incoming);
    let on_conflict = OnConflict::columns([channel_read_cursor::Column::ParticipantId, channel_read_cursor::Column::ChannelId])
        .value(channel_read_cursor::Column::ReadNumber, Expr::expr(next_num))
        .update_column(channel_read_cursor::Column::UpdatedAt)
        .to_owned();
    channel_read_cursor::Entity::insert(model)
        .on_conflict(on_conflict)
        .exec_without_returning(conn)
        .await?;
    Ok(())
}

async fn read_cursor_impl<C: ConnectionTrait>(conn: &C, participant: &str, channel_id: &str) -> DbResult<Option<i64>> {
    Ok(channel_read_cursor::Entity::find_by_id((participant.to_owned(), channel_id.to_owned()))
        .one(conn)
        .await?
        .map(|r| r.read_number))
}

async fn read_cursors_of_impl<C: ConnectionTrait>(conn: &C, participant: &str) -> DbResult<Vec<(String, i64)>> {
    Ok(channel_read_cursor::Entity::find()
        .filter(channel_read_cursor::Column::ParticipantId.eq(participant))
        .all(conn)
        .await?
        .into_iter()
        .map(|r| (r.channel_id, r.read_number))
        .collect())
}

async fn mark_unread_impl<C: ConnectionTrait>(conn: &C, channel_id: &str, upto: i64, at: i64) -> DbResult<()> {
    let model = channel_read_cursor::ActiveModel {
        participant_id: Set("user".to_owned()),
        channel_id: Set(channel_id.to_owned()),
        read_number: Set(upto),
        updated_at: Set(at),
    };
    let on_conflict = OnConflict::columns([channel_read_cursor::Column::ParticipantId, channel_read_cursor::Column::ChannelId])
        .update_columns([channel_read_cursor::Column::ReadNumber, channel_read_cursor::Column::UpdatedAt])
        .to_owned();
    channel_read_cursor::Entity::insert(model)
        .on_conflict(on_conflict)
        .exec_without_returning(conn)
        .await?;
    Ok(())
}

async fn insert_event_impl<C: ConnectionTrait>(conn: &C, kind: &str, channel_id: &str, message: &str, at: i64) -> DbResult<i64> {
    let saved = channel_event::ActiveModel {
        kind: Set(kind.to_owned()),
        channel_id: Set(channel_id.to_owned()),
        message_id: Set(message.to_owned()),
        at: Set(at),
        ..Default::default()
    }
    .insert(conn)
    .await?;
    Ok(saved.seq)
}

async fn events_after_impl<C: ConnectionTrait>(conn: &C, after: i64, n: i64) -> DbResult<Vec<EventRow>> {
    Ok(channel_event::Entity::find()
        .filter(channel_event::Column::Seq.gt(after))
        .order_by_asc(channel_event::Column::Seq)
        .limit(limit_u64(n))
        .all(conn)
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}

async fn event_of_impl<C: ConnectionTrait>(conn: &C, message: &str) -> DbResult<Option<EventRow>> {
    Ok(channel_event::Entity::find()
        .filter(channel_event::Column::MessageId.eq(message))
        .filter(channel_event::Column::Kind.eq("posted"))
        .one(conn)
        .await?
        .map(Into::into))
}

async fn insert_message_impl<C: ConnectionTrait>(conn: &C, msg: &NewMessage<'_>) -> DbResult<i64> {
    let next_num_subquery = Query::select()
        .expr(Expr::expr(Func::coalesce([Expr::col(channel_message::Column::Number).max(), Expr::val(0i64)])).add(1))
        .from(channel_message::Entity)
        .and_where(channel_message::Column::ChannelId.eq(msg.channel_id))
        .to_owned();

    let stmt = Query::insert()
        .into_table(channel_message::Entity)
        .columns([
            channel_message::Column::Id,
            channel_message::Column::ChannelId,
            channel_message::Column::Number,
            channel_message::Column::SenderId,
            channel_message::Column::Kind,
            channel_message::Column::Body,
            channel_message::Column::Meta,
            channel_message::Column::SystemCode,
            channel_message::Column::SendKey,
            channel_message::Column::CreatedAt,
            channel_message::Column::Revision,
            channel_message::Column::ReplyNumber,
        ])
        .values_panic([
            Expr::val(msg.id.to_owned()),
            Expr::val(msg.channel_id.to_owned()),
            Expr::from(SubQueryStatement::SelectStatement(next_num_subquery)),
            Expr::val(msg.sender.to_owned()),
            Expr::val(msg.kind.to_owned()),
            Expr::val(msg.body.to_owned()),
            Expr::val(msg.meta.map(str::to_owned)),
            Expr::val(msg.system_code.map(str::to_owned)),
            Expr::val(msg.send_key.map(str::to_owned)),
            Expr::val(msg.at),
            Expr::val(msg.revision),
            Expr::val(msg.reply_number),
        ])
        .returning_col(channel_message::Column::Number)
        .to_owned();

    let row = conn.query_one(&stmt).await?.ok_or_else(|| DbError::custom("insert_message returned no row"))?;
    Ok(row.try_get("", "number")?)
}

async fn update_message_meta_impl<C: ConnectionTrait>(conn: &C, id: &str, meta: Option<&str>) -> DbResult<()> {
    Update::many(channel_message::Entity)
        .col_expr(channel_message::Column::Meta, Expr::value(meta.map(str::to_owned)))
        .filter(channel_message::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

async fn message_by_id_impl<C: ConnectionTrait>(conn: &C, id: &str) -> DbResult<Option<MsgRow>> {
    let mut stmt = select_msg_detail();
    stmt.and_where(Expr::col((channel_message::Entity, channel_message::Column::Id)).eq(id));
    Ok(MsgQueryRow::find_by_statement(conn.get_database_backend().build(&stmt))
        .one(conn)
        .await?
        .map(Into::into))
}

async fn message_by_send_key_impl<C: ConnectionTrait>(conn: &C, sender: &str, key: &str) -> DbResult<Option<MsgRow>> {
    let mut stmt = select_msg_detail();
    stmt.and_where(Expr::col((channel_message::Entity, channel_message::Column::SenderId)).eq(sender))
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::SendKey)).eq(key));
    Ok(MsgQueryRow::find_by_statement(conn.get_database_backend().build(&stmt))
        .one(conn)
        .await?
        .map(Into::into))
}

async fn message_by_number_impl<C: ConnectionTrait>(conn: &C, channel_id: &str, number: i64) -> DbResult<Option<MsgRow>> {
    let mut stmt = select_msg_detail();
    stmt.and_where(Expr::col((channel_message::Entity, channel_message::Column::ChannelId)).eq(channel_id))
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::Number)).eq(number));
    Ok(MsgQueryRow::find_by_statement(conn.get_database_backend().build(&stmt))
        .one(conn)
        .await?
        .map(Into::into))
}

async fn user_mentions_impl<C: ConnectionTrait>(conn: &C) -> DbResult<Vec<PlacedRow>> {
    let c = Alias::new("c");
    let ch = Alias::new("ch");
    let reply = Alias::new("reply");

    let reply_exists = Query::select()
        .expr(Expr::val(1i64))
        .from_as(channel_message::Entity, reply.clone())
        .and_where(Expr::col((reply.clone(), channel_message::Column::ChannelId)).equals((channel_message::Entity, channel_message::Column::ChannelId)))
        .and_where(Expr::col((reply.clone(), channel_message::Column::SenderId)).eq("user"))
        .and_where(Expr::col((reply.clone(), channel_message::Column::DeletedAt)).is_null())
        .and_where(Expr::col((reply, channel_message::Column::Number)).gt(Expr::col((channel_message::Entity, channel_message::Column::Number))))
        .to_owned();

    let mut stmt = select_placed_msg(&c, &ch);
    stmt.inner_join(
        channel_mention::Entity,
        Expr::col((channel_mention::Entity, channel_mention::Column::MessageId)).equals((channel_message::Entity, channel_message::Column::Id)),
    )
    .left_join(
        channel_read_cursor::Entity,
        Condition::all()
            .add(
                Expr::col((channel_read_cursor::Entity, channel_read_cursor::Column::ChannelId))
                    .equals((channel_message::Entity, channel_message::Column::ChannelId)),
            )
            .add(Expr::col((channel_read_cursor::Entity, channel_read_cursor::Column::ParticipantId)).eq("user")),
    )
    .and_where(Expr::col((channel_mention::Entity, channel_mention::Column::TargetId)).eq("user"))
    .and_where(Expr::col((channel_message::Entity, channel_message::Column::SenderId)).ne("user"))
    .and_where(Expr::col((channel_message::Entity, channel_message::Column::DeletedAt)).is_null())
    .and_where(Expr::col((channel_message::Entity, channel_message::Column::Number)).gt(Func::coalesce([
        Expr::col((channel_read_cursor::Entity, channel_read_cursor::Column::ReadNumber)),
        Expr::val(0i64),
    ])))
    .and_where(Expr::exists(reply_exists).not())
    .order_by((channel_message::Entity, channel_message::Column::Id), Order::Asc);

    let rows = PlacedQueryRow::find_by_statement(conn.get_database_backend().build(&stmt)).all(conn).await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

async fn messages_before_impl<C: ConnectionTrait>(conn: &C, channel_id: &str, number: i64, n: i64) -> DbResult<Vec<MsgRow>> {
    let mut stmt = select_msg_detail();
    stmt.and_where(Expr::col((channel_message::Entity, channel_message::Column::ChannelId)).eq(channel_id))
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::Number)).lt(number))
        .order_by((channel_message::Entity, channel_message::Column::Number), Order::Desc)
        .limit(limit_u64(n));
    Ok(MsgQueryRow::find_by_statement(conn.get_database_backend().build(&stmt))
        .all(conn)
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}

async fn messages_after_impl<C: ConnectionTrait>(conn: &C, channel_id: &str, number: i64, n: i64) -> DbResult<Vec<MsgRow>> {
    let mut stmt = select_msg_detail();
    stmt.and_where(Expr::col((channel_message::Entity, channel_message::Column::ChannelId)).eq(channel_id))
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::Number)).gt(number))
        .order_by((channel_message::Entity, channel_message::Column::Number), Order::Asc)
        .limit(limit_u64(n));
    Ok(MsgQueryRow::find_by_statement(conn.get_database_backend().build(&stmt))
        .all(conn)
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}

async fn recent_reports_impl<C: ConnectionTrait>(conn: &C, n: i64) -> DbResult<Vec<MsgRow>> {
    let mut stmt = select_msg_detail();
    stmt.and_where(Expr::col((channel_message::Entity, channel_message::Column::Kind)).eq("report"))
        .order_by((channel_message::Entity, channel_message::Column::Id), Order::Desc)
        .limit(limit_u64(n));
    Ok(MsgQueryRow::find_by_statement(conn.get_database_backend().build(&stmt))
        .all(conn)
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}

async fn reports_after_impl<C: ConnectionTrait>(conn: &C, after: &str, n: i64) -> DbResult<Vec<MsgRow>> {
    let mut stmt = select_msg_detail();
    stmt.and_where(Expr::col((channel_message::Entity, channel_message::Column::Kind)).eq("report"))
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::Id)).gt(after))
        .order_by((channel_message::Entity, channel_message::Column::Id), Order::Asc)
        .limit(limit_u64(n));
    Ok(MsgQueryRow::find_by_statement(conn.get_database_backend().build(&stmt))
        .all(conn)
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}

async fn recent_duplicate_impl<C: ConnectionTrait>(conn: &C, sender: &str, channel_id: &str, body: &str, since: i64) -> DbResult<Option<String>> {
    Ok(channel_message::Entity::find()
        .filter(channel_message::Column::SenderId.eq(sender))
        .filter(channel_message::Column::ChannelId.eq(channel_id))
        .filter(channel_message::Column::Body.eq(body))
        .filter(channel_message::Column::CreatedAt.gt(since))
        .order_by_desc(channel_message::Column::Id)
        .one(conn)
        .await?
        .map(|r| r.id))
}

async fn dispatches_in_impl<C: ConnectionTrait>(conn: &C, channel_id: &str) -> DbResult<i64> {
    let count = channel_message::Entity::find()
        .filter(channel_message::Column::ChannelId.eq(channel_id))
        .filter(channel_message::Column::Kind.eq("dispatch"))
        .count(conn)
        .await?;
    Ok(count as i64)
}

async fn user_unread_impl<C: ConnectionTrait>(conn: &C, channel_id: &str, read: i64) -> DbResult<i64> {
    let count = channel_message::Entity::find()
        .filter(channel_message::Column::ChannelId.eq(channel_id))
        .filter(channel_message::Column::Number.gt(read))
        .filter(channel_message::Column::SenderId.ne("user"))
        .filter(channel_message::Column::Kind.ne("notice"))
        .filter(channel_message::Column::DeletedAt.is_null())
        .count(conn)
        .await?;
    Ok(count as i64)
}

async fn latest_number_impl<C: ConnectionTrait>(conn: &C, channel_id: &str) -> DbResult<i64> {
    let stmt = Query::select()
        .expr_as(Func::coalesce([Expr::col(channel_message::Column::Number).max(), Expr::val(0i64)]), "number")
        .from(channel_message::Entity)
        .and_where(channel_message::Column::ChannelId.eq(channel_id))
        .to_owned();
    let row = conn.query_one(&stmt).await?.ok_or_else(|| DbError::custom("latest_number returned no row"))?;
    Ok(row.try_get("", "number")?)
}

async fn callers_of_impl<C: ConnectionTrait>(conn: &C, speaker: &str, channel_id: &str, before: &str, n: i64) -> DbResult<Vec<String>> {
    let s = Alias::new("s");
    let last_spoken_subquery = Query::select()
        .expr(Expr::col((s.clone(), channel_message::Column::Id)).max())
        .from_as(channel_message::Entity, s.clone())
        .and_where(Expr::col((s.clone(), channel_message::Column::ChannelId)).eq(channel_id))
        .and_where(Expr::col((s.clone(), channel_message::Column::SenderId)).eq(speaker))
        .and_where(Expr::col((s, channel_message::Column::Id)).lt(before))
        .to_owned();

    let stmt = Query::select()
        .column((channel_message::Entity, channel_message::Column::SenderId))
        .from(channel_message::Entity)
        .inner_join(
            channel_mention::Entity,
            Condition::all()
                .add(Expr::col((channel_mention::Entity, channel_mention::Column::MessageId)).equals((channel_message::Entity, channel_message::Column::Id)))
                .add(Expr::col((channel_mention::Entity, channel_mention::Column::TargetId)).eq(speaker)),
        )
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::ChannelId)).eq(channel_id))
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::SenderId)).ne(speaker))
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::Id)).lt(before))
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::Id)).gt(Func::coalesce([
            Expr::from(SubQueryStatement::SelectStatement(last_spoken_subquery)),
            Expr::val(""),
        ])))
        .order_by((channel_message::Entity, channel_message::Column::Id), Order::Desc)
        .limit(limit_u64(n))
        .to_owned();

    let rows = conn.query_all(&stmt).await?;
    rows.into_iter().map(|r| r.try_get("", "sender_id").map_err(DbError::from)).collect()
}

async fn unseen_in_impl<C: ConnectionTrait>(conn: &C, channel_id: &str, participant: &str) -> DbResult<Vec<String>> {
    let read_subquery = Query::select()
        .column(channel_read_cursor::Column::ReadNumber)
        .from(channel_read_cursor::Entity)
        .and_where(channel_read_cursor::Column::ParticipantId.eq(participant))
        .and_where(channel_read_cursor::Column::ChannelId.eq(channel_id))
        .to_owned();

    let s = Alias::new("s");
    let seen_exists = Query::select()
        .expr(Expr::val(1i64))
        .from_as(channel_seen::Entity, s.clone())
        .and_where(Expr::col((s.clone(), channel_seen::Column::ParticipantId)).eq(participant))
        .and_where(Expr::col((s, channel_seen::Column::MessageId)).equals((channel_message::Entity, channel_message::Column::Id)))
        .to_owned();

    let stmt = Query::select()
        .column((channel_message::Entity, channel_message::Column::Id))
        .from(channel_message::Entity)
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::ChannelId)).eq(channel_id))
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::SenderId)).ne(participant))
        .and_where(
            Expr::col((channel_message::Entity, channel_message::Column::Number))
                .gt(Func::coalesce([Expr::from(SubQueryStatement::SelectStatement(read_subquery)), Expr::val(0i64)])),
        )
        .and_where(Expr::exists(seen_exists).not())
        .order_by((channel_message::Entity, channel_message::Column::Number), Order::Asc)
        .to_owned();

    let rows = conn.query_all(&stmt).await?;
    rows.into_iter().map(|r| r.try_get("", "id").map_err(DbError::from)).collect()
}

async fn notice_since_user_impl<C: ConnectionTrait>(conn: &C, channel_id: &str, code: &str) -> DbResult<i64> {
    let u = Alias::new("u");
    let last_user_subquery = Query::select()
        .expr(Expr::col((u.clone(), channel_message::Column::Id)).max())
        .from_as(channel_message::Entity, u.clone())
        .and_where(Expr::col((u.clone(), channel_message::Column::ChannelId)).eq(channel_id))
        .and_where(Expr::col((u, channel_message::Column::SenderId)).eq("user"))
        .to_owned();

    let stmt = Query::select()
        .expr_as(Expr::col((channel_message::Entity, channel_message::Column::Id)).count(), "total")
        .from(channel_message::Entity)
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::ChannelId)).eq(channel_id))
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::SenderId)).eq("system"))
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::SystemCode)).eq(code))
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::Id)).gt(Func::coalesce([
            Expr::from(SubQueryStatement::SelectStatement(last_user_subquery)),
            Expr::val(""),
        ])))
        .to_owned();

    let row = conn
        .query_one(&stmt)
        .await?
        .ok_or_else(|| DbError::custom("notice_since_user returned no row"))?;
    Ok(row.try_get("", "total")?)
}

async fn messages_changed_after_impl<C: ConnectionTrait>(conn: &C, channel_id: &str, revision: i64, n: i64) -> DbResult<Vec<MsgRow>> {
    let mut stmt = select_msg_detail();
    stmt.and_where(Expr::col((channel_message::Entity, channel_message::Column::ChannelId)).eq(channel_id))
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::Revision)).gt(revision))
        .order_by((channel_message::Entity, channel_message::Column::Revision), Order::Asc)
        .limit(limit_u64(n));
    Ok(MsgQueryRow::find_by_statement(conn.get_database_backend().build(&stmt))
        .all(conn)
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}

async fn edit_message_impl<C: ConnectionTrait>(conn: &C, id: &str, body: &str, at: i64, revision: i64) -> DbResult<()> {
    Update::many(channel_message::Entity)
        .col_expr(channel_message::Column::Body, Expr::value(body.to_owned()))
        .col_expr(channel_message::Column::EditedAt, Expr::value(Some(at)))
        .col_expr(channel_message::Column::Revision, Expr::value(revision))
        .filter(channel_message::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

async fn delete_message_impl<C: ConnectionTrait>(conn: &C, id: &str, at: i64, revision: i64) -> DbResult<()> {
    Update::many(channel_message::Entity)
        .col_expr(channel_message::Column::Body, Expr::value(String::new()))
        .col_expr(channel_message::Column::Meta, Expr::value(Option::<String>::None))
        .col_expr(channel_message::Column::SystemCode, Expr::value(Option::<String>::None))
        .col_expr(channel_message::Column::Reactions, Expr::value(Option::<String>::None))
        .col_expr(channel_message::Column::DeletedAt, Expr::value(Some(at)))
        .col_expr(channel_message::Column::Revision, Expr::value(revision))
        .filter(channel_message::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

async fn set_reactions_impl<C: ConnectionTrait>(conn: &C, id: &str, reactions: Option<&str>, revision: i64) -> DbResult<()> {
    Update::many(channel_message::Entity)
        .col_expr(channel_message::Column::Reactions, Expr::value(reactions.map(str::to_owned)))
        .col_expr(channel_message::Column::Revision, Expr::value(revision))
        .filter(channel_message::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

async fn set_pinned_impl<C: ConnectionTrait>(conn: &C, id: &str, at: Option<i64>, revision: i64) -> DbResult<()> {
    Update::many(channel_message::Entity)
        .col_expr(channel_message::Column::PinnedAt, Expr::value(at))
        .col_expr(channel_message::Column::Revision, Expr::value(revision))
        .filter(channel_message::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

async fn set_meta_impl<C: ConnectionTrait>(conn: &C, id: &str, meta: Option<&str>, revision: i64) -> DbResult<()> {
    Update::many(channel_message::Entity)
        .col_expr(channel_message::Column::Meta, Expr::value(meta.map(str::to_owned)))
        .col_expr(channel_message::Column::Revision, Expr::value(revision))
        .filter(channel_message::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

async fn pinned_in_impl<C: ConnectionTrait>(conn: &C, channel_id: &str) -> DbResult<Vec<MsgRow>> {
    let mut stmt = select_msg_detail();
    stmt.and_where(Expr::col((channel_message::Entity, channel_message::Column::ChannelId)).eq(channel_id))
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::PinnedAt)).is_not_null())
        .order_by((channel_message::Entity, channel_message::Column::PinnedAt), Order::Desc);
    Ok(MsgQueryRow::find_by_statement(conn.get_database_backend().build(&stmt))
        .all(conn)
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}

async fn search_messages_impl<C: ConnectionTrait>(conn: &C, q: &SearchParams<'_>) -> DbResult<Vec<PlacedRow>> {
    let c = Alias::new("c");
    let ch = Alias::new("ch");
    let mut stmt = select_placed_msg(&c, &ch);
    stmt.and_where(Expr::col((channel_message::Entity, channel_message::Column::DeletedAt)).is_null())
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::Kind)).ne("notice"))
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::CreatedAt)).gte(q.after))
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::CreatedAt)).lt(q.before));

    if !q.text.is_empty() {
        let pattern = format!("%{}%", escape_like(&q.text.to_lowercase()));
        stmt.and_where(Expr::expr(Func::lower(Expr::col((channel_message::Entity, channel_message::Column::Body)))).like(LikeExpr::new(pattern).escape('\\')));
    }
    if !q.channel.is_empty() {
        stmt.cond_where(
            Condition::any()
                .add(Expr::col((channel_message::Entity, channel_message::Column::ChannelId)).eq(q.channel))
                .add(Expr::col((c, channel::Column::ParentId)).eq(q.channel)),
        );
    }
    if !q.sender.is_empty() {
        stmt.cond_where(
            Condition::any()
                .add(Expr::col((channel_message::Entity, channel_message::Column::SenderId)).eq(q.sender))
                .add(Func::lower(Expr::col((channel_participant::Entity, channel_participant::Column::Name))).eq(q.sender.to_lowercase())),
        );
    }
    if q.has_file {
        stmt.and_where(Expr::col((channel_message::Entity, channel_message::Column::Meta)).like(LikeExpr::new("%\"attachments\"%").escape('\\')));
    }
    if q.has_image {
        stmt.and_where(Expr::col((channel_message::Entity, channel_message::Column::Meta)).like(LikeExpr::new("%\"type\":\"image/%").escape('\\')));
    }
    if q.has_link {
        stmt.cond_where(
            Condition::any()
                .add(Expr::col((channel_message::Entity, channel_message::Column::Body)).like(LikeExpr::new("%http://%").escape('\\')))
                .add(Expr::col((channel_message::Entity, channel_message::Column::Body)).like(LikeExpr::new("%https://%").escape('\\'))),
        );
    }

    stmt.order_by((channel_message::Entity, channel_message::Column::Id), Order::Desc)
        .limit(limit_u64(q.n));

    let rows = PlacedQueryRow::find_by_statement(conn.get_database_backend().build(&stmt)).all(conn).await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

async fn notification_receipt_impl<C: ConnectionTrait>(conn: &C, id: &str) -> DbResult<Option<(Option<i64>, bool)>> {
    let n = Alias::new("n");
    let superseded_exists = Query::select()
        .expr(Expr::val(1i64))
        .from_as(channel_message::Entity, n.clone())
        .and_where(Expr::col((n.clone(), channel_message::Column::ChannelId)).equals((channel_message::Entity, channel_message::Column::ChannelId)))
        .and_where(Expr::col((n.clone(), channel_message::Column::Number)).gt(Expr::col((channel_message::Entity, channel_message::Column::Number))))
        .and_where(Expr::col((n.clone(), channel_message::Column::DeletedAt)).is_null())
        .cond_where(
            Condition::any().add(Expr::col((n.clone(), channel_message::Column::SenderId)).eq("user")).add(
                Condition::all()
                    .add(Expr::col((channel_message::Entity, channel_message::Column::Kind)).eq("report"))
                    .add(Expr::col((n.clone(), channel_message::Column::Kind)).eq("report"))
                    .add(Expr::col((n, channel_message::Column::SenderId)).equals((channel_message::Entity, channel_message::Column::SenderId))),
            ),
        )
        .to_owned();

    let stmt = Query::select()
        .expr_as(Expr::col((channel_read_cursor::Entity, channel_read_cursor::Column::UpdatedAt)), "updated_at")
        .expr_as(Expr::case(Expr::exists(superseded_exists), 1i64).finally(0i64), "superseded")
        .from(channel_message::Entity)
        .left_join(
            channel_read_cursor::Entity,
            Condition::all()
                .add(
                    Expr::col((channel_read_cursor::Entity, channel_read_cursor::Column::ChannelId))
                        .equals((channel_message::Entity, channel_message::Column::ChannelId)),
                )
                .add(Expr::col((channel_read_cursor::Entity, channel_read_cursor::Column::ParticipantId)).eq("user"))
                .add(
                    Expr::col((channel_read_cursor::Entity, channel_read_cursor::Column::ReadNumber))
                        .gte(Expr::col((channel_message::Entity, channel_message::Column::Number))),
                ),
        )
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::Id)).eq(id))
        .to_owned();

    Ok(NotificationReceiptRow::find_by_statement(conn.get_database_backend().build(&stmt))
        .one(conn)
        .await?
        .map(|r| (r.updated_at, r.superseded != 0)))
}

async fn user_read_reports_impl<C: ConnectionTrait>(conn: &C) -> DbResult<Vec<(String, i64, i64)>> {
    let n = Alias::new("n");
    let newer_exists = Query::select()
        .expr(Expr::val(1i64))
        .from_as(channel_message::Entity, n.clone())
        .and_where(Expr::col((n.clone(), channel_message::Column::ChannelId)).equals((channel_message::Entity, channel_message::Column::ChannelId)))
        .and_where(Expr::col((n.clone(), channel_message::Column::SenderId)).equals((channel_message::Entity, channel_message::Column::SenderId)))
        .and_where(Expr::col((n.clone(), channel_message::Column::Kind)).eq("report"))
        .and_where(Expr::col((n, channel_message::Column::Number)).gt(Expr::col((channel_message::Entity, channel_message::Column::Number))))
        .to_owned();

    let stmt = Query::select()
        .expr_as(Expr::col((channel_message::Entity, channel_message::Column::SenderId)), "sender_id")
        .expr_as(Expr::col((channel_message::Entity, channel_message::Column::CreatedAt)), "created_at")
        .expr_as(Expr::col((channel_read_cursor::Entity, channel_read_cursor::Column::UpdatedAt)), "updated_at")
        .from(channel_message::Entity)
        .inner_join(
            channel_read_cursor::Entity,
            Condition::all()
                .add(
                    Expr::col((channel_read_cursor::Entity, channel_read_cursor::Column::ChannelId))
                        .equals((channel_message::Entity, channel_message::Column::ChannelId)),
                )
                .add(Expr::col((channel_read_cursor::Entity, channel_read_cursor::Column::ParticipantId)).eq("user"))
                .add(
                    Expr::col((channel_read_cursor::Entity, channel_read_cursor::Column::ReadNumber))
                        .gte(Expr::col((channel_message::Entity, channel_message::Column::Number))),
                ),
        )
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::Kind)).eq("report"))
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::DeletedAt)).is_null())
        .and_where(Expr::exists(newer_exists).not())
        .to_owned();

    let rows = ReadReportRow::find_by_statement(conn.get_database_backend().build(&stmt)).all(conn).await?;
    Ok(rows.into_iter().map(|r| (r.sender_id, r.created_at, r.updated_at)).collect())
}

async fn insert_delivery_impl<C: ConnectionTrait>(conn: &C, d: &NewDelivery<'_>) -> DbResult<i64> {
    let saved = channel_delivery::ActiveModel {
        message_id: Set(d.message_id.to_owned()),
        channel_id: Set(d.channel_id.to_owned()),
        recipient_kind: Set(d.recipient_kind.to_owned()),
        recipient_id: Set(d.recipient_id.to_owned()),
        reason: Set(d.reason.to_owned()),
        wakes: Set(d.wakes),
        held_by: Set(d.held_by.map(str::to_owned)),
        status: Set("pending".to_owned()),
        created_at: Set(d.at),
        settled_at: Set(None),
        ..Default::default()
    }
    .insert(conn)
    .await?;
    Ok(saved.id)
}

async fn pending_deliveries_by_kind_impl<C: ConnectionTrait>(conn: &C, recipient_kind: &str) -> DbResult<Vec<DeliveryRow>> {
    Ok(channel_delivery::Entity::find()
        .filter(channel_delivery::Column::RecipientKind.eq(recipient_kind))
        .filter(channel_delivery::Column::Status.eq("pending"))
        .order_by_asc(channel_delivery::Column::Id)
        .all(conn)
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}

async fn pending_deliveries_for_recipient_impl<C: ConnectionTrait>(
    conn: &C,
    recipient_kind: &str,
    recipient_id: &str,
    max_id: i64,
) -> DbResult<Vec<DeliveryRow>> {
    Ok(channel_delivery::Entity::find()
        .filter(channel_delivery::Column::RecipientKind.eq(recipient_kind))
        .filter(channel_delivery::Column::RecipientId.eq(recipient_id))
        .filter(channel_delivery::Column::Status.eq("pending"))
        .filter(channel_delivery::Column::Id.lte(max_id))
        .order_by_asc(channel_delivery::Column::Id)
        .all(conn)
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}

async fn delivery_is_pending_impl<C: ConnectionTrait>(conn: &C, id: i64) -> DbResult<bool> {
    let count = channel_delivery::Entity::find()
        .filter(channel_delivery::Column::Id.eq(id))
        .filter(channel_delivery::Column::Status.eq("pending"))
        .count(conn)
        .await?;
    Ok(count > 0)
}

async fn pending_deliveries_for_message_impl<C: ConnectionTrait>(conn: &C, message_id: &str) -> DbResult<i64> {
    let count = channel_delivery::Entity::find()
        .filter(channel_delivery::Column::MessageId.eq(message_id))
        .filter(channel_delivery::Column::Status.eq("pending"))
        .count(conn)
        .await?;
    Ok(count as i64)
}

async fn settle_delivery_impl<C: ConnectionTrait>(conn: &C, id: i64, status: &str, at: i64) -> DbResult<()> {
    Update::many(channel_delivery::Entity)
        .col_expr(channel_delivery::Column::Status, Expr::value(status.to_owned()))
        .col_expr(channel_delivery::Column::SettledAt, Expr::value(Some(at)))
        .filter(channel_delivery::Column::Id.eq(id))
        .filter(channel_delivery::Column::Status.eq("pending"))
        .exec(conn)
        .await?;
    Ok(())
}

async fn withdraw_deliveries_for_message_impl<C: ConnectionTrait>(conn: &C, message_id: &str, at: i64) -> DbResult<()> {
    Update::many(channel_delivery::Entity)
        .col_expr(channel_delivery::Column::Status, Expr::value("withdrawn"))
        .col_expr(channel_delivery::Column::SettledAt, Expr::value(Some(at)))
        .filter(channel_delivery::Column::MessageId.eq(message_id))
        .filter(channel_delivery::Column::Status.eq("pending"))
        .exec(conn)
        .await?;
    Ok(())
}

async fn withdraw_deliveries_for_recipient_impl<C: ConnectionTrait>(conn: &C, recipient_kind: &str, recipient_id: &str, at: i64) -> DbResult<()> {
    Update::many(channel_delivery::Entity)
        .col_expr(channel_delivery::Column::Status, Expr::value("withdrawn"))
        .col_expr(channel_delivery::Column::SettledAt, Expr::value(Some(at)))
        .filter(channel_delivery::Column::RecipientKind.eq(recipient_kind))
        .filter(channel_delivery::Column::RecipientId.eq(recipient_id))
        .filter(channel_delivery::Column::Status.eq("pending"))
        .exec(conn)
        .await?;
    Ok(())
}

async fn delete_channel_impl<C: ConnectionTrait>(conn: &C, id: &str) -> DbResult<()> {
    let thread_ids_subquery = Query::select()
        .column(channel::Column::Id)
        .from(channel::Entity)
        .and_where(channel::Column::ParentId.eq(id))
        .to_owned();

    channel_delivery::Entity::delete_many()
        .filter(
            Condition::any()
                .add(channel_delivery::Column::ChannelId.eq(id))
                .add(channel_delivery::Column::ChannelId.in_subquery(thread_ids_subquery.clone())),
        )
        .exec(conn)
        .await?;

    channel_message::Entity::delete_many()
        .filter(channel_message::Column::ChannelId.in_subquery(thread_ids_subquery.clone()))
        .exec(conn)
        .await?;

    channel_member::Entity::delete_many()
        .filter(
            Condition::any()
                .add(channel_member::Column::ChannelId.eq(id))
                .add(channel_member::Column::ChannelId.in_subquery(thread_ids_subquery.clone())),
        )
        .exec(conn)
        .await?;

    channel_read_cursor::Entity::delete_many()
        .filter(
            Condition::any()
                .add(channel_read_cursor::Column::ChannelId.eq(id))
                .add(channel_read_cursor::Column::ChannelId.in_subquery(thread_ids_subquery)),
        )
        .exec(conn)
        .await?;

    channel::Entity::delete_many().filter(channel::Column::ParentId.eq(id)).exec(conn).await?;

    channel_message::Entity::delete_many()
        .filter(channel_message::Column::ChannelId.eq(id))
        .exec(conn)
        .await?;

    channel::Entity::delete_many()
        .filter(channel::Column::Id.eq(id))
        .filter(channel::Column::IsDefault.eq(false))
        .exec(conn)
        .await?;

    Ok(())
}

async fn message_locations_impl<C: ConnectionTrait>(conn: &C, ids: &[String]) -> DbResult<HashMap<String, (String, i64)>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, String, i64)> = channel_message::Entity::find()
        .select_only()
        .column(channel_message::Column::Id)
        .column(channel_message::Column::ChannelId)
        .column(channel_message::Column::Number)
        .filter(channel_message::Column::Id.is_in(ids.to_vec()))
        .into_tuple()
        .all(conn)
        .await?;
    Ok(rows.into_iter().map(|(id, channel_id, number)| (id, (channel_id, number))).collect())
}

#[derive(Clone)]
pub struct ChannelService {
    db: Arc<Database>,
}

impl ChannelService {
    pub(super) fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    pub async fn default_id(&self) -> DbResult<Option<String>> {
        default_id_impl(self.db.read_conn()).await
    }

    pub async fn default_id_in_tx(&self, tx: &Tx) -> DbResult<Option<String>> {
        default_id_impl(tx).await
    }

    pub async fn create_channel(&self, id: &str, is_default: bool, name: &str, description: Option<&str>, repo: Option<&str>, at: i64) -> DbResult<()> {
        create_channel_impl(self.db.write_conn(), id, is_default, name, description, repo, at).await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create_channel_in_tx(
        &self,
        tx: &Tx,
        id: &str,
        is_default: bool,
        name: &str,
        description: Option<&str>,
        repo: Option<&str>,
        at: i64,
    ) -> DbResult<()> {
        create_channel_impl(tx, id, is_default, name, description, repo, at).await
    }

    pub async fn create_direct(&self, id: &str, peer: &str, at: i64) -> DbResult<()> {
        create_direct_impl(self.db.write_conn(), id, peer, at).await
    }

    pub async fn create_direct_in_tx(&self, tx: &Tx, id: &str, peer: &str, at: i64) -> DbResult<()> {
        create_direct_impl(tx, id, peer, at).await
    }

    pub async fn clear_default(&self) -> DbResult<()> {
        clear_default_impl(self.db.write_conn()).await
    }

    pub async fn clear_default_in_tx(&self, tx: &Tx) -> DbResult<()> {
        clear_default_impl(tx).await
    }

    pub async fn make_default(&self, id: &str) -> DbResult<()> {
        make_default_impl(self.db.write_conn(), id).await
    }

    pub async fn make_default_in_tx(&self, tx: &Tx, id: &str) -> DbResult<()> {
        make_default_impl(tx, id).await
    }

    pub async fn update_channel(&self, id: &str, description: Option<&str>, repo: Option<&str>) -> DbResult<()> {
        update_channel_impl(self.db.write_conn(), id, description, repo).await
    }

    pub async fn update_channel_in_tx(&self, tx: &Tx, id: &str, description: Option<&str>, repo: Option<&str>) -> DbResult<()> {
        update_channel_impl(tx, id, description, repo).await
    }

    pub async fn create_thread(&self, thread: &NewThread<'_>) -> DbResult<()> {
        create_thread_impl(self.db.write_conn(), thread).await
    }

    pub async fn create_thread_in_tx(&self, tx: &Tx, thread: &NewThread<'_>) -> DbResult<()> {
        create_thread_impl(tx, thread).await
    }

    pub async fn all_channels(&self) -> DbResult<Vec<ChannelRow>> {
        all_channels_impl(self.db.read_conn()).await
    }

    pub async fn all_channels_in_tx(&self, tx: &Tx) -> DbResult<Vec<ChannelRow>> {
        all_channels_impl(tx).await
    }

    pub async fn recent_channels(&self, n: i64) -> DbResult<Vec<ChannelRow>> {
        recent_channels_impl(self.db.read_conn(), n).await
    }

    pub async fn touch_channel(&self, id: &str, number: i64) -> DbResult<()> {
        touch_channel_impl(self.db.write_conn(), id, number).await
    }

    pub async fn touch_channel_in_tx(&self, tx: &Tx, id: &str, number: i64) -> DbResult<()> {
        touch_channel_impl(tx, id, number).await
    }

    pub async fn unread_of(&self, participant: &str, channel_id: &str) -> DbResult<Vec<UnreadRow>> {
        unread_of_impl(self.db.read_conn(), participant, channel_id).await
    }

    pub async fn unread_of_in_tx(&self, tx: &Tx, participant: &str, channel_id: &str) -> DbResult<Vec<UnreadRow>> {
        unread_of_impl(tx, participant, channel_id).await
    }

    pub async fn bump_revision(&self, id: &str) -> DbResult<i64> {
        bump_revision_impl(self.db.write_conn(), id).await
    }

    pub async fn bump_revision_in_tx(&self, tx: &Tx, id: &str) -> DbResult<i64> {
        bump_revision_impl(tx, id).await
    }

    pub async fn rename_channel(&self, id: &str, name: Option<&str>) -> DbResult<()> {
        rename_channel_impl(self.db.write_conn(), id, name).await
    }

    pub async fn rename_channel_in_tx(&self, tx: &Tx, id: &str, name: Option<&str>) -> DbResult<()> {
        rename_channel_impl(tx, id, name).await
    }

    pub async fn set_category(&self, id: &str, category: Option<&str>) -> DbResult<()> {
        set_category_impl(self.db.write_conn(), id, category).await
    }

    pub async fn set_category_in_tx(&self, tx: &Tx, id: &str, category: Option<&str>) -> DbResult<()> {
        set_category_impl(tx, id, category).await
    }

    pub async fn place_channel(&self, id: &str, position: i64) -> DbResult<()> {
        place_channel_impl(self.db.write_conn(), id, position).await
    }

    pub async fn place_channel_in_tx(&self, tx: &Tx, id: &str, position: i64) -> DbResult<()> {
        place_channel_impl(tx, id, position).await
    }

    pub async fn set_archived(&self, id: &str, at: Option<i64>) -> DbResult<()> {
        set_archived_impl(self.db.write_conn(), id, at).await
    }

    pub async fn set_archived_in_tx(&self, tx: &Tx, id: &str, at: Option<i64>) -> DbResult<()> {
        set_archived_impl(tx, id, at).await
    }

    pub async fn set_notify(&self, id: &str, notify: &str) -> DbResult<()> {
        set_notify_impl(self.db.write_conn(), id, notify).await
    }

    pub async fn set_notify_in_tx(&self, tx: &Tx, id: &str, notify: &str) -> DbResult<()> {
        set_notify_impl(tx, id, notify).await
    }

    pub async fn topic_threads_in(&self, id: &str) -> DbResult<i64> {
        topic_threads_in_impl(self.db.read_conn(), id).await
    }

    pub async fn topic_threads_in_tx(&self, tx: &Tx, id: &str) -> DbResult<i64> {
        topic_threads_in_impl(tx, id).await
    }

    pub async fn upsert_participant(&self, p: &ParticipantRow) -> DbResult<()> {
        upsert_participant_impl(self.db.write_conn(), p).await
    }

    pub async fn upsert_participant_in_tx(&self, tx: &Tx, p: &ParticipantRow) -> DbResult<()> {
        upsert_participant_impl(tx, p).await
    }

    pub async fn add_participant(&self, id: &str, kind: &str, name: &str, at: i64) -> DbResult<()> {
        add_participant_impl(self.db.write_conn(), id, kind, name, at).await
    }

    pub async fn add_participant_in_tx(&self, tx: &Tx, id: &str, kind: &str, name: &str, at: i64) -> DbResult<()> {
        add_participant_impl(tx, id, kind, name, at).await
    }

    pub async fn participant_left(&self, id: &str, at: i64) -> DbResult<()> {
        participant_left_impl(self.db.write_conn(), id, at).await
    }

    pub async fn participant_left_in_tx(&self, tx: &Tx, id: &str, at: i64) -> DbResult<()> {
        participant_left_impl(tx, id, at).await
    }

    pub async fn participants(&self) -> DbResult<Vec<ParticipantRow>> {
        participants_impl(self.db.read_conn()).await
    }

    pub async fn participants_in_tx(&self, tx: &Tx) -> DbResult<Vec<ParticipantRow>> {
        participants_impl(tx).await
    }

    pub async fn add_member(&self, channel_id: &str, participant: &str, reason: &str, from: i64) -> DbResult<()> {
        add_member_impl(self.db.write_conn(), channel_id, participant, reason, from).await
    }

    pub async fn add_member_in_tx(&self, tx: &Tx, channel_id: &str, participant: &str, reason: &str, from: i64) -> DbResult<()> {
        add_member_impl(tx, channel_id, participant, reason, from).await
    }

    pub async fn remove_member(&self, channel_id: &str, participant: &str, at: i64) -> DbResult<()> {
        remove_member_impl(self.db.write_conn(), channel_id, participant, at).await
    }

    pub async fn remove_member_in_tx(&self, tx: &Tx, channel_id: &str, participant: &str, at: i64) -> DbResult<()> {
        remove_member_impl(tx, channel_id, participant, at).await
    }

    pub async fn all_members(&self) -> DbResult<Vec<(String, String)>> {
        all_members_impl(self.db.read_conn()).await
    }

    pub async fn all_members_in_tx(&self, tx: &Tx) -> DbResult<Vec<(String, String)>> {
        all_members_impl(tx).await
    }

    pub async fn remove_from_all(&self, participant: &str, at: i64) -> DbResult<()> {
        remove_from_all_impl(self.db.write_conn(), participant, at).await
    }

    pub async fn remove_from_all_in_tx(&self, tx: &Tx, participant: &str, at: i64) -> DbResult<()> {
        remove_from_all_impl(tx, participant, at).await
    }

    pub async fn insert_mention(&self, message: &str, target: &str, resolved: &str) -> DbResult<()> {
        insert_mention_impl(self.db.write_conn(), message, target, resolved).await
    }

    pub async fn insert_mention_in_tx(&self, tx: &Tx, message: &str, target: &str, resolved: &str) -> DbResult<()> {
        insert_mention_impl(tx, message, target, resolved).await
    }

    pub async fn delete_mentions_for_message(&self, message: &str) -> DbResult<()> {
        delete_mentions_for_message_impl(self.db.write_conn(), message).await
    }

    pub async fn delete_mentions_for_message_in_tx(&self, tx: &Tx, message: &str) -> DbResult<()> {
        delete_mentions_for_message_impl(tx, message).await
    }

    pub async fn mark_seen(&self, participant: &str, message: &str, at: i64) -> DbResult<()> {
        mark_seen_impl(self.db.write_conn(), participant, message, at).await
    }

    pub async fn mark_seen_in_tx(&self, tx: &Tx, participant: &str, message: &str, at: i64) -> DbResult<()> {
        mark_seen_impl(tx, participant, message, at).await
    }

    pub async fn set_read_cursor(&self, participant: &str, channel_id: &str, upto: i64, at: i64) -> DbResult<()> {
        set_read_cursor_impl(self.db.write_conn(), participant, channel_id, upto, at).await
    }

    pub async fn set_read_cursor_in_tx(&self, tx: &Tx, participant: &str, channel_id: &str, upto: i64, at: i64) -> DbResult<()> {
        set_read_cursor_impl(tx, participant, channel_id, upto, at).await
    }

    pub async fn read_cursor(&self, participant: &str, channel_id: &str) -> DbResult<Option<i64>> {
        read_cursor_impl(self.db.read_conn(), participant, channel_id).await
    }

    pub async fn read_cursor_in_tx(&self, tx: &Tx, participant: &str, channel_id: &str) -> DbResult<Option<i64>> {
        read_cursor_impl(tx, participant, channel_id).await
    }

    pub async fn read_cursors_of(&self, participant: &str) -> DbResult<Vec<(String, i64)>> {
        read_cursors_of_impl(self.db.read_conn(), participant).await
    }

    pub async fn read_cursors_of_in_tx(&self, tx: &Tx, participant: &str) -> DbResult<Vec<(String, i64)>> {
        read_cursors_of_impl(tx, participant).await
    }

    pub async fn mark_unread(&self, channel_id: &str, upto: i64, at: i64) -> DbResult<()> {
        mark_unread_impl(self.db.write_conn(), channel_id, upto, at).await
    }

    pub async fn mark_unread_in_tx(&self, tx: &Tx, channel_id: &str, upto: i64, at: i64) -> DbResult<()> {
        mark_unread_impl(tx, channel_id, upto, at).await
    }

    pub async fn insert_event(&self, kind: &str, channel_id: &str, message: &str, at: i64) -> DbResult<i64> {
        insert_event_impl(self.db.write_conn(), kind, channel_id, message, at).await
    }

    pub async fn insert_event_in_tx(&self, tx: &Tx, kind: &str, channel_id: &str, message: &str, at: i64) -> DbResult<i64> {
        insert_event_impl(tx, kind, channel_id, message, at).await
    }

    pub async fn events_after(&self, after: i64, n: i64) -> DbResult<Vec<EventRow>> {
        events_after_impl(self.db.read_conn(), after, n).await
    }

    pub async fn event_of(&self, message: &str) -> DbResult<Option<EventRow>> {
        event_of_impl(self.db.read_conn(), message).await
    }

    pub async fn event_of_in_tx(&self, tx: &Tx, message: &str) -> DbResult<Option<EventRow>> {
        event_of_impl(tx, message).await
    }

    pub async fn insert_message(&self, msg: &NewMessage<'_>) -> DbResult<i64> {
        insert_message_impl(self.db.write_conn(), msg).await
    }

    pub async fn insert_message_in_tx(&self, tx: &Tx, msg: &NewMessage<'_>) -> DbResult<i64> {
        insert_message_impl(tx, msg).await
    }

    pub async fn update_message_meta(&self, id: &str, meta: Option<&str>) -> DbResult<()> {
        update_message_meta_impl(self.db.write_conn(), id, meta).await
    }

    pub async fn update_message_meta_in_tx(&self, tx: &Tx, id: &str, meta: Option<&str>) -> DbResult<()> {
        update_message_meta_impl(tx, id, meta).await
    }

    pub async fn message_by_id(&self, id: &str) -> DbResult<Option<MsgRow>> {
        message_by_id_impl(self.db.read_conn(), id).await
    }

    pub async fn message_by_id_in_tx(&self, tx: &Tx, id: &str) -> DbResult<Option<MsgRow>> {
        message_by_id_impl(tx, id).await
    }

    pub async fn message_by_send_key(&self, sender: &str, key: &str) -> DbResult<Option<MsgRow>> {
        message_by_send_key_impl(self.db.read_conn(), sender, key).await
    }

    pub async fn message_by_send_key_in_tx(&self, tx: &Tx, sender: &str, key: &str) -> DbResult<Option<MsgRow>> {
        message_by_send_key_impl(tx, sender, key).await
    }

    pub async fn message_by_number(&self, channel_id: &str, number: i64) -> DbResult<Option<MsgRow>> {
        message_by_number_impl(self.db.read_conn(), channel_id, number).await
    }

    pub async fn message_by_number_in_tx(&self, tx: &Tx, channel_id: &str, number: i64) -> DbResult<Option<MsgRow>> {
        message_by_number_impl(tx, channel_id, number).await
    }

    pub async fn user_mentions(&self) -> DbResult<Vec<PlacedRow>> {
        user_mentions_impl(self.db.read_conn()).await
    }

    pub async fn user_mentions_in_tx(&self, tx: &Tx) -> DbResult<Vec<PlacedRow>> {
        user_mentions_impl(tx).await
    }

    pub async fn messages_before(&self, channel_id: &str, number: i64, n: i64) -> DbResult<Vec<MsgRow>> {
        messages_before_impl(self.db.read_conn(), channel_id, number, n).await
    }

    pub async fn messages_after(&self, channel_id: &str, number: i64, n: i64) -> DbResult<Vec<MsgRow>> {
        messages_after_impl(self.db.read_conn(), channel_id, number, n).await
    }

    pub async fn recent_reports(&self, n: i64) -> DbResult<Vec<MsgRow>> {
        recent_reports_impl(self.db.read_conn(), n).await
    }

    pub async fn reports_after(&self, after: &str, n: i64) -> DbResult<Vec<MsgRow>> {
        reports_after_impl(self.db.read_conn(), after, n).await
    }

    pub async fn recent_duplicate(&self, sender: &str, channel_id: &str, body: &str, since: i64) -> DbResult<Option<String>> {
        recent_duplicate_impl(self.db.read_conn(), sender, channel_id, body, since).await
    }

    pub async fn recent_duplicate_in_tx(&self, tx: &Tx, sender: &str, channel_id: &str, body: &str, since: i64) -> DbResult<Option<String>> {
        recent_duplicate_impl(tx, sender, channel_id, body, since).await
    }

    pub async fn dispatches_in(&self, channel_id: &str) -> DbResult<i64> {
        dispatches_in_impl(self.db.read_conn(), channel_id).await
    }

    pub async fn dispatches_in_tx(&self, tx: &Tx, channel_id: &str) -> DbResult<i64> {
        dispatches_in_impl(tx, channel_id).await
    }

    pub async fn user_unread(&self, channel_id: &str, read: i64) -> DbResult<i64> {
        user_unread_impl(self.db.read_conn(), channel_id, read).await
    }

    pub async fn user_unread_in_tx(&self, tx: &Tx, channel_id: &str, read: i64) -> DbResult<i64> {
        user_unread_impl(tx, channel_id, read).await
    }

    pub async fn latest_number(&self, channel_id: &str) -> DbResult<i64> {
        latest_number_impl(self.db.read_conn(), channel_id).await
    }

    pub async fn latest_number_in_tx(&self, tx: &Tx, channel_id: &str) -> DbResult<i64> {
        latest_number_impl(tx, channel_id).await
    }

    pub async fn callers_of(&self, speaker: &str, channel_id: &str, before: &str, n: i64) -> DbResult<Vec<String>> {
        callers_of_impl(self.db.read_conn(), speaker, channel_id, before, n).await
    }

    pub async fn callers_of_in_tx(&self, tx: &Tx, speaker: &str, channel_id: &str, before: &str, n: i64) -> DbResult<Vec<String>> {
        callers_of_impl(tx, speaker, channel_id, before, n).await
    }

    pub async fn unseen_in(&self, channel_id: &str, participant: &str) -> DbResult<Vec<String>> {
        unseen_in_impl(self.db.read_conn(), channel_id, participant).await
    }

    pub async fn unseen_in_tx(&self, tx: &Tx, channel_id: &str, participant: &str) -> DbResult<Vec<String>> {
        unseen_in_impl(tx, channel_id, participant).await
    }

    pub async fn notice_since_user(&self, channel_id: &str, code: &str) -> DbResult<i64> {
        notice_since_user_impl(self.db.read_conn(), channel_id, code).await
    }

    pub async fn notice_since_user_in_tx(&self, tx: &Tx, channel_id: &str, code: &str) -> DbResult<i64> {
        notice_since_user_impl(tx, channel_id, code).await
    }

    pub async fn messages_changed_after(&self, channel_id: &str, revision: i64, n: i64) -> DbResult<Vec<MsgRow>> {
        messages_changed_after_impl(self.db.read_conn(), channel_id, revision, n).await
    }

    pub async fn edit_message(&self, id: &str, body: &str, at: i64, revision: i64) -> DbResult<()> {
        edit_message_impl(self.db.write_conn(), id, body, at, revision).await
    }

    pub async fn edit_message_in_tx(&self, tx: &Tx, id: &str, body: &str, at: i64, revision: i64) -> DbResult<()> {
        edit_message_impl(tx, id, body, at, revision).await
    }

    pub async fn delete_message(&self, id: &str, at: i64, revision: i64) -> DbResult<()> {
        delete_message_impl(self.db.write_conn(), id, at, revision).await
    }

    pub async fn delete_message_in_tx(&self, tx: &Tx, id: &str, at: i64, revision: i64) -> DbResult<()> {
        delete_message_impl(tx, id, at, revision).await
    }

    pub async fn set_reactions(&self, id: &str, reactions: Option<&str>, revision: i64) -> DbResult<()> {
        set_reactions_impl(self.db.write_conn(), id, reactions, revision).await
    }

    pub async fn set_reactions_in_tx(&self, tx: &Tx, id: &str, reactions: Option<&str>, revision: i64) -> DbResult<()> {
        set_reactions_impl(tx, id, reactions, revision).await
    }

    pub async fn set_pinned(&self, id: &str, at: Option<i64>, revision: i64) -> DbResult<()> {
        set_pinned_impl(self.db.write_conn(), id, at, revision).await
    }

    pub async fn set_pinned_in_tx(&self, tx: &Tx, id: &str, at: Option<i64>, revision: i64) -> DbResult<()> {
        set_pinned_impl(tx, id, at, revision).await
    }

    pub async fn set_meta(&self, id: &str, meta: Option<&str>, revision: i64) -> DbResult<()> {
        set_meta_impl(self.db.write_conn(), id, meta, revision).await
    }

    pub async fn set_meta_in_tx(&self, tx: &Tx, id: &str, meta: Option<&str>, revision: i64) -> DbResult<()> {
        set_meta_impl(tx, id, meta, revision).await
    }

    pub async fn pinned_in(&self, channel_id: &str) -> DbResult<Vec<MsgRow>> {
        pinned_in_impl(self.db.read_conn(), channel_id).await
    }

    pub async fn search_messages(&self, params: &SearchParams<'_>) -> DbResult<Vec<PlacedRow>> {
        search_messages_impl(self.db.read_conn(), params).await
    }

    pub async fn notification_receipt(&self, id: &str) -> DbResult<Option<(Option<i64>, bool)>> {
        notification_receipt_impl(self.db.read_conn(), id).await
    }

    pub async fn user_read_reports(&self) -> DbResult<Vec<(String, i64, i64)>> {
        user_read_reports_impl(self.db.read_conn()).await
    }

    pub async fn insert_delivery(&self, delivery: &NewDelivery<'_>) -> DbResult<i64> {
        insert_delivery_impl(self.db.write_conn(), delivery).await
    }

    pub async fn insert_delivery_in_tx(&self, tx: &Tx, delivery: &NewDelivery<'_>) -> DbResult<i64> {
        insert_delivery_impl(tx, delivery).await
    }

    pub async fn pending_deliveries_by_kind(&self, recipient_kind: &str) -> DbResult<Vec<DeliveryRow>> {
        pending_deliveries_by_kind_impl(self.db.read_conn(), recipient_kind).await
    }

    pub async fn pending_deliveries_for_recipient(&self, recipient_kind: &str, recipient_id: &str, max_id: i64) -> DbResult<Vec<DeliveryRow>> {
        pending_deliveries_for_recipient_impl(self.db.read_conn(), recipient_kind, recipient_id, max_id).await
    }

    pub async fn delivery_is_pending(&self, id: i64) -> DbResult<bool> {
        delivery_is_pending_impl(self.db.read_conn(), id).await
    }

    pub async fn pending_deliveries_for_message(&self, message_id: &str) -> DbResult<i64> {
        pending_deliveries_for_message_impl(self.db.read_conn(), message_id).await
    }

    pub async fn pending_deliveries_for_message_in_tx(&self, tx: &Tx, message_id: &str) -> DbResult<i64> {
        pending_deliveries_for_message_impl(tx, message_id).await
    }

    pub async fn settle_delivery(&self, id: i64, status: &str, at: i64) -> DbResult<()> {
        settle_delivery_impl(self.db.write_conn(), id, status, at).await
    }

    pub async fn settle_delivery_in_tx(&self, tx: &Tx, id: i64, status: &str, at: i64) -> DbResult<()> {
        settle_delivery_impl(tx, id, status, at).await
    }

    pub async fn withdraw_deliveries_for_message(&self, message_id: &str, at: i64) -> DbResult<()> {
        withdraw_deliveries_for_message_impl(self.db.write_conn(), message_id, at).await
    }

    pub async fn withdraw_deliveries_for_message_in_tx(&self, tx: &Tx, message_id: &str, at: i64) -> DbResult<()> {
        withdraw_deliveries_for_message_impl(tx, message_id, at).await
    }

    pub async fn withdraw_deliveries_for_recipient(&self, recipient_kind: &str, recipient_id: &str, at: i64) -> DbResult<()> {
        withdraw_deliveries_for_recipient_impl(self.db.write_conn(), recipient_kind, recipient_id, at).await
    }

    pub async fn withdraw_deliveries_for_recipient_in_tx(&self, tx: &Tx, recipient_kind: &str, recipient_id: &str, at: i64) -> DbResult<()> {
        withdraw_deliveries_for_recipient_impl(tx, recipient_kind, recipient_id, at).await
    }

    pub async fn delete_channel(&self, id: &str) -> DbResult<()> {
        delete_channel_impl(self.db.write_conn(), id).await
    }

    pub async fn delete_channel_in_tx(&self, tx: &Tx, id: &str) -> DbResult<()> {
        delete_channel_impl(tx, id).await
    }

    pub async fn message_locations(&self, ids: &[String]) -> DbResult<HashMap<String, (String, i64)>> {
        message_locations_impl(self.db.read_conn(), ids).await
    }

    pub async fn message_locations_in_tx(&self, tx: &Tx, ids: &[String]) -> DbResult<HashMap<String, (String, i64)>> {
        message_locations_impl(tx, ids).await
    }
}
