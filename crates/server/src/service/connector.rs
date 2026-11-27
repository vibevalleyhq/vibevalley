//! Dual-backend persistence for external chat connectors:
//! accounts (`connector_account`), inbound messages (`connector_inbound`),
//! and outgoing delivery queue (`connector_outbox`).

use std::sync::Arc;

use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{ActiveValue::Set, ColumnTrait, ConnectionTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, Update};
use vibevalley_protocol::ConnectorID;

use super::{batch_chunk_rows, with_write_tx};
use crate::db::entity::{connector_account, connector_inbound, connector_outbox};
use crate::db::{Database, DbResult};

const CONNECTOR_INBOUND_BATCH_ROWS: usize = batch_chunk_rows(9);
const CONNECTOR_OUTBOX_BATCH_ROWS: usize = batch_chunk_rows(8);

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct ConnectorAccountRow {
    pub(crate) secrets: String,
    /// `""` until the user pairs by a message.
    pub(crate) user: String,
    pub(crate) pair_code: String,
    pub(crate) cursor: String,
    pub(crate) reply_context: String,
    pub(crate) last_inbound: i64,
    pub(crate) paused_until: i64,
    pub(crate) connected_at: i64,
    pub(crate) channel: Option<String>,
}

impl std::fmt::Debug for ConnectorAccountRow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectorAccountRow")
            .field("secrets", &"***")
            .field("user", &self.user)
            .field("pair_code", &self.pair_code)
            .field("cursor", &self.cursor)
            .field("reply_context", &self.reply_context)
            .field("last_inbound", &self.last_inbound)
            .field("paused_until", &self.paused_until)
            .field("connected_at", &self.connected_at)
            .field("channel", &self.channel)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConnectorInboundRow {
    pub(crate) id: String,
    pub(crate) from: String,
    pub(crate) text: String,
    pub(crate) reply: String,
    pub(crate) quoted: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConnectorOutgoingRow {
    pub(crate) seq: i64,
    pub(crate) message: String,
    pub(crate) body: String,
}

fn nonempty(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_owned())
}

async fn forget_impl<C: ConnectionTrait>(db: &C, id: ConnectorID, retired: &str) -> DbResult<()> {
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

#[derive(Clone)]
pub(crate) struct ConnectorService {
    db: Arc<Database>,
}

impl ConnectorService {
    pub(super) fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    pub(crate) async fn account(&self, id: ConnectorID) -> DbResult<Option<ConnectorAccountRow>> {
        let row = connector_account::Entity::find_by_id(id.as_str().to_owned()).one(self.db.read_conn()).await?;
        Ok(row.map(|a| ConnectorAccountRow {
            secrets: a.secrets,
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
    pub(crate) async fn connect(&self, id: ConnectorID, secrets: &str, user: &str, pair_code: Option<&str>, at: i64, retired: &str) -> DbResult<()> {
        with_write_tx(&self.db, async |tx| {
            let model = connector_account::ActiveModel {
                connector: Set(id.as_str().to_owned()),
                secrets: Set(secrets.to_owned()),
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
                .exec_without_returning(tx)
                .await?;
            forget_impl(tx, id, retired).await?;
            Ok(())
        })
        .await
    }

    pub(crate) async fn disconnect(&self, id: ConnectorID, retired: &str) -> DbResult<()> {
        with_write_tx(&self.db, async |tx| {
            connector_account::Entity::delete_by_id(id.as_str().to_owned()).exec(tx).await?;
            forget_impl(tx, id, retired).await?;
            Ok(())
        })
        .await
    }

    pub(crate) async fn pause(&self, id: ConnectorID, until: Option<i64>) -> DbResult<()> {
        Update::many(connector_account::Entity)
            .col_expr(connector_account::Column::PausedUntil, Expr::value(until))
            .filter(connector_account::Column::Connector.eq(id.as_str()))
            .exec(self.db.write_conn())
            .await?;
        Ok(())
    }

    pub(crate) async fn paired(&self, id: ConnectorID, from: &str, ext_id: &str, reply: &str, at: i64) -> DbResult<()> {
        with_write_tx(&self.db, async |tx| {
            Update::many(connector_account::Entity)
                .col_expr(connector_account::Column::UserId, Expr::value(Some(from.to_owned())))
                .col_expr(connector_account::Column::PairCode, Expr::value(Option::<String>::None))
                .col_expr(connector_account::Column::ReplyContext, Expr::value(nonempty(reply)))
                .col_expr(connector_account::Column::LastInbound, Expr::value(Some(at)))
                .filter(connector_account::Column::Connector.eq(id.as_str()))
                .exec(tx)
                .await?;
            Update::many(connector_inbound::Entity)
                .col_expr(connector_inbound::Column::Delivered, Expr::value(true))
                .col_expr(connector_inbound::Column::Body, Expr::value(String::new()))
                .filter(connector_inbound::Column::Connector.eq(id.as_str()))
                .filter(connector_inbound::Column::ExtId.eq(ext_id))
                .exec(tx)
                .await?;
            Ok(())
        })
        .await
    }

    pub(crate) async fn replied(&self, id: ConnectorID, reply: &str, at: i64) -> DbResult<()> {
        Update::many(connector_account::Entity)
            .col_expr(connector_account::Column::ReplyContext, Expr::value(nonempty(reply)))
            .col_expr(connector_account::Column::LastInbound, Expr::value(Some(at)))
            .filter(connector_account::Column::Connector.eq(id.as_str()))
            .exec(self.db.write_conn())
            .await?;
        Ok(())
    }

    pub(crate) async fn set_channel(&self, id: ConnectorID, channel: Option<&str>) -> DbResult<()> {
        Update::many(connector_account::Entity)
            .col_expr(connector_account::Column::ChannelId, Expr::value(channel.map(str::to_owned)))
            .filter(connector_account::Column::Connector.eq(id.as_str()))
            .exec(self.db.write_conn())
            .await?;
        Ok(())
    }

    pub(crate) async fn accounts_in(&self, channel: &str) -> DbResult<i64> {
        let count = connector_account::Entity::find()
            .filter(connector_account::Column::ChannelId.eq(channel))
            .count(self.db.read_conn())
            .await?;
        Ok(count as i64)
    }

    /// Only advances the cursor after the whole batch of inbound messages is durable.
    pub(crate) async fn accept(&self, id: ConnectorID, messages: &[ConnectorInboundRow], cursor: &str, at: i64) -> DbResult<bool> {
        with_write_tx(&self.db, async |tx| {
            let count = connector_account::Entity::find()
                .filter(connector_account::Column::Connector.eq(id.as_str()))
                .count(tx)
                .await?;
            if count == 0 {
                return Ok(false);
            }
            if !messages.is_empty() {
                let on_conflict = OnConflict::columns([connector_inbound::Column::Connector, connector_inbound::Column::ExtId])
                    .do_nothing()
                    .to_owned();
                for chunk in messages.chunks(CONNECTOR_INBOUND_BATCH_ROWS) {
                    let models = chunk.iter().map(|m| connector_inbound::ActiveModel {
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
                    });
                    connector_inbound::Entity::insert_many(models)
                        .on_conflict(on_conflict.clone())
                        .exec_without_returning(tx)
                        .await?;
                }
            }
            if !cursor.is_empty() {
                Update::many(connector_account::Entity)
                    .col_expr(connector_account::Column::Cursor, Expr::value(cursor.to_owned()))
                    .filter(connector_account::Column::Connector.eq(id.as_str()))
                    .exec(tx)
                    .await?;
            }
            Ok(true)
        })
        .await
    }

    pub(crate) async fn pending_inbound(&self, id: ConnectorID) -> DbResult<Vec<ConnectorInboundRow>> {
        let rows = connector_inbound::Entity::find()
            .filter(connector_inbound::Column::Connector.eq(id.as_str()))
            .filter(connector_inbound::Column::Delivered.eq(false))
            .order_by_asc(connector_inbound::Column::Seq)
            .all(self.db.read_conn())
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| ConnectorInboundRow {
                id: r.ext_id,
                from: r.from_id,
                text: r.body,
                reply: r.reply,
                quoted: r.quoted,
            })
            .collect())
    }

    pub(crate) async fn delivered(&self, id: ConnectorID, ext: &str, message: Option<&str>) -> DbResult<()> {
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

    async fn enqueue_outgoing(&self, id: ConnectorID, message: &str, pieces: &[String], at: i64, only_if_absent: bool) -> DbResult<bool> {
        if pieces.is_empty() {
            return Ok(false);
        }
        with_write_tx(&self.db, async |tx| {
            if only_if_absent {
                let existing = connector_outbox::Entity::find()
                    .filter(connector_outbox::Column::Connector.eq(id.as_str()))
                    .filter(connector_outbox::Column::MessageId.eq(message))
                    .filter(connector_outbox::Column::State.ne("dropped"))
                    .count(tx)
                    .await?;
                if existing > 0 {
                    return Ok(false);
                }
            }
            for chunk in pieces.chunks(CONNECTOR_OUTBOX_BATCH_ROWS) {
                let models = chunk.iter().map(|piece| connector_outbox::ActiveModel {
                    connector: Set(id.as_str().to_owned()),
                    message_id: Set(message.to_owned()),
                    body: Set(piece.clone()),
                    state: Set("pending".to_owned()),
                    ext_id: Set(None),
                    error: Set(None),
                    created_at: Set(at),
                    sent_at: Set(None),
                    ..Default::default()
                });
                connector_outbox::Entity::insert_many(models).exec_without_returning(tx).await?;
            }
            Ok(true)
        })
        .await
    }

    pub(crate) async fn add_outgoing(&self, id: ConnectorID, message: &str, pieces: &[String], at: i64) -> DbResult<()> {
        self.enqueue_outgoing(id, message, pieces, at, false).await?;
        Ok(())
    }

    /// Enqueues outgoing pieces only if `(connector, message_id)` has no non-dropped row yet.
    pub(crate) async fn add_outgoing_once(&self, id: ConnectorID, message: &str, pieces: &[String], at: i64) -> DbResult<bool> {
        self.enqueue_outgoing(id, message, pieces, at, true).await
    }

    pub(crate) async fn pending_outgoing(&self, id: ConnectorID) -> DbResult<Vec<ConnectorOutgoingRow>> {
        let rows = connector_outbox::Entity::find()
            .filter(connector_outbox::Column::Connector.eq(id.as_str()))
            .filter(connector_outbox::Column::State.eq("pending"))
            .order_by_asc(connector_outbox::Column::Seq)
            .all(self.db.read_conn())
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| ConnectorOutgoingRow {
                seq: r.seq,
                message: r.message_id,
                body: r.body,
            })
            .collect())
    }

    pub(crate) async fn count_pending(&self, id: ConnectorID) -> DbResult<i64> {
        let count = connector_outbox::Entity::find()
            .filter(connector_outbox::Column::Connector.eq(id.as_str()))
            .filter(connector_outbox::Column::State.eq("pending"))
            .count(self.db.read_conn())
            .await?;
        Ok(count as i64)
    }

    pub(crate) async fn withdraw(&self, message: &str) -> DbResult<()> {
        Update::many(connector_outbox::Entity)
            .col_expr(connector_outbox::Column::State, Expr::value("dropped"))
            .col_expr(connector_outbox::Column::Error, Expr::value("withdrawn"))
            .filter(connector_outbox::Column::MessageId.eq(message))
            .filter(connector_outbox::Column::State.eq("pending"))
            .exec(self.db.write_conn())
            .await?;
        Ok(())
    }

    pub(crate) async fn sent(&self, rows: &[i64], at: i64, ext: &str) -> DbResult<()> {
        if rows.is_empty() {
            return Ok(());
        }
        with_write_tx(&self.db, async |tx| {
            Update::many(connector_outbox::Entity)
                .col_expr(connector_outbox::Column::State, Expr::value("sent"))
                .col_expr(connector_outbox::Column::SentAt, Expr::value(Some(at)))
                .col_expr(connector_outbox::Column::ExtId, Expr::value(nonempty(ext)))
                .col_expr(connector_outbox::Column::Error, Expr::value(Option::<String>::None))
                .filter(connector_outbox::Column::Seq.is_in(rows.iter().copied()))
                .exec(tx)
                .await?;
            Ok(())
        })
        .await
    }

    pub(crate) async fn not_sent(&self, rows: &[i64], error: &str) -> DbResult<()> {
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

    pub(crate) async fn message_of_ext(&self, id: ConnectorID, ext: &str) -> DbResult<Option<String>> {
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

    pub(crate) async fn prune(&self, before: i64) -> DbResult<()> {
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
