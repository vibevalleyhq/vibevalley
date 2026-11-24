//! The connectors' tables in `server.db`: each app's account
//! (`connector_account`), what it handed over (`connector_inbound`) and
//! what goes out to it (`connector_outbox`).

use std::sync::Arc;

use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, Update};
use vibevalley_protocol::ConnectorID;

use super::adapter::Inbound;
use crate::db::ServerDb;
use crate::db::begin_write_tx;
use crate::db::entities::collab_connector::{connector_account, connector_inbound, connector_outbox};
use crate::infra::setting::Secret;

/// The database did not take a step: said as the status's error.
#[derive(Debug, Clone)]
pub struct StoreFailed(pub String);

impl From<DbErr> for StoreFailed {
    fn from(e: DbErr) -> StoreFailed {
        StoreFailed(e.to_string())
    }
}

type Kept<T> = Result<T, StoreFailed>;

#[derive(Debug, Clone)]
pub struct Account {
    pub keys: Secret,
    /// "" until the user pairs by a message.
    pub user: String,
    pub pair_code: String,
    pub cursor: String,
    pub reply_context: String,
    pub last_inbound: i64,
    pub paused_until: i64,
    pub connected_at: i64,
    pub channel: Option<String>,
}

pub struct Outgoing {
    pub seq: i64,
    pub message: String,
    pub body: String,
}

pub struct Store {
    db: Arc<ServerDb>,
}

impl Store {
    pub fn open(db: Arc<ServerDb>) -> Store {
        Store { db }
    }

    pub async fn account_async(&self, id: ConnectorID) -> Kept<Option<Account>> {
        let row = connector_account::Entity::find_by_id(id.as_str().to_owned()).one(self.db.read_conn()).await?;
        Ok(row.map(|a| Account {
            keys: Secret::new(a.secrets),
            user: a.user_id.unwrap_or_default(),
            pair_code: a.pair_code.unwrap_or_default(),
            cursor: a.cursor,
            reply_context: a.reply_context.unwrap_or_default(),
            last_inbound: a.last_inbound.unwrap_or(0),
            paused_until: a.paused_until.unwrap_or(0),
            connected_at: a.connected_at,
            channel: a.channel_id.filter(|c| !c.is_empty()),
        }))
    }

    /// Replacing an account retires its queued work before reopening the bridge.
    pub async fn connect_async(&self, id: ConnectorID, keys: &Secret, user: &str, pair_code: Option<&str>, at: i64, retired: &str) -> Kept<()> {
        let tx = begin_write_tx(self.db.write_conn()).await?;
        let model = connector_account::ActiveModel {
            connector: Set(id.as_str().to_owned()),
            secrets: Set(keys.expose().to_owned()),
            user_id: Set(nonempty(user)),
            pair_code: Set(pair_code.map(str::to_owned)),
            cursor: Set(String::new()),
            reply_context: Set(None),
            last_inbound: Set(None),
            paused_until: Set(None),
            connected_at: Set(at),
            channel_id: Set(None),
        };
        let on_conflict = OnConflict::column(connector_account::Column::Connector)
            .update_columns([
                connector_account::Column::Secrets,
                connector_account::Column::UserId,
                connector_account::Column::PairCode,
            ])
            .value(connector_account::Column::Cursor, Expr::val(""))
            .value(connector_account::Column::ReplyContext, Expr::val(Option::<String>::None))
            .value(connector_account::Column::LastInbound, Expr::val(Option::<i64>::None))
            .value(connector_account::Column::PausedUntil, Expr::val(Option::<i64>::None))
            .update_column(connector_account::Column::ConnectedAt)
            .to_owned();
        connector_account::Entity::insert(model)
            .on_conflict(on_conflict)
            .exec_without_returning(&tx)
            .await?;
        forget(&tx, id, retired).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn disconnect_async(&self, id: ConnectorID, retired: &str) -> Kept<()> {
        let tx = begin_write_tx(self.db.write_conn()).await?;
        connector_account::Entity::delete_by_id(id.as_str().to_owned()).exec(&tx).await?;
        forget(&tx, id, retired).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn pause_async(&self, id: ConnectorID, until: Option<i64>) -> Kept<()> {
        Update::many(connector_account::Entity)
            .col_expr(connector_account::Column::PausedUntil, Expr::value(until))
            .filter(connector_account::Column::Connector.eq(id.as_str()))
            .exec(self.db.write_conn())
            .await?;
        Ok(())
    }

    pub async fn paired_async(&self, id: ConnectorID, m: &Inbound, at: i64) -> Kept<()> {
        let tx = begin_write_tx(self.db.write_conn()).await?;
        Update::many(connector_account::Entity)
            .col_expr(connector_account::Column::UserId, Expr::value(Some(m.from.clone())))
            .col_expr(connector_account::Column::PairCode, Expr::value(Option::<String>::None))
            .col_expr(connector_account::Column::ReplyContext, Expr::value(nonempty(&m.reply)))
            .col_expr(connector_account::Column::LastInbound, Expr::value(Some(at)))
            .filter(connector_account::Column::Connector.eq(id.as_str()))
            .exec(&tx)
            .await?;
        Update::many(connector_inbound::Entity)
            .col_expr(connector_inbound::Column::Delivered, Expr::value(true))
            .col_expr(connector_inbound::Column::Body, Expr::value(String::new()))
            .filter(connector_inbound::Column::Connector.eq(id.as_str()))
            .filter(connector_inbound::Column::ExtId.eq(&m.id))
            .exec(&tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn replied_async(&self, id: ConnectorID, reply: &str, at: i64) -> Kept<()> {
        Update::many(connector_account::Entity)
            .col_expr(connector_account::Column::ReplyContext, Expr::value(nonempty(reply)))
            .col_expr(connector_account::Column::LastInbound, Expr::value(Some(at)))
            .filter(connector_account::Column::Connector.eq(id.as_str()))
            .exec(self.db.write_conn())
            .await?;
        Ok(())
    }

    pub async fn set_channel_async(&self, id: ConnectorID, channel: Option<&str>) -> Kept<()> {
        Update::many(connector_account::Entity)
            .col_expr(connector_account::Column::ChannelId, Expr::value(channel.map(str::to_owned)))
            .filter(connector_account::Column::Connector.eq(id.as_str()))
            .exec(self.db.write_conn())
            .await?;
        Ok(())
    }

    pub async fn accounts_in_async(&self, channel: &str) -> Kept<i64> {
        let count = connector_account::Entity::find()
            .filter(connector_account::Column::ChannelId.eq(channel))
            .count(self.db.read_conn())
            .await?;
        Ok(count as i64)
    }

    /// Only advance the cursor after the whole batch of inbound messages is durable.
    pub async fn accept_async(&self, id: ConnectorID, messages: &[Inbound], cursor: &str, at: i64) -> Kept<bool> {
        let tx = begin_write_tx(self.db.write_conn()).await?;
        let count = connector_account::Entity::find()
            .filter(connector_account::Column::Connector.eq(id.as_str()))
            .count(&tx)
            .await?;
        if count == 0 {
            return Ok(false);
        }
        for m in messages {
            let model = connector_inbound::ActiveModel {
                connector: Set(id.as_str().to_owned()),
                ext_id: Set(m.id.clone()),
                from_id: Set(m.from.clone()),
                body: Set(m.text.clone()),
                reply: Set(m.reply.clone()),
                quoted: Set(m.quoted.clone()),
                message_id: Set(None),
                created_at: Set(at),
                delivered: Set(false),
                ..Default::default()
            };
            connector_inbound::Entity::insert(model)
                .on_conflict(
                    OnConflict::columns([connector_inbound::Column::Connector, connector_inbound::Column::ExtId])
                        .do_nothing()
                        .to_owned(),
                )
                .exec_without_returning(&tx)
                .await?;
        }
        if !cursor.is_empty() {
            Update::many(connector_account::Entity)
                .col_expr(connector_account::Column::Cursor, Expr::value(cursor.to_owned()))
                .filter(connector_account::Column::Connector.eq(id.as_str()))
                .exec(&tx)
                .await?;
        }
        tx.commit().await?;
        Ok(true)
    }

    pub async fn pending_inbound_async(&self, id: ConnectorID) -> Kept<Vec<Inbound>> {
        let rows = connector_inbound::Entity::find()
            .filter(connector_inbound::Column::Connector.eq(id.as_str()))
            .filter(connector_inbound::Column::Delivered.eq(false))
            .order_by_asc(connector_inbound::Column::Seq)
            .all(self.db.read_conn())
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| Inbound {
                id: r.ext_id,
                from: r.from_id,
                text: r.body,
                reply: r.reply,
                quoted: r.quoted,
            })
            .collect())
    }

    pub async fn delivered_async(&self, id: ConnectorID, ext: &str, message: Option<&str>) -> Kept<()> {
        Update::many(connector_inbound::Entity)
            .col_expr(connector_inbound::Column::Delivered, Expr::value(true))
            .col_expr(connector_inbound::Column::Body, Expr::value(String::new()))
            .col_expr(connector_inbound::Column::MessageId, Expr::value(message.map(str::to_owned)))
            .filter(connector_inbound::Column::Connector.eq(id.as_str()))
            .filter(connector_inbound::Column::ExtId.eq(ext))
            .exec(self.db.write_conn())
            .await?;
        Ok(())
    }

    pub async fn add_outgoing_async(&self, id: ConnectorID, message: &str, pieces: &[String], at: i64) -> Kept<()> {
        let tx = begin_write_tx(self.db.write_conn()).await?;
        for piece in pieces {
            connector_outbox::ActiveModel {
                connector: Set(id.as_str().to_owned()),
                message_id: Set(message.to_owned()),
                body: Set(piece.clone()),
                state: Set("pending".to_owned()),
                ext_id: Set(None),
                error: Set(None),
                created_at: Set(at),
                sent_at: Set(None),
                ..Default::default()
            }
            .insert(&tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn pending_outgoing_async(&self, id: ConnectorID) -> Kept<Vec<Outgoing>> {
        let rows = connector_outbox::Entity::find()
            .filter(connector_outbox::Column::Connector.eq(id.as_str()))
            .filter(connector_outbox::Column::State.eq("pending"))
            .order_by_asc(connector_outbox::Column::Seq)
            .all(self.db.read_conn())
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| Outgoing {
                seq: r.seq,
                message: r.message_id,
                body: r.body,
            })
            .collect())
    }

    pub async fn count_pending_async(&self, id: ConnectorID) -> Kept<i64> {
        let count = connector_outbox::Entity::find()
            .filter(connector_outbox::Column::Connector.eq(id.as_str()))
            .filter(connector_outbox::Column::State.eq("pending"))
            .count(self.db.read_conn())
            .await?;
        Ok(count as i64)
    }

    pub async fn withdraw_async(&self, message: &str) -> Kept<()> {
        Update::many(connector_outbox::Entity)
            .col_expr(connector_outbox::Column::State, Expr::value("dropped"))
            .col_expr(connector_outbox::Column::Error, Expr::value("withdrawn"))
            .filter(connector_outbox::Column::MessageId.eq(message))
            .filter(connector_outbox::Column::State.eq("pending"))
            .exec(self.db.write_conn())
            .await?;
        Ok(())
    }

    pub async fn sent_async(&self, rows: &[i64], at: i64, ext: &str) -> Kept<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let tx = begin_write_tx(self.db.write_conn()).await?;
        Update::many(connector_outbox::Entity)
            .col_expr(connector_outbox::Column::State, Expr::value("sent"))
            .col_expr(connector_outbox::Column::SentAt, Expr::value(Some(at)))
            .col_expr(connector_outbox::Column::ExtId, Expr::value(nonempty(ext)))
            .col_expr(connector_outbox::Column::Error, Expr::value(Option::<String>::None))
            .filter(connector_outbox::Column::Seq.is_in(rows.iter().copied()))
            .exec(&tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn not_sent_async(&self, rows: &[i64], error: &str) -> Kept<()> {
        if rows.is_empty() {
            return Ok(());
        }
        Update::many(connector_outbox::Entity)
            .col_expr(connector_outbox::Column::Error, Expr::value(nonempty(error)))
            .filter(connector_outbox::Column::Seq.is_in(rows.iter().copied()))
            .exec(self.db.write_conn())
            .await?;
        Ok(())
    }

    pub async fn message_of_ext_async(&self, id: ConnectorID, ext: &str) -> Kept<Option<String>> {
        if let Some(row) = connector_outbox::Entity::find()
            .filter(connector_outbox::Column::Connector.eq(id.as_str()))
            .filter(connector_outbox::Column::ExtId.eq(ext))
            .one(self.db.read_conn())
            .await?
        {
            return Ok(Some(row.message_id));
        }
        let row = connector_inbound::Entity::find()
            .filter(connector_inbound::Column::Connector.eq(id.as_str()))
            .filter(connector_inbound::Column::ExtId.eq(ext))
            .filter(connector_inbound::Column::MessageId.is_not_null())
            .one(self.db.read_conn())
            .await?;
        Ok(row.and_then(|r| r.message_id))
    }

    pub async fn prune_async(&self, before: i64) -> Kept<()> {
        connector_inbound::Entity::delete_many()
            .filter(connector_inbound::Column::Delivered.eq(true))
            .filter(connector_inbound::Column::CreatedAt.lt(before))
            .exec(self.db.write_conn())
            .await?;
        connector_outbox::Entity::delete_many()
            .filter(connector_outbox::Column::State.ne("pending"))
            .filter(connector_outbox::Column::CreatedAt.lt(before))
            .exec(self.db.write_conn())
            .await?;
        Ok(())
    }
}

fn nonempty(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_owned())
}

async fn forget<C: ConnectionTrait>(db: &C, id: ConnectorID, retired: &str) -> Result<(), DbErr> {
    connector_inbound::Entity::delete_many()
        .filter(connector_inbound::Column::Connector.eq(id.as_str()))
        .exec(db)
        .await?;
    Update::many(connector_outbox::Entity)
        .col_expr(connector_outbox::Column::State, Expr::value("dropped"))
        .col_expr(connector_outbox::Column::Error, Expr::value(Some(retired.to_owned())))
        .filter(connector_outbox::Column::Connector.eq(id.as_str()))
        .filter(connector_outbox::Column::State.eq("pending"))
        .exec(db)
        .await?;
    Ok(())
}

#[cfg(test)]
#[path = "store_test.rs"]
mod tests;
