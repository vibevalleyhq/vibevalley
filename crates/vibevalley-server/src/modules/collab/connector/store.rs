//! The connectors' tables in `server.db`: each app's account
//! (`connector_account`), what it handed over (`connector_inbound`) and
//! what goes out to it (`connector_outbox`).

use std::path::Path;

use sqlx::Connection;
use vibevalley_protocol::ConnectorID;

use super::adapter::Inbound;
#[rustfmt::skip]
#[path = "generated/queries.rs"]
mod q;

use crate::base::ModuleDb;
use crate::modules::infra::setting::Secret;

/// The database did not take a step: said as the status's error.
#[derive(Debug, Clone)]
pub struct StoreFailed(pub String);

impl From<sqlx::Error> for StoreFailed {
    fn from(e: sqlx::Error) -> StoreFailed {
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
    db: ModuleDb,
}

impl Store {
    pub fn open(home: &Path) -> Kept<Store> {
        Ok(Store {
            db: ModuleDb::open(home, include_str!("sql/schema.sql"))?,
        })
    }

    pub fn account(&self, id: ConnectorID) -> Kept<Option<Account>> {
        match self
            .db
            .run(async |db| q::get_account(db, q::GetAccountParams { connector: id.as_str().into() }).await)
        {
            Ok(a) => Ok(Some(Account {
                keys: Secret::new(a.secrets),
                user: a.user_id.unwrap_or_default(),
                pair_code: a.pair_code.unwrap_or_default(),
                cursor: a.cursor,
                reply_context: a.reply_context.unwrap_or_default(),
                last_inbound: a.last_inbound.unwrap_or(0),
                paused_until: a.paused_until.unwrap_or(0),
                connected_at: a.connected_at,
                channel: a.channel_id.filter(|c| !c.is_empty()),
            })),
            Err(sqlx::Error::RowNotFound) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// Replacing an account retires its queued work before reopening the bridge.
    pub fn connect(&self, id: ConnectorID, keys: &Secret, user: &str, pair_code: Option<&str>, at: i64, retired: &str) -> Kept<()> {
        Ok(self.db.run(async |db| {
            let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
            q::connect_account(
                &mut *tx,
                q::ConnectAccountParams {
                    connector: id.as_str().into(),
                    secrets: keys.expose().into(),
                    user_id: nonempty(user),
                    pair_code: pair_code.map(str::to_owned),
                    connected_at: at,
                },
            )
            .await?;
            forget(&mut tx, id, retired).await?;
            tx.commit().await
        })?)
    }

    pub fn disconnect(&self, id: ConnectorID, retired: &str) -> Kept<()> {
        Ok(self.db.run(async |db| {
            let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
            q::delete_account(&mut *tx, q::DeleteAccountParams { connector: id.as_str().into() }).await?;
            forget(&mut tx, id, retired).await?;
            tx.commit().await
        })?)
    }

    pub fn pause(&self, id: ConnectorID, until: Option<i64>) -> Kept<()> {
        Ok(self.db.run(async |db| {
            q::pause_account(
                db,
                q::PauseAccountParams {
                    connector: id.as_str().into(),
                    paused_until: until,
                },
            )
            .await
        })?)
    }

    pub fn paired(&self, id: ConnectorID, m: &Inbound, at: i64) -> Kept<()> {
        Ok(self.db.run(async |db| {
            let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
            q::pair_account(
                &mut *tx,
                q::PairAccountParams {
                    connector: id.as_str().into(),
                    user_id: Some(m.from.clone()),
                    reply_context: nonempty(&m.reply),
                    last_inbound: Some(at),
                },
            )
            .await?;
            q::finish_pairing(
                &mut *tx,
                q::FinishPairingParams {
                    connector: id.as_str().into(),
                    ext_id: m.id.clone(),
                },
            )
            .await?;
            tx.commit().await
        })?)
    }
    pub fn replied(&self, id: ConnectorID, reply: &str, at: i64) -> Kept<()> {
        Ok(self.db.run(async |db| {
            q::update_reply(
                db,
                q::UpdateReplyParams {
                    connector: id.as_str().into(),
                    reply_context: nonempty(reply),
                    last_inbound: Some(at),
                },
            )
            .await
        })?)
    }

    pub fn set_channel(&self, id: ConnectorID, channel: Option<&str>) -> Kept<()> {
        Ok(self.db.run(async |db| {
            q::set_channel(
                db,
                q::SetChannelParams {
                    connector: id.as_str().into(),
                    channel_id: channel.map(str::to_owned),
                },
            )
            .await
        })?)
    }

    pub fn accounts_in(&self, channel: &str) -> Kept<i64> {
        Ok(self
            .db
            .run(async |db| {
                q::accounts_in_channel(
                    db,
                    q::AccountsInChannelParams {
                        channel_id: Some(channel.into()),
                    },
                )
                .await
            })?
            .count)
    }

    /// Only advance the cursor after the whole batch of inbound messages is durable.
    pub fn accept(&self, id: ConnectorID, messages: &[Inbound], cursor: &str, at: i64) -> Kept<bool> {
        Ok(self.db.run(async |db| {
            let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
            if q::account_count(&mut *tx, q::AccountCountParams { connector: id.as_str().into() }).await?.count == 0 {
                return Ok(false);
            }
            for m in messages {
                q::accept_inbound(
                    &mut *tx,
                    q::AcceptInboundParams {
                        connector: id.as_str().into(),
                        ext_id: m.id.clone(),
                        from_id: m.from.clone(),
                        body: m.text.clone(),
                        reply: m.reply.clone(),
                        quoted: m.quoted.clone(),
                        created_at: at,
                    },
                )
                .await?;
            }
            if !cursor.is_empty() {
                q::update_cursor(
                    &mut *tx,
                    q::UpdateCursorParams {
                        connector: id.as_str().into(),
                        cursor: cursor.into(),
                    },
                )
                .await?;
            }
            tx.commit().await?;
            Ok(true)
        })?)
    }

    pub fn pending_inbound(&self, id: ConnectorID) -> Kept<Vec<Inbound>> {
        let rows = self
            .db
            .run(async |db| q::pending_inbound(db, q::PendingInboundParams { connector: id.as_str().into() }).await)?;
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

    pub fn delivered(&self, id: ConnectorID, ext: &str, message: Option<&str>) -> Kept<()> {
        Ok(self.db.run(async |db| {
            q::mark_delivered(
                db,
                q::MarkDeliveredParams {
                    connector: id.as_str().into(),
                    ext_id: ext.into(),
                    message_id: message.map(str::to_owned),
                },
            )
            .await
        })?)
    }

    pub fn add_outgoing(&self, id: ConnectorID, message: &str, pieces: &[String], at: i64) -> Kept<()> {
        Ok(self.db.run(async |db| {
            let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
            for piece in pieces {
                q::add_outgoing(
                    &mut *tx,
                    q::AddOutgoingParams {
                        connector: id.as_str().into(),
                        message_id: message.into(),
                        body: piece.clone(),
                        created_at: at,
                    },
                )
                .await?;
            }
            tx.commit().await
        })?)
    }

    pub fn pending_outgoing(&self, id: ConnectorID) -> Kept<Vec<Outgoing>> {
        let rows = self
            .db
            .run(async |db| q::pending_outgoing(db, q::PendingOutgoingParams { connector: id.as_str().into() }).await)?;
        Ok(rows
            .into_iter()
            .map(|r| Outgoing {
                seq: r.seq,
                message: r.message_id,
                body: r.body,
            })
            .collect())
    }

    pub fn count_pending(&self, id: ConnectorID) -> Kept<i64> {
        Ok(self
            .db
            .run(async |db| q::pending_count(db, q::PendingCountParams { connector: id.as_str().into() }).await)?
            .count)
    }

    pub fn withdraw(&self, message: &str) -> Kept<()> {
        Ok(self
            .db
            .run(async |db| q::withdraw_outgoing(db, q::WithdrawOutgoingParams { message_id: message.into() }).await)?)
    }

    pub fn sent(&self, rows: &[i64], at: i64, ext: &str) -> Kept<()> {
        Ok(self.db.run(async |db| {
            let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
            for seq in rows {
                q::mark_sent(
                    &mut *tx,
                    q::MarkSentParams {
                        seq: *seq,
                        sent_at: Some(at),
                        ext_id: nonempty(ext),
                    },
                )
                .await?;
            }
            tx.commit().await
        })?)
    }

    pub fn not_sent(&self, rows: &[i64], error: &str) -> Kept<()> {
        Ok(self.db.run(async |db| {
            for seq in rows {
                q::mark_send_error(
                    &mut *db,
                    q::MarkSendErrorParams {
                        seq: *seq,
                        error: nonempty(error),
                    },
                )
                .await?;
            }
            Ok(())
        })?)
    }

    pub fn message_of_ext(&self, id: ConnectorID, ext: &str) -> Kept<Option<String>> {
        match self.db.run(async |db| {
            q::message_of_external(
                db,
                q::MessageOfExternalParams {
                    connector: id.as_str().into(),
                    ext_id: Some(ext.into()),
                },
            )
            .await
        }) {
            Ok(row) => Ok(Some(row.message_id)),
            Err(sqlx::Error::RowNotFound) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn prune(&self, before: i64) -> Kept<()> {
        Ok(self.db.run(async |db| {
            q::prune_inbound(&mut *db, q::PruneInboundParams { created_at: before }).await?;
            q::prune_outgoing(db, q::PruneOutgoingParams { created_at: before }).await
        })?)
    }
}

fn nonempty(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_owned())
}

async fn forget(db: &mut sqlx::SqliteConnection, id: ConnectorID, retired: &str) -> sqlx::Result<()> {
    q::forget_inbound(&mut *db, q::ForgetInboundParams { connector: id.as_str().into() }).await?;
    q::retire_pending(
        db,
        q::RetirePendingParams {
            connector: id.as_str().into(),
            error: Some(retired.into()),
        },
    )
    .await
}

#[cfg(test)]
#[path = "store_test.rs"]
mod tests;
