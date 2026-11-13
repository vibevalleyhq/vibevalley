//! The chat's tables and queries (VibeValley `db/migrations` and
//! `db/queries/channel*.sql`), on SQLite: times are integer milliseconds,
//! `greatest` is `max`, a JSON field is read with `json_extract`.

use rusqlite::{Connection, OptionalExtension, Row, params};

pub type Sql<T> = rusqlite::Result<T>;

pub const SCHEMA: &str = "
create table if not exists channel_participant (
  id text primary key,
  kind text not null check (kind in ('user', 'agent', 'system')),
  name text not null,
  agent_id text,
  home_id text,
  joined_at integer not null,
  left_at integer,
  check (kind = 'agent' or agent_id is null)
);
create table if not exists channel (
  id text primary key,
  type text not null check (type in ('channel', 'direct', 'thread')),
  is_default integer not null default 0,
  root_id text unique,
  root_number integer,
  subject_kind text check (subject_kind in ('issue', 'talk')),
  subject_id text,
  last_number integer,
  reply_count integer not null default 0,
  created_at integer not null,
  name text,
  description text,
  repo text,
  parent_id text references channel (id),
  peer_id text unique references channel_participant (id),
  revision integer not null default 0,
  category text,
  position integer,
  archived_at integer,
  notify text not null default 'all' check (notify in ('all', 'mentions', 'none'))
);
create table if not exists channel_message (
  id text primary key,
  channel_id text not null references channel (id),
  number integer not null,
  sender_id text not null references channel_participant (id),
  kind text not null check (kind in ('chat', 'dispatch', 'report', 'notice')),
  body text not null,
  meta text,
  send_key text,
  created_at integer not null,
  revision integer not null,
  reply_number integer,
  edited_at integer,
  deleted_at integer,
  pinned_at integer,
  reactions text,
  unique (channel_id, number),
  unique (channel_id, revision)
);
create table if not exists channel_mention (
  message_id text not null references channel_message (id) on delete cascade,
  target_id text not null,
  resolved text not null check (resolved in ('delivered', 'absent', 'unknown')),
  primary key (message_id, target_id)
);
create table if not exists channel_member (
  channel_id text not null references channel (id),
  participant_id text not null references channel_participant (id),
  reason text not null check (reason in ('user', 'replied', 'mentioned', 'manual')),
  from_number integer not null,
  left_at integer,
  primary key (channel_id, participant_id)
);
create table if not exists channel_read_cursor (
  participant_id text not null references channel_participant (id),
  channel_id text not null references channel (id),
  read_number integer not null,
  updated_at integer not null,
  primary key (participant_id, channel_id)
);
create table if not exists channel_seen (
  participant_id text not null references channel_participant (id),
  message_id text not null references channel_message (id) on delete cascade,
  seen_at integer not null,
  primary key (participant_id, message_id)
);
create table if not exists channel_event (
  seq integer primary key autoincrement,
  kind text not null check (kind in ('posted', 'removed')),
  channel_id text not null,
  message_id text not null,
  at integer not null
);
create table if not exists watch_cursor (
  name text primary key,
  seq integer not null
);
create unique index if not exists channel_by_name on channel (name) where name is not null and type <> 'thread';
create index if not exists channel_by_subject on channel (subject_kind, subject_id);
create unique index if not exists channel_one_default on channel (is_default) where is_default;
create index if not exists channel_by_parent on channel (parent_id) where parent_id is not null;
create index if not exists channel_mention_by_target on channel_mention (target_id, message_id);
create index if not exists channel_message_by_channel on channel_message (channel_id, number);
create index if not exists channel_message_by_sender on channel_message (sender_id, id);
create unique index if not exists channel_message_send_key on channel_message (sender_id, send_key) where send_key is not null;
create index if not exists channel_event_by_message on channel_event (message_id);
create index if not exists channel_member_by_participant on channel_member (participant_id);
create index if not exists channel_read_cursor_by_channel on channel_read_cursor (channel_id);
create index if not exists channel_seen_by_message on channel_seen (message_id);
";

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
    /// `emptyChannelRow`.
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

const CHANNEL_COLS: &str = "id, type, is_default, root_id, root_number, subject_kind, subject_id, last_number, reply_count, created_at, name, description, repo, parent_id, peer_id, revision, category, position, archived_at, notify";

fn channel_row(r: &Row) -> Sql<ChannelRow> {
    Ok(ChannelRow {
        id: r.get(0)?,
        r#type: r.get(1)?,
        is_default: r.get(2)?,
        root_id: r.get(3)?,
        root_number: r.get(4)?,
        subject_kind: r.get(5)?,
        subject_id: r.get(6)?,
        last_number: r.get(7)?,
        reply_count: r.get(8)?,
        created_at: r.get(9)?,
        name: r.get(10)?,
        description: r.get(11)?,
        repo: r.get(12)?,
        parent_id: r.get(13)?,
        peer_id: r.get(14)?,
        revision: r.get(15)?,
        category: r.get(16)?,
        position: r.get(17)?,
        archived_at: r.get(18)?,
        notify: r.get(19)?,
    })
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

/// A message with where it was said (`UserMentions`, `SearchMessages`).
#[derive(Debug, Clone)]
pub struct PlacedRow {
    pub row: MsgRow,
    pub channel_type: String,
    pub root_number: Option<i64>,
    pub top_id: String,
    pub channel_name: String,
}

const MSG: &str = "select m.id, m.channel_id, m.number, m.sender_id, m.kind, m.body, m.meta, m.send_key, m.created_at, m.revision, m.reply_number, m.edited_at, m.deleted_at, m.pinned_at, m.reactions, p.name, p.kind, p.agent_id";
const MSG_FROM: &str = "from channel_message m join channel_participant p on p.id = m.sender_id";

fn msg_row(r: &Row) -> Sql<MsgRow> {
    Ok(MsgRow {
        id: r.get(0)?,
        channel_id: r.get(1)?,
        number: r.get(2)?,
        sender_id: r.get(3)?,
        kind: r.get(4)?,
        body: r.get(5)?,
        meta: r.get(6)?,
        send_key: r.get(7)?,
        created_at: r.get(8)?,
        revision: r.get(9)?,
        reply_number: r.get(10)?,
        edited_at: r.get(11)?,
        deleted_at: r.get(12)?,
        pinned_at: r.get(13)?,
        reactions: r.get(14)?,
        sender_name: r.get(15)?,
        sender_kind: r.get(16)?,
        sender_agent: r.get(17)?,
    })
}

fn placed_row(r: &Row) -> Sql<PlacedRow> {
    Ok(PlacedRow {
        row: msg_row(r)?,
        channel_type: r.get(18)?,
        root_number: r.get(19)?,
        top_id: r.get(20)?,
        channel_name: r.get(21)?,
    })
}

fn msgs(db: &Connection, tail: &str, p: impl rusqlite::Params) -> Sql<Vec<MsgRow>> {
    let mut st = db.prepare_cached(&format!("{MSG} {MSG_FROM} {tail}"))?;
    st.query_map(p, msg_row)?.collect()
}

fn msg(db: &Connection, tail: &str, p: impl rusqlite::Params) -> Sql<Option<MsgRow>> {
    db.query_row(&format!("{MSG} {MSG_FROM} {tail}"), p, msg_row).optional()
}

// ----- channel.sql -----

pub fn default_id(db: &Connection) -> Sql<Option<String>> {
    db.query_row("select id from channel where is_default", [], |r| r.get(0)).optional()
}

pub fn create_channel(db: &Connection, id: &str, is_default: bool, name: &str, description: Option<&str>, repo: Option<&str>, at: i64) -> Sql<()> {
    db.execute(
        "insert into channel (id, type, is_default, name, description, repo, created_at) values (?1, 'channel', ?2, ?3, ?4, ?5, ?6)",
        params![id, is_default, name, description, repo, at],
    )?;
    Ok(())
}

pub fn create_direct(db: &Connection, id: &str, peer: &str, at: i64) -> Sql<()> {
    db.execute(
        "insert into channel (id, type, peer_id, created_at) values (?1, 'direct', ?2, ?3) on conflict (peer_id) do nothing",
        params![id, peer, at],
    )?;
    Ok(())
}

pub fn clear_default(db: &Connection) -> Sql<()> {
    db.execute("update channel set is_default = 0 where is_default", [])?;
    Ok(())
}

pub fn make_default(db: &Connection, id: &str) -> Sql<()> {
    db.execute("update channel set is_default = 1 where id = ?1 and type = 'channel'", [id])?;
    Ok(())
}

pub fn update_channel(db: &Connection, id: &str, description: Option<&str>, repo: Option<&str>) -> Sql<()> {
    db.execute(
        "update channel set description = ?1, repo = ?2 where id = ?3 and type = 'channel'",
        params![description, repo, id],
    )?;
    Ok(())
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
    db.execute(
        "insert into channel (id, type, root_id, root_number, subject_kind, subject_id, parent_id, created_at) values (?1, 'thread', ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, root_id, root_number, subject_kind, subject_id, parent_id, at],
    )?;
    Ok(())
}

pub fn all_channels(db: &Connection) -> Sql<Vec<ChannelRow>> {
    let mut st = db.prepare(&format!("select {CHANNEL_COLS} from channel order by id"))?;
    st.query_map([], channel_row)?.collect()
}

pub fn recent_channels(db: &Connection, n: i64) -> Sql<Vec<ChannelRow>> {
    let mut st = db.prepare(&format!(
        "select {CHANNEL_COLS} from channel order by coalesce(last_number, 0) desc, id desc limit ?1"
    ))?;
    st.query_map([n], channel_row)?.collect()
}

pub fn touch_channel(db: &Connection, id: &str, number: i64) -> Sql<()> {
    db.execute(
        "update channel set last_number = max(coalesce(last_number, 0), ?1),
           reply_count = reply_count + case when type = 'thread' then 1 else 0 end where id = ?2",
        params![number, id],
    )?;
    Ok(())
}

pub struct UnreadRow {
    pub r#type: String,
    pub root_number: Option<i64>,
    pub channel_name: String,
    pub unread: i64,
    pub mentions_you: bool,
    pub latest_sender_name: Option<String>,
}

/// `UnreadOf`: a participant's unread, the channel it is in and the
/// threads it follows, newest first, at most 20.
pub fn unread_of(db: &Connection, participant: &str, channel: &str) -> Sql<Vec<UnreadRow>> {
    let mut st = db.prepare_cached(
        "with unread as (
           select c.id, c.type, c.root_number, coalesce(ch.name, c.name, '') as channel_name,
                  count(m.id) as unread,
                  max(exists (select 1 from channel_mention x where x.message_id = m.id and x.target_id = ?1)) as mentions_you,
                  coalesce(max(m.number), 0) as latest
           from channel c
           left join channel ch on ch.id = c.parent_id
           join channel_message m on m.channel_id = c.id
           left join channel_read_cursor rc on rc.participant_id = ?1 and rc.channel_id = c.id
           left join channel_member f on f.channel_id = c.id and f.participant_id = ?1 and f.left_at is null
           where m.sender_id <> ?1 and m.kind <> 'notice'
             and (c.id = ?2 or f.participant_id is not null)
             and m.number > max(coalesce(rc.read_number, 0), coalesce(f.from_number, 0))
             and not exists (select 1 from channel_seen s where s.participant_id = ?1 and s.message_id = m.id)
           group by c.id, ch.name
         )
         select u.type, u.root_number, u.channel_name, u.unread, u.mentions_you,
                (select p.name from channel_message lm join channel_participant p on p.id = lm.sender_id
                 where lm.channel_id = u.id and lm.number = u.latest)
         from unread u order by u.latest desc limit 20",
    )?;
    st.query_map(params![participant, channel], |r| {
        Ok(UnreadRow {
            r#type: r.get(0)?,
            root_number: r.get(1)?,
            channel_name: r.get(2)?,
            unread: r.get(3)?,
            mentions_you: r.get(4)?,
            latest_sender_name: r.get(5)?,
        })
    })?
    .collect()
}

pub fn bump_revision(db: &Connection, id: &str) -> Sql<i64> {
    db.query_row("update channel set revision = revision + 1 where id = ?1 returning revision", [id], |r| {
        r.get(0)
    })
}

pub fn rename_channel(db: &Connection, id: &str, name: Option<&str>) -> Sql<()> {
    db.execute("update channel set name = ?1 where id = ?2 and type <> 'direct'", params![name, id])?;
    Ok(())
}

pub fn set_category(db: &Connection, id: &str, category: Option<&str>) -> Sql<()> {
    db.execute("update channel set category = ?1 where id = ?2 and type = 'channel'", params![category, id])?;
    Ok(())
}

pub fn place_channel(db: &Connection, id: &str, position: i64) -> Sql<()> {
    db.execute("update channel set position = ?1 where id = ?2", params![position, id])?;
    Ok(())
}

pub fn set_archived(db: &Connection, id: &str, at: Option<i64>) -> Sql<()> {
    db.execute("update channel set archived_at = ?1 where id = ?2 and not is_default", params![at, id])?;
    Ok(())
}

pub fn set_notify(db: &Connection, id: &str, notify: &str) -> Sql<()> {
    db.execute("update channel set notify = ?1 where id = ?2", params![notify, id])?;
    Ok(())
}

pub fn topic_threads_in(db: &Connection, id: &str) -> Sql<i64> {
    db.query_row(
        "select count(*) from channel t where t.parent_id = ?1 and t.subject_kind = 'issue'",
        [id],
        |r| r.get(0),
    )
}

/// A channel deleted with its threads, what was said in them, their
/// members and read cursors (`deleteChannel` in store.ts, in its order).
pub fn delete_channel(db: &Connection, id: &str) -> Sql<()> {
    let threads = "select t.id from channel t where t.parent_id = ?1";
    db.execute(&format!("delete from channel_message where channel_id in ({threads})"), [id])?;
    db.execute(&format!("delete from channel_member where channel_id = ?1 or channel_id in ({threads})"), [id])?;
    db.execute(
        &format!("delete from channel_read_cursor where channel_id = ?1 or channel_id in ({threads})"),
        [id],
    )?;
    db.execute("delete from channel where parent_id = ?1", [id])?;
    db.execute("delete from channel_message where channel_id = ?1", [id])?;
    db.execute("delete from channel where id = ?1 and not is_default", [id])?;
    Ok(())
}

// ----- channel_participant.sql -----

pub fn upsert_participant(db: &Connection, p: &ParticipantRow) -> Sql<()> {
    db.execute(
        "insert into channel_participant (id, kind, name, agent_id, home_id, joined_at) values (?1, ?2, ?3, ?4, ?5, ?6)
         on conflict (id) do update set name = excluded.name, agent_id = excluded.agent_id,
           home_id = coalesce(excluded.home_id, channel_participant.home_id), left_at = null",
        params![p.id, p.kind, p.name, p.agent_id, p.home_id, p.joined_at],
    )?;
    Ok(())
}

pub fn add_participant(db: &Connection, id: &str, kind: &str, name: &str, at: i64) -> Sql<()> {
    db.execute(
        "insert into channel_participant (id, kind, name, joined_at) values (?1, ?2, ?3, ?4) on conflict (id) do nothing",
        params![id, kind, name, at],
    )?;
    Ok(())
}

pub fn participant_left(db: &Connection, id: &str, at: i64) -> Sql<()> {
    db.execute("update channel_participant set left_at = ?1 where id = ?2 and left_at is null", params![at, id])?;
    Ok(())
}

pub fn participants(db: &Connection) -> Sql<Vec<ParticipantRow>> {
    let mut st = db.prepare("select id, kind, name, agent_id, home_id, joined_at, left_at from channel_participant order by joined_at, rowid")?;
    st.query_map([], |r| {
        Ok(ParticipantRow {
            id: r.get(0)?,
            kind: r.get(1)?,
            name: r.get(2)?,
            agent_id: r.get(3)?,
            home_id: r.get(4)?,
            joined_at: r.get(5)?,
            left_at: r.get(6)?,
        })
    })?
    .collect()
}

// ----- channel_member.sql -----

pub fn add_member(db: &Connection, channel: &str, participant: &str, reason: &str, from: i64) -> Sql<()> {
    db.execute(
        "insert into channel_member (channel_id, participant_id, reason, from_number) values (?1, ?2, ?3, ?4)
         on conflict (channel_id, participant_id) do update set left_at = null",
        params![channel, participant, reason, from],
    )?;
    Ok(())
}

pub fn remove_member(db: &Connection, channel: &str, participant: &str, at: i64) -> Sql<()> {
    db.execute(
        "update channel_member set left_at = ?1 where channel_id = ?2 and participant_id = ?3 and left_at is null",
        params![at, channel, participant],
    )?;
    Ok(())
}

pub fn all_members(db: &Connection) -> Sql<Vec<(String, String)>> {
    let mut st = db.prepare("select channel_id, participant_id from channel_member where left_at is null")?;
    st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect()
}

pub fn remove_from_all(db: &Connection, participant: &str, at: i64) -> Sql<()> {
    db.execute(
        "update channel_member set left_at = ?1 where participant_id = ?2 and left_at is null",
        params![at, participant],
    )?;
    Ok(())
}

// ----- channel_mention.sql, channel_seen.sql -----

pub fn insert_mention(db: &Connection, message: &str, target: &str, resolved: &str) -> Sql<()> {
    db.execute(
        "insert into channel_mention (message_id, target_id, resolved) values (?1, ?2, ?3) on conflict do nothing",
        params![message, target, resolved],
    )?;
    Ok(())
}

pub fn mark_seen(db: &Connection, participant: &str, message: &str, at: i64) -> Sql<()> {
    db.execute(
        "insert into channel_seen (participant_id, message_id, seen_at)
         select p.id, m.id, ?3 from channel_message m, channel_participant p where m.id = ?2 and p.id = ?1
         on conflict do nothing",
        params![participant, message, at],
    )?;
    Ok(())
}

// ----- channel_read_cursor.sql -----

pub fn set_read_cursor(db: &Connection, participant: &str, channel: &str, upto: i64, at: i64) -> Sql<()> {
    db.execute(
        "insert into channel_read_cursor (participant_id, channel_id, read_number, updated_at) values (?1, ?2, ?3, ?4)
         on conflict (participant_id, channel_id) do update set
           read_number = max(channel_read_cursor.read_number, excluded.read_number), updated_at = excluded.updated_at",
        params![participant, channel, upto, at],
    )?;
    Ok(())
}

pub fn read_cursor(db: &Connection, participant: &str, channel: &str) -> Sql<Option<i64>> {
    db.query_row(
        "select read_number from channel_read_cursor where participant_id = ?1 and channel_id = ?2",
        params![participant, channel],
        |r| r.get(0),
    )
    .optional()
}

pub fn read_cursors_of(db: &Connection, participant: &str) -> Sql<Vec<(String, i64)>> {
    let mut st = db.prepare("select channel_id, read_number from channel_read_cursor where participant_id = ?1")?;
    st.query_map([participant], |r| Ok((r.get(0)?, r.get(1)?)))?.collect()
}

pub fn mark_unread(db: &Connection, channel: &str, upto: i64, at: i64) -> Sql<()> {
    db.execute(
        "insert into channel_read_cursor (participant_id, channel_id, read_number, updated_at) values ('user', ?1, ?2, ?3)
         on conflict (participant_id, channel_id) do update set read_number = excluded.read_number, updated_at = excluded.updated_at",
        params![channel, upto, at],
    )?;
    Ok(())
}

// ----- channel_event.sql -----

#[derive(Debug, Clone, PartialEq)]
pub struct EventRow {
    pub seq: i64,
    pub kind: String,
    pub channel_id: String,
    pub message_id: String,
    pub at: i64,
}

pub fn insert_event(db: &Connection, kind: &str, channel: &str, message: &str, at: i64) -> Sql<i64> {
    db.query_row(
        "insert into channel_event (kind, channel_id, message_id, at) values (?1, ?2, ?3, ?4) returning seq",
        params![kind, channel, message, at],
        |r| r.get(0),
    )
}

fn event_row(r: &Row) -> Sql<EventRow> {
    Ok(EventRow {
        seq: r.get(0)?,
        kind: r.get(1)?,
        channel_id: r.get(2)?,
        message_id: r.get(3)?,
        at: r.get(4)?,
    })
}

pub fn events_after(db: &Connection, after: i64, n: i64) -> Sql<Vec<EventRow>> {
    let mut st = db.prepare_cached("select seq, kind, channel_id, message_id, at from channel_event where seq > ?1 order by seq limit ?2")?;
    st.query_map(params![after, n], event_row)?.collect()
}

pub fn event_of(db: &Connection, message: &str) -> Sql<Option<EventRow>> {
    db.query_row(
        "select seq, kind, channel_id, message_id, at from channel_event where message_id = ?1 and kind = 'posted'",
        [message],
        event_row,
    )
    .optional()
}

// ----- channel_message.sql -----

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
    db.query_row(
        "insert into channel_message (id, channel_id, number, sender_id, kind, body, meta, send_key, created_at, revision, reply_number)
         values (?1, ?2, (select coalesce(max(number), 0) + 1 from channel_message where channel_id = ?2), ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         returning number",
        params![id, channel, sender, kind, body, meta, send_key, at, revision, reply_number],
        |r| r.get(0),
    )
}

pub fn update_message_meta(db: &Connection, id: &str, meta: Option<&str>) -> Sql<()> {
    db.execute("update channel_message set meta = ?1 where id = ?2", params![meta, id])?;
    Ok(())
}

pub fn message_by_id(db: &Connection, id: &str) -> Sql<Option<MsgRow>> {
    msg(db, "where m.id = ?1", [id])
}

pub fn message_by_send_key(db: &Connection, sender: &str, key: &str) -> Sql<Option<MsgRow>> {
    msg(db, "where m.sender_id = ?1 and m.send_key = ?2", params![sender, key])
}

pub fn message_by_number(db: &Connection, channel: &str, number: i64) -> Sql<Option<MsgRow>> {
    msg(db, "where m.channel_id = ?1 and m.number = ?2", params![channel, number])
}

const PLACED: &str = ", c.type, c.root_number, coalesce(c.parent_id, c.id), coalesce(ch.name, c.name, '')";

/// `UserMentions`: the user's mentions not read or answered yet.
pub fn user_mentions(db: &Connection) -> Sql<Vec<PlacedRow>> {
    let mut st = db.prepare_cached(&format!(
        "{MSG}{PLACED}
         from channel_mention n
         join channel_message m on m.id = n.message_id
         join channel_participant p on p.id = m.sender_id
         join channel c on c.id = m.channel_id
         left join channel ch on ch.id = c.parent_id
         left join channel_read_cursor r on r.participant_id = 'user' and r.channel_id = c.id
         where n.target_id = 'user' and m.sender_id <> 'user'
           and m.number > coalesce(r.read_number, 0)
           and not exists (select 1 from channel_message reply where reply.channel_id = c.id and reply.sender_id = 'user' and reply.number > m.number)
         order by m.id"
    ))?;
    st.query_map([], placed_row)?.collect()
}

/// Newest first.
pub fn messages_before(db: &Connection, channel: &str, number: i64, n: i64) -> Sql<Vec<MsgRow>> {
    msgs(
        db,
        "where m.channel_id = ?1 and m.number < ?2 order by m.number desc limit ?3",
        params![channel, number, n],
    )
}

pub fn messages_after(db: &Connection, channel: &str, number: i64, n: i64) -> Sql<Vec<MsgRow>> {
    msgs(
        db,
        "where m.channel_id = ?1 and m.number > ?2 order by m.number limit ?3",
        params![channel, number, n],
    )
}

pub fn recent_reports(db: &Connection, n: i64) -> Sql<Vec<MsgRow>> {
    msgs(db, "where m.kind = 'report' order by m.id desc limit ?1", [n])
}

pub fn reports_after(db: &Connection, after: &str, n: i64) -> Sql<Vec<MsgRow>> {
    msgs(db, "where m.kind = 'report' and m.id > ?1 order by m.id limit ?2", params![after, n])
}

pub fn recent_duplicate(db: &Connection, sender: &str, channel: &str, body: &str, since: i64) -> Sql<Option<String>> {
    db.query_row(
        "select id from channel_message where sender_id = ?1 and channel_id = ?2 and body = ?3 and created_at > ?4 order by id desc limit 1",
        params![sender, channel, body, since],
        |r| r.get(0),
    )
    .optional()
}

pub fn dispatches_in(db: &Connection, channel: &str) -> Sql<i64> {
    db.query_row(
        "select count(*) from channel_message where channel_id = ?1 and kind = 'dispatch'",
        [channel],
        |r| r.get(0),
    )
}

pub fn user_unread(db: &Connection, channel: &str, read: i64) -> Sql<i64> {
    db.query_row(
        "select count(*) from channel_message where channel_id = ?1 and number > ?2 and sender_id <> 'user' and kind <> 'notice' and deleted_at is null",
        params![channel, read],
        |r| r.get(0),
    )
}

pub fn latest_number(db: &Connection, channel: &str) -> Sql<i64> {
    db.query_row("select coalesce(max(number), 0) from channel_message where channel_id = ?1", [channel], |r| {
        r.get(0)
    })
}

/// `CallersOf`: who @-ed the speaker here since it last spoke, before a
/// message, newest first.
pub fn callers_of(db: &Connection, speaker: &str, channel: &str, before: &str, n: i64) -> Sql<Vec<String>> {
    let mut st = db.prepare_cached(
        "select m.sender_id from channel_message m
         join channel_mention n on n.message_id = m.id and n.target_id = ?1
         where m.channel_id = ?2 and m.sender_id <> ?1 and m.id < ?3
           and m.id > coalesce((select max(s.id) from channel_message s where s.channel_id = ?2 and s.sender_id = ?1 and s.id < ?3), '')
         order by m.id desc limit ?4",
    )?;
    st.query_map(params![speaker, channel, before, n], |r| r.get(0))?.collect()
}

pub fn unseen_in(db: &Connection, channel: &str, participant: &str) -> Sql<Vec<String>> {
    let mut st = db.prepare_cached(
        "select m.id from channel_message m
         where m.channel_id = ?1 and m.sender_id <> ?2
           and m.number > coalesce((select read_number from channel_read_cursor where participant_id = ?2 and channel_id = ?1), 0)
           and not exists (select 1 from channel_seen s where s.participant_id = ?2 and s.message_id = m.id)
         order by m.number",
    )?;
    st.query_map(params![channel, participant], |r| r.get(0))?.collect()
}

pub fn notice_since_user(db: &Connection, channel: &str, code: &str) -> Sql<i64> {
    db.query_row(
        "select count(*) from channel_message m
         where m.channel_id = ?1 and m.sender_id = 'system' and json_extract(m.meta, '$.code') = ?2
           and m.id > coalesce((select max(u.id) from channel_message u where u.channel_id = ?1 and u.sender_id = 'user'), '')",
        params![channel, code],
        |r| r.get(0),
    )
}

pub fn messages_changed_after(db: &Connection, channel: &str, revision: i64, n: i64) -> Sql<Vec<MsgRow>> {
    msgs(
        db,
        "where m.channel_id = ?1 and m.revision > ?2 order by m.revision limit ?3",
        params![channel, revision, n],
    )
}

pub fn edit_message(db: &Connection, id: &str, body: &str, at: i64, revision: i64) -> Sql<()> {
    db.execute(
        "update channel_message set body = ?1, edited_at = ?2, revision = ?3 where id = ?4",
        params![body, at, revision, id],
    )?;
    Ok(())
}

pub fn delete_message(db: &Connection, id: &str, at: i64, revision: i64) -> Sql<()> {
    db.execute(
        "update channel_message set body = '', meta = null, reactions = null, deleted_at = ?1, revision = ?2 where id = ?3",
        params![at, revision, id],
    )?;
    Ok(())
}

pub fn set_reactions(db: &Connection, id: &str, reactions: Option<&str>, revision: i64) -> Sql<()> {
    db.execute(
        "update channel_message set reactions = ?1, revision = ?2 where id = ?3",
        params![reactions, revision, id],
    )?;
    Ok(())
}

pub fn set_pinned(db: &Connection, id: &str, at: Option<i64>, revision: i64) -> Sql<()> {
    db.execute(
        "update channel_message set pinned_at = ?1, revision = ?2 where id = ?3",
        params![at, revision, id],
    )?;
    Ok(())
}

/// `SetEmbeds`, also how a message's meta changes as a change.
pub fn set_meta(db: &Connection, id: &str, meta: Option<&str>, revision: i64) -> Sql<()> {
    db.execute("update channel_message set meta = ?1, revision = ?2 where id = ?3", params![meta, revision, id])?;
    Ok(())
}

pub fn pinned_in(db: &Connection, channel: &str) -> Sql<Vec<MsgRow>> {
    msgs(db, "where m.channel_id = ?1 and m.pinned_at is not null order by m.pinned_at desc", [channel])
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

/// `SearchMessages`: newest first.
pub fn search_messages(db: &Connection, q: &SearchParams) -> Sql<Vec<PlacedRow>> {
    let mut st = db.prepare_cached(&format!(
        "{MSG}{PLACED}
         from channel_message m
         join channel_participant p on p.id = m.sender_id
         join channel c on c.id = m.channel_id
         left join channel ch on ch.id = c.parent_id
         where m.deleted_at is null and m.kind <> 'notice'
           and (?1 = '' or instr(lower(m.body), lower(?1)) > 0)
           and (?2 = '' or c.id = ?2 or c.parent_id = ?2)
           and (?3 = '' or m.sender_id = ?3 or lower(p.name) = lower(?3))
           and (not ?4 or instr(coalesce(m.meta, ''), '\"attachments\"') > 0)
           and (not ?5 or instr(coalesce(m.meta, ''), '\"type\":\"image/') > 0)
           and (not ?6 or instr(m.body, 'http://') > 0 or instr(m.body, 'https://') > 0)
           and m.created_at >= ?7 and m.created_at < ?8
         order by m.id desc limit ?9"
    ))?;
    st.query_map(
        params![q.text, q.channel, q.sender, q.has_file, q.has_image, q.has_link, q.after, q.before, q.n],
        placed_row,
    )?
    .collect()
}

/// `NotificationReceipt`: when the user read it, and whether a later
/// message there took its place.
pub fn notification_receipt(db: &Connection, id: &str) -> Sql<Option<(Option<i64>, bool)>> {
    db.query_row(
        "select r.updated_at,
           exists (select 1 from channel_message n where n.channel_id = m.channel_id and n.number > m.number
             and n.deleted_at is null and (n.sender_id = 'user' or (m.kind = 'report' and n.kind = 'report' and n.sender_id = m.sender_id)))
         from channel_message m
         left join channel_read_cursor r on r.channel_id = m.channel_id and r.participant_id = 'user' and r.read_number >= m.number
         where m.id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
}

/// `UserReadReports`: each speaker's latest report the user has read.
pub fn user_read_reports(db: &Connection) -> Sql<Vec<(String, i64, i64)>> {
    let mut st = db.prepare_cached(
        "select m.sender_id, m.created_at, r.updated_at from channel_message m
         join channel_read_cursor r on r.channel_id = m.channel_id and r.participant_id = 'user' and r.read_number >= m.number
         where m.kind = 'report' and m.deleted_at is null
           and not exists (select 1 from channel_message n where n.channel_id = m.channel_id and n.sender_id = m.sender_id and n.kind = 'report' and n.number > m.number)",
    )?;
    st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect()
}

/// `watch_cursor.sql`: how far a reader of the events has handled them.
pub fn cursor_of(db: &Connection, name: &str) -> Sql<i64> {
    db.query_row("select seq from watch_cursor where name = ?1", params![name], |r| r.get(0))
        .optional()
        .map(|s| s.unwrap_or(0))
}

pub fn move_cursor(db: &Connection, name: &str, seq: i64) -> Sql<()> {
    db.execute(
        "insert into watch_cursor (name, seq) values (?1, ?2) on conflict (name) do update set seq = max(seq, excluded.seq)",
        params![name, seq],
    )
    .map(|_| ())
}
