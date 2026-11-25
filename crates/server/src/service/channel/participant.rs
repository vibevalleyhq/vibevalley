//! Dual-backend persistence for channel participants, room memberships,
//! mentions, seen markers, and read cursors.

use sea_orm::sea_query::{Alias, Expr, Func, OnConflict, Query};
use sea_orm::{ActiveValue::Set, ColumnTrait, ConnectionTrait, EntityTrait, ExprTrait, QueryFilter, QueryOrder, Update};

use super::ChannelService;
use crate::db::entity::{channel_member, channel_mention, channel_message, channel_participant, channel_read_cursor, channel_seen};
use crate::db::{DbError, DbResult, Tx};

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

async fn mark_member_left_impl<C: ConnectionTrait>(conn: &C, channel_id: Option<&str>, participant: &str, at: i64) -> DbResult<()> {
    let mut query = Update::many(channel_member::Entity)
        .col_expr(channel_member::Column::LeftAt, Expr::value(Some(at)))
        .filter(channel_member::Column::ParticipantId.eq(participant))
        .filter(channel_member::Column::LeftAt.is_null());
    if let Some(ch) = channel_id {
        query = query.filter(channel_member::Column::ChannelId.eq(ch));
    }
    query.exec(conn).await?;
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

impl ChannelService {
    pub(crate) async fn upsert_participant(&self, p: &ParticipantRow) -> DbResult<()> {
        upsert_participant_impl(self.db.write_conn(), p).await
    }

    pub(crate) async fn upsert_participant_in_tx(&self, tx: &Tx, p: &ParticipantRow) -> DbResult<()> {
        upsert_participant_impl(tx, p).await
    }

    pub(crate) async fn add_participant(&self, id: &str, kind: &str, name: &str, at: i64) -> DbResult<()> {
        add_participant_impl(self.db.write_conn(), id, kind, name, at).await
    }

    pub(crate) async fn participant_left_in_tx(&self, tx: &Tx, id: &str, at: i64) -> DbResult<()> {
        participant_left_impl(tx, id, at).await
    }

    pub(crate) async fn participants(&self) -> DbResult<Vec<ParticipantRow>> {
        participants_impl(self.db.read_conn()).await
    }

    pub(crate) async fn add_member(&self, channel_id: &str, participant: &str, reason: &str, from: i64) -> DbResult<()> {
        add_member_impl(self.db.write_conn(), channel_id, participant, reason, from).await
    }

    pub(crate) async fn add_member_in_tx(&self, tx: &Tx, channel_id: &str, participant: &str, reason: &str, from: i64) -> DbResult<()> {
        add_member_impl(tx, channel_id, participant, reason, from).await
    }

    pub(crate) async fn remove_member_in_tx(&self, tx: &Tx, channel_id: &str, participant: &str, at: i64) -> DbResult<()> {
        mark_member_left_impl(tx, Some(channel_id), participant, at).await
    }

    pub(crate) async fn all_members(&self) -> DbResult<Vec<(String, String)>> {
        all_members_impl(self.db.read_conn()).await
    }

    pub(crate) async fn remove_from_all_in_tx(&self, tx: &Tx, participant: &str, at: i64) -> DbResult<()> {
        mark_member_left_impl(tx, None, participant, at).await
    }

    pub(crate) async fn insert_mention_in_tx(&self, tx: &Tx, message: &str, target: &str, resolved: &str) -> DbResult<()> {
        insert_mention_impl(tx, message, target, resolved).await
    }

    pub(crate) async fn delete_mentions_for_message_in_tx(&self, tx: &Tx, message: &str) -> DbResult<()> {
        delete_mentions_for_message_impl(tx, message).await
    }

    pub(crate) async fn mark_seen(&self, participant: &str, message: &str, at: i64) -> DbResult<()> {
        mark_seen_impl(self.db.write_conn(), participant, message, at).await
    }

    pub(crate) async fn set_read_cursor_in_tx(&self, tx: &Tx, participant: &str, channel_id: &str, upto: i64, at: i64) -> DbResult<()> {
        set_read_cursor_impl(tx, participant, channel_id, upto, at).await
    }

    pub(crate) async fn read_cursor(&self, participant: &str, channel_id: &str) -> DbResult<Option<i64>> {
        read_cursor_impl(self.db.read_conn(), participant, channel_id).await
    }

    pub(crate) async fn read_cursors_of(&self, participant: &str) -> DbResult<Vec<(String, i64)>> {
        read_cursors_of_impl(self.db.read_conn(), participant).await
    }

    pub(crate) async fn mark_unread_in_tx(&self, tx: &Tx, channel_id: &str, upto: i64, at: i64) -> DbResult<()> {
        mark_unread_impl(tx, channel_id, upto, at).await
    }
}
