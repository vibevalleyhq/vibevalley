//! The connectors' tables in `server.db`: each app's account
//! (`connector_account`), what it handed over (`connector_inbound`) and
//! what goes out to it (`connector_outbox`).

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{Connection, OptionalExtension, params};
use vibevalley_protocol::ConnectorID;

use super::adapter::Inbound;
use crate::modules::attachment::open_db;
use crate::modules::setting::Secret;

const SCHEMA: &str = "
create table if not exists connector_account (
  connector     text primary key,
  secrets       text not null,
  user_id       text,
  pair_code     text,
  cursor        text not null default '',
  reply_context text,
  last_inbound  integer,
  paused_until  integer,
  connected_at  integer not null,
  channel_id    text
);
create table if not exists connector_inbound (
  seq          integer primary key autoincrement,
  connector    text not null,
  ext_id       text not null,
  from_id      text not null,
  body         text not null,
  reply        text not null,
  quoted       text not null,
  message_id   text,
  created_at   integer not null,
  delivered    integer not null default 0,
  unique (connector, ext_id)
);
create table if not exists connector_outbox (
  seq        integer primary key autoincrement,
  connector  text not null,
  message_id text not null,
  body       text not null,
  state      text not null default 'pending' check (state in ('pending', 'sent', 'dropped')),
  ext_id     text,
  error      text,
  created_at integer not null,
  sent_at    integer
);
create index if not exists connector_outbox_waiting on connector_outbox (connector, state, seq);
create index if not exists connector_outbox_ext on connector_outbox (connector, ext_id);
";

/// The database did not take a step: said as the status's error.
#[derive(Debug, Clone)]
pub struct StoreFailed(pub String);

impl From<rusqlite::Error> for StoreFailed {
    fn from(e: rusqlite::Error) -> StoreFailed {
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
    db: Mutex<Connection>,
}

impl Store {
    pub fn open(home: &Path) -> Kept<Store> {
        let conn = open_db(home)?;
        conn.execute_batch(SCHEMA)?;
        Ok(Store { db: Mutex::new(conn) })
    }

    fn db(&self) -> MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn account(&self, id: ConnectorID) -> Kept<Option<Account>> {
        Ok(self
            .db()
            .query_row(
                "select secrets, user_id, pair_code, cursor, reply_context, last_inbound, paused_until, connected_at, channel_id
                 from connector_account where connector = ?1",
                [id.as_str()],
                |r| {
                    Ok(Account {
                        keys: Secret::new(r.get::<_, String>(0)?),
                        user: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                        pair_code: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                        cursor: r.get(3)?,
                        reply_context: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                        last_inbound: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                        paused_until: r.get::<_, Option<i64>>(6)?.unwrap_or(0),
                        connected_at: r.get(7)?,
                        channel: r.get::<_, Option<String>>(8)?.filter(|c| !c.is_empty()),
                    })
                },
            )
            .optional()?)
    }

    /// Connected again: what was kept of the account before goes, what waited is retired.
    pub fn connect(&self, id: ConnectorID, keys: &Secret, user: &str, pair_code: Option<&str>, at: i64, retired: &str) -> Kept<()> {
        let mut db = self.db();
        let tx = writing(&mut db)?;
        tx.execute(
            "insert into connector_account (connector, secrets, user_id, pair_code, connected_at) values (?1, ?2, ?3, ?4, ?5)
             on conflict (connector) do update set secrets = excluded.secrets, user_id = excluded.user_id, pair_code = excluded.pair_code,
               cursor = '', reply_context = null, last_inbound = null, paused_until = null, connected_at = excluded.connected_at",
            params![id.as_str(), keys.expose(), Some(user).filter(|u| !u.is_empty()), pair_code, at],
        )?;
        forget(&tx, id, retired)?;
        Ok(tx.commit()?)
    }

    pub fn disconnect(&self, id: ConnectorID, retired: &str) -> Kept<()> {
        let mut db = self.db();
        let tx = writing(&mut db)?;
        tx.execute("delete from connector_account where connector = ?1", [id.as_str()])?;
        forget(&tx, id, retired)?;
        Ok(tx.commit()?)
    }

    pub fn pause(&self, id: ConnectorID, until: Option<i64>) -> Kept<()> {
        self.db().execute(
            "update connector_account set paused_until = ?2 where connector = ?1",
            params![id.as_str(), until],
        )?;
        Ok(())
    }

    /// The user paired by `m`: it is the account's user from now on, and `m` is settled.
    pub fn paired(&self, id: ConnectorID, m: &Inbound, at: i64) -> Kept<()> {
        let mut db = self.db();
        let tx = writing(&mut db)?;
        tx.execute(
            "update connector_account set user_id = ?2, pair_code = null, reply_context = ?3, last_inbound = ?4 where connector = ?1",
            params![id.as_str(), m.from, Some(&m.reply).filter(|r| !r.is_empty()), at],
        )?;
        tx.execute(
            "update connector_inbound set delivered = 1, body = '' where connector = ?1 and ext_id = ?2",
            params![id.as_str(), m.id],
        )?;
        Ok(tx.commit()?)
    }

    pub fn replied(&self, id: ConnectorID, reply: &str, at: i64) -> Kept<()> {
        self.db().execute(
            "update connector_account set reply_context = ?2, last_inbound = ?3 where connector = ?1",
            params![id.as_str(), Some(reply).filter(|r| !r.is_empty()), at],
        )?;
        Ok(())
    }

    pub fn set_channel(&self, id: ConnectorID, channel: Option<&str>) -> Kept<()> {
        self.db().execute(
            "update connector_account set channel_id = ?2 where connector = ?1",
            params![id.as_str(), channel],
        )?;
        Ok(())
    }

    /// The accounts bridged to a channel: deleting it would take it from under them.
    pub fn accounts_in(&self, channel: &str) -> Kept<i64> {
        Ok(self
            .db()
            .query_row("select count(*) from connector_account where channel_id = ?1", [channel], |r| r.get(0))?)
    }

    /// Keeps what the app handed over, each once, and how far it read; false when the account is gone.
    pub fn accept(&self, id: ConnectorID, messages: &[Inbound], cursor: &str, at: i64) -> Kept<bool> {
        let mut db = self.db();
        let tx = writing(&mut db)?;
        let there: i64 = tx.query_row("select count(*) from connector_account where connector = ?1", [id.as_str()], |r| r.get(0))?;
        if there == 0 {
            return Ok(false);
        }
        for m in messages {
            tx.execute(
                "insert into connector_inbound (connector, ext_id, from_id, body, reply, quoted, created_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 on conflict (connector, ext_id) do nothing",
                params![id.as_str(), m.id, m.from, m.text, m.reply, m.quoted, at],
            )?;
        }
        if !cursor.is_empty() {
            tx.execute("update connector_account set cursor = ?2 where connector = ?1", params![id.as_str(), cursor])?;
        }
        tx.commit()?;
        Ok(true)
    }

    pub fn pending_inbound(&self, id: ConnectorID) -> Kept<Vec<Inbound>> {
        let db = self.db();
        let mut st =
            db.prepare_cached("select ext_id, from_id, body, reply, quoted from connector_inbound where connector = ?1 and delivered = 0 order by seq")?;
        let rows = st.query_map([id.as_str()], |r| {
            Ok(Inbound {
                id: r.get(0)?,
                from: r.get(1)?,
                text: r.get(2)?,
                reply: r.get(3)?,
                quoted: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Settled: the words are in the farm as `message`, or were not for it.
    pub fn delivered(&self, id: ConnectorID, ext: &str, message: Option<&str>) -> Kept<()> {
        self.db().execute(
            "update connector_inbound set delivered = 1, body = '', message_id = ?3 where connector = ?1 and ext_id = ?2",
            params![id.as_str(), ext, message],
        )?;
        Ok(())
    }

    pub fn add_outgoing(&self, id: ConnectorID, message: &str, pieces: &[String], at: i64) -> Kept<()> {
        let mut db = self.db();
        let tx = writing(&mut db)?;
        for piece in pieces {
            tx.execute(
                "insert into connector_outbox (connector, message_id, body, created_at) values (?1, ?2, ?3, ?4)",
                params![id.as_str(), message, piece, at],
            )?;
        }
        Ok(tx.commit()?)
    }

    /// What waits, in the order it was said.
    pub fn pending_outgoing(&self, id: ConnectorID) -> Kept<Vec<Outgoing>> {
        let db = self.db();
        let mut st = db.prepare_cached("select seq, message_id, body from connector_outbox where connector = ?1 and state = 'pending' order by seq")?;
        let rows = st.query_map([id.as_str()], |r| {
            Ok(Outgoing {
                seq: r.get(0)?,
                message: r.get(1)?,
                body: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn count_pending(&self, id: ConnectorID) -> Kept<i64> {
        Ok(self.db().query_row(
            "select count(*) from connector_outbox where connector = ?1 and state = 'pending'",
            [id.as_str()],
            |r| r.get(0),
        )?)
    }

    /// The user saw it in the farm, or it no longer stands: it does not go out.
    pub fn withdraw(&self, message: &str) -> Kept<()> {
        self.db().execute(
            "update connector_outbox set state = 'dropped', error = 'withdrawn' where message_id = ?1 and state = 'pending'",
            [message],
        )?;
        Ok(())
    }

    pub fn sent(&self, rows: &[i64], at: i64, ext: &str) -> Kept<()> {
        let mut db = self.db();
        let tx = writing(&mut db)?;
        for seq in rows {
            tx.execute(
                "update connector_outbox set state = 'sent', sent_at = ?2, ext_id = ?3, error = null where seq = ?1",
                params![seq, at, Some(ext).filter(|e| !e.is_empty())],
            )?;
        }
        Ok(tx.commit()?)
    }

    pub fn not_sent(&self, rows: &[i64], error: &str) -> Kept<()> {
        let db = self.db();
        for seq in rows {
            db.execute(
                "update connector_outbox set error = ?2 where seq = ?1",
                params![seq, Some(error).filter(|e| !e.is_empty())],
            )?;
        }
        Ok(())
    }

    /// The farm's message an app's id stands for: one this farm sent, or one it heard.
    pub fn message_of_ext(&self, id: ConnectorID, ext: &str) -> Kept<Option<String>> {
        Ok(self
            .db()
            .query_row(
                "select message_id from connector_outbox where connector = ?1 and ext_id = ?2
                 union all
                 select message_id from connector_inbound where connector = ?1 and ext_id = ?2 and message_id is not null
                 limit 1",
                params![id.as_str(), ext],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Drops what went through before `before`: a reply that old is not looked up.
    pub fn prune(&self, before: i64) -> Kept<()> {
        let db = self.db();
        db.execute("delete from connector_inbound where delivered = 1 and created_at < ?1", [before])?;
        db.execute("delete from connector_outbox where state <> 'pending' and created_at < ?1", [before])?;
        Ok(())
    }
}

/// A write transaction from its start: one that reads first and writes later is refused, not made to wait, when
/// another module's connection wrote in between.
fn writing(db: &mut Connection) -> rusqlite::Result<rusqlite::Transaction<'_>> {
    db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
}

fn forget(tx: &rusqlite::Transaction<'_>, id: ConnectorID, retired: &str) -> rusqlite::Result<()> {
    tx.execute("delete from connector_inbound where connector = ?1", [id.as_str()])?;
    tx.execute(
        "update connector_outbox set state = 'dropped', error = ?2 where connector = ?1 and state = 'pending'",
        params![id.as_str(), retired],
    )?;
    Ok(())
}
