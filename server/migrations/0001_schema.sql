-- The farm's database. A change to it is a new file after this one, run once at start in name order (internal/base/db.go).

-- The farm's chat: who takes part, channels and threads, messages and what becomes of each for each recipient (channel/).

create table participant (
  id         text primary key,
  kind       text not null check (kind in ('user', 'manager', 'worker', 'system')),
  name       text not null,
  agent_id   text,
  runtime    text,
  joined_at  integer not null,
  left_at    integer,
  check ((kind = 'worker') = (agent_id is not null))
);

create table conversation (
  id            integer primary key autoincrement,
  kind          text not null check (kind in ('general', 'channel', 'thread')),
  parent_seq    integer unique references message (seq),
  subject_kind  text check (subject_kind in ('issue', 'playbook', 'talk')),
  subject_id    text,
  last_seq      integer,
  reply_count   integer not null default 0,
  created_at    integer not null,
  name          text,
  description   text,
  project       text,
  channel_id    integer references conversation (id),
  check ((kind = 'thread') = (parent_seq is not null)),
  check ((subject_kind is null) or kind = 'thread')
);
create unique index conversation_one_general on conversation (kind) where kind = 'general';
create index conversation_by_subject on conversation (subject_kind, subject_id);
create unique index conversation_by_name on conversation (name) where name is not null;

create table message (
  seq              integer primary key autoincrement,
  conversation_id  integer not null references conversation (id),
  sender_id        text not null references participant (id),
  kind             text not null check (kind in ('chat', 'dispatch', 'report', 'notice')),
  body             text not null,
  final            boolean not null default 1,
  meta             text,
  send_key         text,
  created_at       integer not null,
  updated_at       integer
);
create index message_by_conversation on message (conversation_id, seq);
create unique index message_send_key on message (sender_id, send_key) where send_key is not null;
create index message_by_sender on message (sender_id, seq);

create table mention (
  message_seq  integer not null references message (seq) on delete cascade,
  target_id    text not null,
  resolved     text not null check (resolved in ('delivered', 'not_on_farm', 'unknown')),
  primary key (message_seq, target_id)
);
create index mention_by_target on mention (target_id, message_seq);

create table follow (
  conversation_id  integer not null references conversation (id),
  participant_id   text not null references participant (id),
  reason           text not null check (reason in ('owner', 'replied', 'mentioned', 'manual')),
  from_seq         integer not null,
  unfollowed_at    integer,
  primary key (conversation_id, participant_id)
);

create table read_cursor (
  participant_id   text not null references participant (id),
  conversation_id  integer not null references conversation (id),
  read_seq         integer not null,
  updated_at       integer not null,
  primary key (participant_id, conversation_id)
);

create table seen_mark (
  participant_id  text not null references participant (id),
  message_seq     integer not null references message (seq) on delete cascade,
  primary key (participant_id, message_seq)
);

create table delivery (
  recipient_id   text not null references participant (id),
  message_seq    integer not null references message (seq) on delete cascade,
  reason         text not null check (reason in ('mention', 'everyone', 'own_thread', 'follower', 'general', 'dispatch', 'addressed', 'playbook')),
  wakes          boolean not null,
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
create index delivery_open on delivery (recipient_id, message_seq) where state in ('pending', 'announced', 'handed');

-- Issues, the workers that worked them, and every run: one go at the work (issue/, worker/runs.go).

create table issue (
  id          text primary key,
  title       text not null default '',
  description text not null,
  project     text,
  assignee    text,
  priority    text not null default 'medium' check (priority in ('urgent', 'high', 'medium', 'low')),
  rank        integer not null default 0,
  parent      text references issue (id) on delete cascade,
  blocked_by  text,
  plan        text,
  step        text,
  schedule    integer,
  created_at  integer not null,
  queued_at   integer,
  closed_at   integer,
  closed      text check (closed in ('merged', 'merged_into_plan', 'dismissed', 'lost', 'answered'))
);
create index issue_by_parent on issue (parent);

create table issue_worker (
  worker         text primary key,
  issue       text not null references issue (id) on delete cascade,
  started_at  integer not null
);
create index issue_worker_by_issue on issue_worker (issue, started_at);

create table run (
  id           integer primary key,
  worker       text not null,
  issue        text,
  triggered_by text not null,
  heard        text,
  started_at   integer not null,
  ended_at     integer,
  outcome      text,
  summary      text,
  spent        text
);
create index run_by_issue on run (issue, started_at);
create index run_by_worker on run (worker, started_at);

-- What happened to each playbook (playbook/log.go).

create table playbook_event (
  seq          integer primary key autoincrement,
  playbook_id  text not null,
  node_id      text,
  kind         text not null,
  actor        text not null check (actor in ('user', 'manager', 'system')),
  payload      text not null default '{}',
  created_at   integer not null
);
create index playbook_event_by_playbook on playbook_event (playbook_id, seq);

-- Schedules (schedule/).

create table schedule (
  id          integer primary key autoincrement,
  name        text not null,
  body        text not null,
  channel_id  integer not null references conversation (id) on delete cascade,
  agent       text,
  project     text,
  spec        text not null,
  tz          text not null,
  enabled     boolean not null default 1,
  created_at  integer not null,
  last_run    integer
);

-- The ledger the progress is folded from (game/ledger.go).

create table ledger (
  seq      integer primary key autoincrement,
  kind     text not null,
  at       integer not null,
  payload  text not null default '{}'
);

-- What agents remember (memory/).

create table memory (
  id           integer primary key autoincrement,
  agent        text not null,
  kind         text not null,
  body         text not null,
  project      text,
  worker       text,
  created_at   integer not null,
  recalled     integer not null default 0,
  recalled_at  integer
);
create index memory_by_agent on memory (agent, created_at desc);
create unique index memory_one_issue on memory (agent, worker) where kind = 'issue';

-- Chat apps joined to channels (connector/).

create table connector_account (
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
  channel_id     integer references conversation (id)
);

create table connector_inbound (
  connector      text not null,
  ext_id         text not null,
  message_seq    integer references message (seq) on delete set null,
  created_at     integer not null,
  primary key (connector, ext_id)
);

create table connector_outbox (
  id             integer primary key autoincrement,
  connector      text not null,
  message_seq    integer not null references message (seq) on delete cascade,
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

-- The yard gate and the devices let in (gate/).

create table lan_gate (
  id    integer primary key check (id = 1),
  open  boolean not null
);

create table lan_device (
  id         text primary key,
  name       text not null,
  key_hash   text not null unique,
  paired_at  integer not null,
  last_seen  integer
);
