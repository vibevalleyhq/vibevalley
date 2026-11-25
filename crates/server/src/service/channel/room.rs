//! Dual-backend persistence for channel rooms, threads, direct messages,
//! unreads, and room metadata updates.

use sea_orm::sea_query::{Alias, Condition, Expr, Func, JoinType, OnConflict, Order, Query};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait, EntityTrait, ExprTrait, FromQueryResult, QueryFilter, QueryOrder, QuerySelect, Update,
};

use super::{ChannelService, UnreadRow, count_by_two, limit_u64};
use crate::db::entity::{channel, channel_delivery, channel_member, channel_mention, channel_message, channel_participant, channel_read_cursor, channel_seen};
use crate::db::{DbError, DbResult, Tx};

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
    pub(crate) fn empty(id: &str, kind: &str, created_at: i64) -> ChannelRow {
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

pub(crate) struct NewThread<'a> {
    pub(crate) id: &'a str,
    pub(crate) root_id: &'a str,
    pub(crate) root_number: i64,
    pub(crate) subject_kind: &'a str,
    pub(crate) subject_id: Option<&'a str>,
    pub(crate) parent_id: &'a str,
    pub(crate) at: i64,
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

async fn set_archived_impl<C: ConnectionTrait>(conn: &C, id: &str, at: Option<i64>) -> DbResult<()> {
    Update::many(channel::Entity)
        .col_expr(channel::Column::ArchivedAt, Expr::value(at))
        .filter(channel::Column::Id.eq(id))
        .filter(channel::Column::IsDefault.eq(false))
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

impl ChannelService {
    pub(crate) async fn default_id(&self) -> DbResult<Option<String>> {
        default_id_impl(self.db.read_conn()).await
    }

    pub(crate) async fn create_channel(&self, id: &str, is_default: bool, name: &str, description: Option<&str>, repo: Option<&str>, at: i64) -> DbResult<()> {
        create_channel_impl(self.db.write_conn(), id, is_default, name, description, repo, at).await
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn create_channel_in_tx(
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

    pub(crate) async fn create_direct_in_tx(&self, tx: &Tx, id: &str, peer: &str, at: i64) -> DbResult<()> {
        create_direct_impl(tx, id, peer, at).await
    }

    pub(crate) async fn clear_default_in_tx(&self, tx: &Tx) -> DbResult<()> {
        clear_default_impl(tx).await
    }

    pub(crate) async fn make_default_in_tx(&self, tx: &Tx, id: &str) -> DbResult<()> {
        make_default_impl(tx, id).await
    }

    pub(crate) async fn update_channel_in_tx(&self, tx: &Tx, id: &str, description: Option<&str>, repo: Option<&str>) -> DbResult<()> {
        update_channel_impl(tx, id, description, repo).await
    }

    pub(crate) async fn create_thread_in_tx(&self, tx: &Tx, thread: &NewThread<'_>) -> DbResult<()> {
        create_thread_impl(tx, thread).await
    }

    pub(crate) async fn all_channels(&self) -> DbResult<Vec<ChannelRow>> {
        all_channels_impl(self.db.read_conn()).await
    }

    pub(crate) async fn recent_channels(&self, n: i64) -> DbResult<Vec<ChannelRow>> {
        recent_channels_impl(self.db.read_conn(), n).await
    }

    pub(crate) async fn touch_channel_in_tx(&self, tx: &Tx, id: &str, number: i64) -> DbResult<()> {
        touch_channel_impl(tx, id, number).await
    }

    pub(crate) async fn unread_of(&self, participant: &str, channel_id: &str) -> DbResult<Vec<UnreadRow>> {
        unread_of_impl(self.db.read_conn(), participant, channel_id).await
    }

    pub(crate) async fn bump_revision_in_tx(&self, tx: &Tx, id: &str) -> DbResult<i64> {
        bump_revision_impl(tx, id).await
    }

    pub(crate) async fn rename_channel_in_tx(&self, tx: &Tx, id: &str, name: Option<&str>) -> DbResult<()> {
        rename_channel_impl(tx, id, name).await
    }

    pub(crate) async fn set_category_in_tx(&self, tx: &Tx, id: &str, category: Option<&str>) -> DbResult<()> {
        set_category_impl(tx, id, category).await
    }

    pub(crate) async fn place_channel_in_tx(&self, tx: &Tx, id: &str, position: i64) -> DbResult<()> {
        super::super::update_col_by_id::<channel::Entity, _, _>(tx, channel::Column::Id, id, channel::Column::Position, Some(position)).await
    }

    pub(crate) async fn set_archived_in_tx(&self, tx: &Tx, id: &str, at: Option<i64>) -> DbResult<()> {
        set_archived_impl(tx, id, at).await
    }

    pub(crate) async fn set_notify_in_tx(&self, tx: &Tx, id: &str, notify: &str) -> DbResult<()> {
        super::super::update_col_by_id::<channel::Entity, _, _>(tx, channel::Column::Id, id, channel::Column::Notify, notify.to_owned()).await
    }

    pub(crate) async fn topic_threads_in(&self, id: &str) -> DbResult<i64> {
        count_by_two::<channel::Entity, _, _, _>(self.db.read_conn(), channel::Column::ParentId, id, channel::Column::SubjectKind, "issue").await
    }

    pub(crate) async fn delete_channel_in_tx(&self, tx: &Tx, id: &str) -> DbResult<()> {
        delete_channel_impl(tx, id).await
    }
}
