//! Dual-backend persistence for channel messages, events, search, receipts, and deliveries.

use std::collections::HashMap;

use sea_orm::sea_query::{Alias, Condition, Expr, Func, JoinType, LikeExpr, Order, Query, SelectStatement, SubQueryStatement};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait, EntityTrait, ExprTrait, FromQueryResult, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, Update,
};

use super::{ChannelService, PlacedRow, count_by_two, limit_u64};
use crate::db::entity::{channel, channel_delivery, channel_event, channel_mention, channel_message, channel_participant, channel_read_cursor, channel_seen};
use crate::db::{DbError, DbResult, Tx};

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventRow {
    pub seq: i64,
    pub kind: String,
    pub channel_id: String,
    pub message_id: String,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeliveryRow {
    pub(crate) id: i64,
    pub(crate) message_id: String,
    pub(crate) channel_id: String,
    pub(crate) recipient_kind: String,
    pub(crate) recipient_id: String,
    pub(crate) reason: String,
    pub(crate) wakes: bool,
    pub(crate) held_by: Option<String>,
    pub(crate) status: String,
    pub(crate) created_at: i64,
    pub(crate) settled_at: Option<i64>,
}

pub(crate) struct SearchParams<'a> {
    pub(crate) text: &'a str,
    pub(crate) channel: &'a str,
    pub(crate) sender: &'a str,
    pub(crate) has_file: bool,
    pub(crate) has_image: bool,
    pub(crate) has_link: bool,
    pub(crate) after: i64,
    pub(crate) before: i64,
    pub(crate) n: i64,
}

pub(crate) struct NewMessage<'a> {
    pub(crate) id: &'a str,
    pub(crate) channel_id: &'a str,
    pub(crate) sender: &'a str,
    pub(crate) kind: &'a str,
    pub(crate) body: &'a str,
    pub(crate) meta: Option<&'a str>,
    pub(crate) system_code: Option<&'a str>,
    pub(crate) send_key: Option<&'a str>,
    pub(crate) at: i64,
    pub(crate) revision: i64,
    pub(crate) reply_number: Option<i64>,
}

pub(crate) struct NewDelivery<'a> {
    pub(crate) message_id: &'a str,
    pub(crate) channel_id: &'a str,
    pub(crate) recipient_kind: &'a str,
    pub(crate) recipient_id: &'a str,
    pub(crate) reason: &'a str,
    pub(crate) wakes: bool,
    pub(crate) held_by: Option<&'a str>,
    pub(crate) at: i64,
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

async fn query_msgs<C: ConnectionTrait>(conn: &C, build: impl FnOnce(&mut SelectStatement)) -> DbResult<Vec<MsgRow>> {
    let mut stmt = select_msg_detail();
    build(&mut stmt);
    Ok(MsgQueryRow::find_by_statement(conn.get_database_backend().build(&stmt))
        .all(conn)
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}

async fn query_msg_opt<C: ConnectionTrait>(conn: &C, build: impl FnOnce(&mut SelectStatement)) -> DbResult<Option<MsgRow>> {
    let mut stmt = select_msg_detail();
    build(&mut stmt);
    Ok(MsgQueryRow::find_by_statement(conn.get_database_backend().build(&stmt))
        .one(conn)
        .await?
        .map(Into::into))
}

async fn messages_cursor_impl<C: ConnectionTrait>(
    conn: &C,
    channel_id: &str,
    col: channel_message::Column,
    gt: bool,
    cursor: i64,
    n: i64,
) -> DbResult<Vec<MsgRow>> {
    query_msgs(conn, |stmt| {
        let col_expr = Expr::col((channel_message::Entity, col));
        stmt.and_where(Expr::col((channel_message::Entity, channel_message::Column::ChannelId)).eq(channel_id))
            .and_where(if gt { col_expr.gt(cursor) } else { col_expr.lt(cursor) })
            .order_by((channel_message::Entity, col), if gt { Order::Asc } else { Order::Desc })
            .limit(limit_u64(n));
    })
    .await
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

fn meta_has_file(meta: Option<&str>) -> bool {
    meta.is_some_and(|m| m.contains("\"attachments\""))
}

fn meta_has_image(meta: Option<&str>) -> bool {
    meta.is_some_and(|m| m.contains("\"type\":\"image/"))
}

fn body_has_link(body: &str) -> bool {
    body.contains("http://") || body.contains("https://")
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
            channel_message::Column::HasFile,
            channel_message::Column::HasImage,
            channel_message::Column::HasLink,
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
            Expr::val(meta_has_file(msg.meta)),
            Expr::val(meta_has_image(msg.meta)),
            Expr::val(body_has_link(msg.body)),
        ])
        .returning_col(channel_message::Column::Number)
        .to_owned();

    let row = conn.query_one(&stmt).await?.ok_or_else(|| DbError::custom("insert_message returned no row"))?;
    Ok(row.try_get("", "number")?)
}

async fn update_message_meta_impl<C: ConnectionTrait>(conn: &C, id: &str, meta: Option<&str>) -> DbResult<()> {
    Update::many(channel_message::Entity)
        .col_expr(channel_message::Column::Meta, Expr::value(meta.map(str::to_owned)))
        .col_expr(channel_message::Column::HasFile, Expr::value(meta_has_file(meta)))
        .col_expr(channel_message::Column::HasImage, Expr::value(meta_has_image(meta)))
        .filter(channel_message::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

async fn user_mentions_impl<C: ConnectionTrait>(conn: &C, viewer: &str) -> DbResult<Vec<PlacedRow>> {
    let c = Alias::new("c");
    let ch = Alias::new("ch");
    let reply = Alias::new("reply");

    let reply_exists = Query::select()
        .expr(Expr::val(1i64))
        .from_as(channel_message::Entity, reply.clone())
        .and_where(Expr::col((reply.clone(), channel_message::Column::ChannelId)).equals((channel_message::Entity, channel_message::Column::ChannelId)))
        .and_where(Expr::col((reply.clone(), channel_message::Column::SenderId)).eq(viewer))
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
            .add(Expr::col((channel_read_cursor::Entity, channel_read_cursor::Column::ParticipantId)).eq(viewer)),
    )
    .and_where(Expr::col((channel_mention::Entity, channel_mention::Column::TargetId)).eq(viewer))
    .and_where(Expr::col((channel_message::Entity, channel_message::Column::SenderId)).ne(viewer))
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

async fn recent_duplicate_impl<C: ConnectionTrait>(conn: &C, sender: &str, channel_id: &str, body: &str, since: i64) -> DbResult<Option<String>> {
    let id: Option<String> = channel_message::Entity::find()
        .select_only()
        .column(channel_message::Column::Id)
        .filter(channel_message::Column::ChannelId.eq(channel_id))
        .filter(channel_message::Column::SenderId.eq(sender))
        .filter(channel_message::Column::Body.eq(body))
        .filter(channel_message::Column::CreatedAt.gt(since))
        .order_by_desc(channel_message::Column::Id)
        .into_tuple()
        .one(conn)
        .await?;
    Ok(id)
}

async fn user_unread_impl<C: ConnectionTrait>(conn: &C, channel_id: &str, viewer: &str, read: i64) -> DbResult<i64> {
    let count = channel_message::Entity::find()
        .filter(channel_message::Column::ChannelId.eq(channel_id))
        .filter(channel_message::Column::Number.gt(read))
        .filter(channel_message::Column::SenderId.ne(viewer))
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
    let up = Alias::new("up");
    let last_user_subquery = Query::select()
        .expr(Expr::col((u.clone(), channel_message::Column::Id)).max())
        .from_as(channel_message::Entity, u.clone())
        .join_as(
            JoinType::InnerJoin,
            channel_participant::Entity,
            up.clone(),
            Expr::col((up.clone(), channel_participant::Column::Id)).equals((u.clone(), channel_message::Column::SenderId)),
        )
        .and_where(Expr::col((u, channel_message::Column::ChannelId)).eq(channel_id))
        .and_where(Expr::col((up, channel_participant::Column::Kind)).eq("user"))
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

async fn edit_message_impl<C: ConnectionTrait>(conn: &C, id: &str, body: &str, at: i64, revision: i64) -> DbResult<()> {
    Update::many(channel_message::Entity)
        .col_expr(channel_message::Column::Body, Expr::value(body.to_owned()))
        .col_expr(channel_message::Column::HasLink, Expr::value(body_has_link(body)))
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
        .col_expr(channel_message::Column::HasFile, Expr::value(false))
        .col_expr(channel_message::Column::HasImage, Expr::value(false))
        .col_expr(channel_message::Column::HasLink, Expr::value(false))
        .col_expr(channel_message::Column::DeletedAt, Expr::value(Some(at)))
        .col_expr(channel_message::Column::Revision, Expr::value(revision))
        .filter(channel_message::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

async fn update_message_field_impl<C: ConnectionTrait, V: Into<sea_orm::Value>>(
    conn: &C,
    id: &str,
    col: channel_message::Column,
    val: V,
    revision: i64,
) -> DbResult<()> {
    Update::many(channel_message::Entity)
        .col_expr(col, Expr::value(val))
        .col_expr(channel_message::Column::Revision, Expr::value(revision))
        .filter(channel_message::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

async fn search_messages_impl<C: ConnectionTrait>(conn: &C, q: &SearchParams<'_>) -> DbResult<Vec<PlacedRow>> {
    let backend = conn.get_database_backend();
    let c = Alias::new("c");
    let ch = Alias::new("ch");
    let mut stmt = select_placed_msg(&c, &ch);
    stmt.and_where(Expr::col((channel_message::Entity, channel_message::Column::DeletedAt)).is_null())
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::Kind)).ne("notice"))
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::CreatedAt)).gte(q.after))
        .and_where(Expr::col((channel_message::Entity, channel_message::Column::CreatedAt)).lt(q.before));

    if !q.text.is_empty() {
        if backend == sea_orm::DatabaseBackend::Sqlite
            && let Some(phrase) = super::super::fts5_trigram_phrase(q.text)
        {
            let fts = Alias::new("channel_message_fts");
            stmt.join(
                JoinType::InnerJoin,
                fts.clone(),
                Expr::col((fts, Alias::new("rowid"))).equals((channel_message::Entity, Alias::new("rowid"))),
            )
            .and_where(Expr::cust_with_values("channel_message_fts MATCH ?", [sea_orm::Value::from(phrase)]));
        } else {
            let pattern = format!("%{}%", super::super::escape_like(&q.text.to_lowercase()));
            stmt.and_where(
                Expr::expr(Func::lower(Expr::col((channel_message::Entity, channel_message::Column::Body)))).like(LikeExpr::new(pattern).escape('\\')),
            );
        }
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
        stmt.and_where(Expr::col((channel_message::Entity, channel_message::Column::HasFile)).eq(true));
    }
    if q.has_image {
        stmt.and_where(Expr::col((channel_message::Entity, channel_message::Column::HasImage)).eq(true));
    }
    if q.has_link {
        stmt.and_where(Expr::col((channel_message::Entity, channel_message::Column::HasLink)).eq(true));
    }

    stmt.order_by((channel_message::Entity, channel_message::Column::Id), Order::Desc)
        .limit(limit_u64(q.n));

    let rows = PlacedQueryRow::find_by_statement(backend.build(&stmt)).all(conn).await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

async fn notification_receipt_impl<C: ConnectionTrait>(conn: &C, id: &str, viewer: &str) -> DbResult<Option<(Option<i64>, bool)>> {
    let n = Alias::new("n");
    let superseded_exists = Query::select()
        .expr(Expr::val(1i64))
        .from_as(channel_message::Entity, n.clone())
        .and_where(Expr::col((n.clone(), channel_message::Column::ChannelId)).equals((channel_message::Entity, channel_message::Column::ChannelId)))
        .and_where(Expr::col((n.clone(), channel_message::Column::Number)).gt(Expr::col((channel_message::Entity, channel_message::Column::Number))))
        .and_where(Expr::col((n.clone(), channel_message::Column::DeletedAt)).is_null())
        .cond_where(
            Condition::any().add(Expr::col((n.clone(), channel_message::Column::SenderId)).eq(viewer)).add(
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
                .add(Expr::col((channel_read_cursor::Entity, channel_read_cursor::Column::ParticipantId)).eq(viewer))
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

async fn user_read_reports_impl<C: ConnectionTrait>(conn: &C, viewer: &str) -> DbResult<Vec<(String, i64, i64)>> {
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
                .add(Expr::col((channel_read_cursor::Entity, channel_read_cursor::Column::ParticipantId)).eq(viewer))
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

async fn pending_deliveries_all_impl<C: ConnectionTrait>(conn: &C) -> DbResult<Vec<DeliveryRow>> {
    Ok(channel_delivery::Entity::find()
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

async fn withdraw_deliveries_impl<C: ConnectionTrait>(conn: &C, filter: Condition, at: i64) -> DbResult<()> {
    Update::many(channel_delivery::Entity)
        .col_expr(channel_delivery::Column::Status, Expr::value("withdrawn"))
        .col_expr(channel_delivery::Column::SettledAt, Expr::value(Some(at)))
        .filter(filter)
        .filter(channel_delivery::Column::Status.eq("pending"))
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

impl ChannelService {
    pub(crate) async fn insert_event_in_tx(&self, tx: &Tx, kind: &str, channel_id: &str, message: &str, at: i64) -> DbResult<i64> {
        insert_event_impl(tx, kind, channel_id, message, at).await
    }

    pub(crate) async fn events_after(&self, after: i64, n: i64) -> DbResult<Vec<EventRow>> {
        events_after_impl(self.db.read_conn(), after, n).await
    }

    pub(crate) async fn event_of(&self, message: &str) -> DbResult<Option<EventRow>> {
        event_of_impl(self.db.read_conn(), message).await
    }

    pub(crate) async fn insert_message_in_tx(&self, tx: &Tx, msg: &NewMessage<'_>) -> DbResult<i64> {
        insert_message_impl(tx, msg).await
    }

    pub(crate) async fn update_message_meta_in_tx(&self, tx: &Tx, id: &str, meta: Option<&str>) -> DbResult<()> {
        update_message_meta_impl(tx, id, meta).await
    }

    pub(crate) async fn message_by_id(&self, id: &str) -> DbResult<Option<MsgRow>> {
        query_msg_opt(self.db.read_conn(), |stmt| {
            stmt.and_where(Expr::col((channel_message::Entity, channel_message::Column::Id)).eq(id));
        })
        .await
    }

    pub(crate) async fn message_by_send_key_in_tx(&self, tx: &Tx, sender: &str, key: &str) -> DbResult<Option<MsgRow>> {
        query_msg_opt(tx, |stmt| {
            stmt.and_where(Expr::col((channel_message::Entity, channel_message::Column::SenderId)).eq(sender))
                .and_where(Expr::col((channel_message::Entity, channel_message::Column::SendKey)).eq(key));
        })
        .await
    }

    pub(crate) async fn message_by_number(&self, channel_id: &str, number: i64) -> DbResult<Option<MsgRow>> {
        query_msg_opt(self.db.read_conn(), |stmt| {
            stmt.and_where(Expr::col((channel_message::Entity, channel_message::Column::ChannelId)).eq(channel_id))
                .and_where(Expr::col((channel_message::Entity, channel_message::Column::Number)).eq(number));
        })
        .await
    }

    pub(crate) async fn user_mentions(&self, viewer: &str) -> DbResult<Vec<PlacedRow>> {
        user_mentions_impl(self.db.read_conn(), viewer).await
    }

    pub(crate) async fn messages_before(&self, channel_id: &str, number: i64, n: i64) -> DbResult<Vec<MsgRow>> {
        messages_cursor_impl(self.db.read_conn(), channel_id, channel_message::Column::Number, false, number, n).await
    }

    pub(crate) async fn messages_after(&self, channel_id: &str, number: i64, n: i64) -> DbResult<Vec<MsgRow>> {
        messages_cursor_impl(self.db.read_conn(), channel_id, channel_message::Column::Number, true, number, n).await
    }

    pub(crate) async fn recent_reports(&self, n: i64) -> DbResult<Vec<MsgRow>> {
        query_msgs(self.db.read_conn(), |stmt| {
            stmt.and_where(Expr::col((channel_message::Entity, channel_message::Column::Kind)).eq("report"))
                .order_by((channel_message::Entity, channel_message::Column::Id), Order::Desc)
                .limit(limit_u64(n));
        })
        .await
    }

    pub(crate) async fn reports_after(&self, after: &str, n: i64) -> DbResult<Vec<MsgRow>> {
        query_msgs(self.db.read_conn(), |stmt| {
            stmt.and_where(Expr::col((channel_message::Entity, channel_message::Column::Kind)).eq("report"))
                .and_where(Expr::col((channel_message::Entity, channel_message::Column::Id)).gt(after))
                .order_by((channel_message::Entity, channel_message::Column::Id), Order::Asc)
                .limit(limit_u64(n));
        })
        .await
    }

    pub(crate) async fn recent_duplicate(&self, sender: &str, channel_id: &str, body: &str, since: i64) -> DbResult<Option<String>> {
        recent_duplicate_impl(self.db.read_conn(), sender, channel_id, body, since).await
    }

    pub(crate) async fn dispatches_in(&self, channel_id: &str) -> DbResult<i64> {
        count_by_two::<channel_message::Entity, _, _, _>(
            self.db.read_conn(),
            channel_message::Column::ChannelId,
            channel_id,
            channel_message::Column::Kind,
            "dispatch",
        )
        .await
    }

    pub(crate) async fn user_unread(&self, channel_id: &str, viewer: &str, read: i64) -> DbResult<i64> {
        user_unread_impl(self.db.read_conn(), channel_id, viewer, read).await
    }

    pub(crate) async fn latest_number(&self, channel_id: &str) -> DbResult<i64> {
        latest_number_impl(self.db.read_conn(), channel_id).await
    }

    pub(crate) async fn callers_of(&self, speaker: &str, channel_id: &str, before: &str, n: i64) -> DbResult<Vec<String>> {
        callers_of_impl(self.db.read_conn(), speaker, channel_id, before, n).await
    }

    pub(crate) async fn unseen_in(&self, channel_id: &str, participant: &str) -> DbResult<Vec<String>> {
        unseen_in_impl(self.db.read_conn(), channel_id, participant).await
    }

    pub(crate) async fn notice_since_user(&self, channel_id: &str, code: &str) -> DbResult<i64> {
        notice_since_user_impl(self.db.read_conn(), channel_id, code).await
    }

    pub(crate) async fn messages_changed_after(&self, channel_id: &str, revision: i64, n: i64) -> DbResult<Vec<MsgRow>> {
        messages_cursor_impl(self.db.read_conn(), channel_id, channel_message::Column::Revision, true, revision, n).await
    }

    pub(crate) async fn edit_message_in_tx(&self, tx: &Tx, id: &str, body: &str, at: i64, revision: i64) -> DbResult<()> {
        edit_message_impl(tx, id, body, at, revision).await
    }

    pub(crate) async fn delete_message_in_tx(&self, tx: &Tx, id: &str, at: i64, revision: i64) -> DbResult<()> {
        delete_message_impl(tx, id, at, revision).await
    }

    pub(crate) async fn set_reactions_in_tx(&self, tx: &Tx, id: &str, reactions: Option<&str>, revision: i64) -> DbResult<()> {
        update_message_field_impl(tx, id, channel_message::Column::Reactions, reactions.map(str::to_owned), revision).await
    }

    pub(crate) async fn set_pinned_in_tx(&self, tx: &Tx, id: &str, at: Option<i64>, revision: i64) -> DbResult<()> {
        update_message_field_impl(tx, id, channel_message::Column::PinnedAt, at, revision).await
    }

    pub(crate) async fn set_meta_in_tx(&self, tx: &Tx, id: &str, meta: Option<&str>, revision: i64) -> DbResult<()> {
        Update::many(channel_message::Entity)
            .col_expr(channel_message::Column::Meta, Expr::value(meta.map(str::to_owned)))
            .col_expr(channel_message::Column::HasFile, Expr::value(meta_has_file(meta)))
            .col_expr(channel_message::Column::HasImage, Expr::value(meta_has_image(meta)))
            .col_expr(channel_message::Column::Revision, Expr::value(revision))
            .filter(channel_message::Column::Id.eq(id))
            .exec(tx)
            .await?;
        Ok(())
    }

    pub(crate) async fn pinned_in(&self, channel_id: &str) -> DbResult<Vec<MsgRow>> {
        query_msgs(self.db.read_conn(), |stmt| {
            stmt.and_where(Expr::col((channel_message::Entity, channel_message::Column::ChannelId)).eq(channel_id))
                .and_where(Expr::col((channel_message::Entity, channel_message::Column::PinnedAt)).is_not_null())
                .order_by((channel_message::Entity, channel_message::Column::PinnedAt), Order::Desc);
        })
        .await
    }

    pub(crate) async fn search_messages(&self, params: &SearchParams<'_>) -> DbResult<Vec<PlacedRow>> {
        self.db
            .query_metrics()
            .observe(
                "channel.search_messages",
                "SELECT channel_message (search)",
                search_messages_impl(self.db.read_conn(), params),
            )
            .await
    }

    pub(crate) async fn notification_receipt(&self, id: &str, viewer: &str) -> DbResult<Option<(Option<i64>, bool)>> {
        notification_receipt_impl(self.db.read_conn(), id, viewer).await
    }

    pub(crate) async fn user_read_reports(&self, viewer: &str) -> DbResult<Vec<(String, i64, i64)>> {
        user_read_reports_impl(self.db.read_conn(), viewer).await
    }

    pub(crate) async fn insert_delivery_in_tx(&self, tx: &Tx, delivery: &NewDelivery<'_>) -> DbResult<i64> {
        insert_delivery_impl(tx, delivery).await
    }

    pub(crate) async fn pending_deliveries_all(&self) -> DbResult<Vec<DeliveryRow>> {
        pending_deliveries_all_impl(self.db.read_conn()).await
    }

    pub(crate) async fn pending_deliveries_for_recipient(&self, recipient_kind: &str, recipient_id: &str, max_id: i64) -> DbResult<Vec<DeliveryRow>> {
        pending_deliveries_for_recipient_impl(self.db.read_conn(), recipient_kind, recipient_id, max_id).await
    }

    pub(crate) async fn delivery_is_pending(&self, id: i64) -> DbResult<bool> {
        delivery_is_pending_impl(self.db.read_conn(), id).await
    }

    pub(crate) async fn pending_deliveries_for_message(&self, message_id: &str) -> DbResult<i64> {
        count_by_two::<channel_delivery::Entity, _, _, _>(
            self.db.read_conn(),
            channel_delivery::Column::MessageId,
            message_id,
            channel_delivery::Column::Status,
            "pending",
        )
        .await
    }

    pub(crate) async fn settle_delivery(&self, id: i64, status: &str, at: i64) -> DbResult<()> {
        settle_delivery_impl(self.db.write_conn(), id, status, at).await
    }

    pub(crate) async fn withdraw_deliveries_for_message_in_tx(&self, tx: &Tx, message_id: &str, at: i64) -> DbResult<()> {
        withdraw_deliveries_impl(tx, Condition::all().add(channel_delivery::Column::MessageId.eq(message_id)), at).await
    }

    pub(crate) async fn withdraw_deliveries_for_recipient_in_tx(&self, tx: &Tx, recipient_kind: &str, recipient_id: &str, at: i64) -> DbResult<()> {
        withdraw_deliveries_impl(
            tx,
            Condition::all()
                .add(channel_delivery::Column::RecipientKind.eq(recipient_kind))
                .add(channel_delivery::Column::RecipientId.eq(recipient_id)),
            at,
        )
        .await
    }

    pub(crate) async fn message_locations(&self, ids: &[String]) -> DbResult<HashMap<String, (String, i64)>> {
        message_locations_impl(self.db.read_conn(), ids).await
    }

    /// Deletes up to `limit` settled (`status != 'pending'`) delivery rows with `settled_at < before_ms`.
    pub(crate) async fn prune_settled_deliveries_batch(&self, before_ms: i64, limit: u64) -> DbResult<u64> {
        if limit == 0 {
            return Ok(0);
        }
        super::super::with_write_tx(&self.db, async |tx| {
            let ids: Vec<i64> = channel_delivery::Entity::find()
                .select_only()
                .column(channel_delivery::Column::Id)
                .filter(channel_delivery::Column::Status.ne("pending"))
                .filter(channel_delivery::Column::SettledAt.is_not_null())
                .filter(channel_delivery::Column::SettledAt.lt(before_ms))
                .order_by_asc(channel_delivery::Column::Id)
                .limit(limit)
                .into_tuple()
                .all(tx)
                .await?;
            if ids.is_empty() {
                return Ok(0);
            }
            let mut deleted = 0u64;
            for chunk in ids.chunks(super::super::MAX_SQL_BIND_PARAMS) {
                let res = channel_delivery::Entity::delete_many()
                    .filter(channel_delivery::Column::Id.is_in(chunk.iter().copied()))
                    .exec(tx)
                    .await?;
                deleted += res.rows_affected;
            }
            Ok(deleted)
        })
        .await
    }
}
