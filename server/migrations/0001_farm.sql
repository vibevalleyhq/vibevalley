-- The farm's database: SQLite in $VIBEVALLEY_HOME/farm.db, one connection, one writer, so seq order is commit order.
-- The same tables as the removed TypeScript server's PostgreSQL migrations (apps/server/db/migrations in git history),
-- folded into their final shape: times are milliseconds since the epoch, JSON is text. Why each table is there: those
-- migrations' comments, and
-- .agents/notes/implemented/feature/2026-10-11-farm-group-chat.md.

create table participants (
  id         text primary key,
  kind       text not null check (kind in ('user', 'foreman', 'helper', 'system')),
  name       text not null,
  agent_id   text,
  runtime    text,
  joined_at  integer not null,
  left_at    integer,
  check ((kind = 'helper') = (agent_id is not null))
);

create table conversations (
  id            integer primary key autoincrement,
  kind          text not null check (kind in ('square', 'channel', 'thread')),
  parent_seq    integer unique references messages (seq),
  subject_kind  text check (subject_kind in ('job', 'playbook', 'talk')),
  subject_id    text,
  last_seq      integer,
  reply_count   integer not null default 0,
  created_at    integer not null,
  name          text,
  description   text,
  project       text,
  channel_id    integer references conversations (id),
  check ((kind = 'thread') = (parent_seq is not null)),
  check ((subject_kind is null) or kind = 'thread')
);
create unique index conversations_one_square on conversations (kind) where kind = 'square';
create index conversations_by_subject on conversations (subject_kind, subject_id);
create unique index conversations_by_name on conversations (name) where name is not null;

create table messages (
  seq              integer primary key autoincrement,
  conversation_id  integer not null references conversations (id),
  sender_id        text not null references participants (id),
  kind             text not null check (kind in ('chat', 'dispatch', 'report', 'notice')),
  body             text not null,
  final            integer not null default 1,
  meta             text,
  send_key         text,
  created_at       integer not null,
  updated_at       integer
);
create index messages_by_conversation on messages (conversation_id, seq);
create unique index messages_send_key on messages (sender_id, send_key) where send_key is not null;
create index messages_by_sender on messages (sender_id, seq);

create table mentions (
  message_seq  integer not null references messages (seq) on delete cascade,
  target_id    text not null,
  resolved     text not null check (resolved in ('delivered', 'not_on_farm', 'unknown')),
  primary key (message_seq, target_id)
);
create index mentions_by_target on mentions (target_id, message_seq);

create table follows (
  conversation_id  integer not null references conversations (id),
  participant_id   text not null references participants (id),
  reason           text not null check (reason in ('owner', 'replied', 'mentioned', 'manual')),
  from_seq         integer not null,
  unfollowed_at    integer,
  primary key (conversation_id, participant_id)
);

create table read_cursors (
  participant_id   text not null references participants (id),
  conversation_id  integer not null references conversations (id),
  read_seq         integer not null,
  updated_at       integer not null,
  primary key (participant_id, conversation_id)
);

create table seen_marks (
  participant_id  text not null references participants (id),
  message_seq     integer not null references messages (seq) on delete cascade,
  primary key (participant_id, message_seq)
);

create table deliveries (
  recipient_id   text not null references participants (id),
  message_seq    integer not null references messages (seq) on delete cascade,
  reason         text not null check (reason in ('mention', 'everyone', 'own_thread', 'follower', 'square', 'dispatch', 'addressed', 'playbook')),
  wakes          integer not null,
  held_by        text check (held_by in ('hop_limit', 'cooldown', 'wake_breaker')),
  state          text not null default 'pending' check (state in ('pending', 'announced', 'handed', 'seen', 'dropped')),
  session        text,
  announced_at   integer,
  handed_at      integer,
  seen_at        integer,
  dropped_why    text,
  created_at     integer not null,
  primary key (recipient_id, message_seq),
  check ((held_by is null) or wakes),
  check ((state in ('announced', 'handed')) = (session is not null) or state in ('seen', 'dropped'))
);
create index deliveries_open on deliveries (recipient_id, message_seq) where state in ('pending', 'announced', 'handed');

create table playbook_events (
  seq          integer primary key autoincrement,
  playbook_id  text not null,
  node_id      text,
  kind         text not null,
  actor        text not null check (actor in ('user', 'foreman', 'farm')),
  payload      text not null default '{}',
  created_at   integer not null
);
create index playbook_events_by_playbook on playbook_events (playbook_id, seq);

create table ledger (
  seq      integer primary key autoincrement,
  kind     text not null,
  at       integer not null,
  payload  text not null default '{}'
);

create table memories (
  id           integer primary key autoincrement,
  agent        text not null,
  kind         text not null,
  body         text not null,
  project      text,
  helper       text,
  created_at   integer not null,
  recalled     integer not null default 0,
  recalled_at  integer
);
create index memories_by_agent on memories (agent, created_at desc);
create unique index memories_one_job on memories (agent, helper) where kind = 'job';

create table connector_accounts (
  connector      text primary key check (connector in ('weixin', 'feishu', 'qq')),
  secrets        text not null,
  owner_id       text,
  pair_code      text,
  cursor         text not null default '',
  reply_context  text,
  reply_at       integer,
  last_inbound   integer,
  paused_until   integer,
  connected_at   integer not null,
  channel_id     integer references conversations (id)
);

create table connector_inbound (
  connector      text not null,
  ext_id         text not null,
  message_seq    integer references messages (seq) on delete set null,
  created_at     integer not null,
  primary key (connector, ext_id)
);

create table connector_outbox (
  id             integer primary key autoincrement,
  connector      text not null,
  message_seq    integer not null references messages (seq) on delete cascade,
  body           text not null,
  state          text not null default 'pending' check (state in ('pending', 'sent', 'dropped')),
  ext_id         text,
  tries          integer not null default 0,
  error          text,
  created_at     integer not null,
  sent_at        integer
);
create index connector_outbox_pending on connector_outbox (connector, id) where state = 'pending';
create index connector_outbox_by_ext on connector_outbox (connector, ext_id) where ext_id is not null;

create table schedules (
  id          integer primary key autoincrement,
  name        text not null,
  body        text not null,
  channel_id  integer not null references conversations (id) on delete cascade,
  agent       text,
  project     text,
  spec        text not null,
  tz          text not null,
  enabled     integer not null default 1,
  created_at  integer not null,
  last_run    integer
);
