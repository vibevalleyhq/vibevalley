-- The schema as it stands after the ids became uuidv7 (2026-10-17), as one baseline: every row the server makes has a
-- text uuidv7 primary key; chat messages carry a number inside their conversation for the #channel:number address, and
-- issues carry a number of their own. There is no upgrade path: the TypeScript farm is re-imported into this shape.

CREATE TABLE channel_conversation (
  id            text primary key,
  kind          text not null check (kind in ('general', 'channel', 'thread')),
  parent_id     text unique references channel_message (id),
  parent_number integer,
  subject_kind  text check (subject_kind in ('issue', 'playbook', 'talk')),
  subject_id    text,
  last_number   integer,
  reply_count   integer not null default 0,
  created_at    integer not null,
  name          text,
  description   text,
  project       text,
  channel_id    text references channel_conversation (id),
  check ((kind = 'thread') = (parent_id is not null)),
  check ((subject_kind is null) or kind = 'thread')
);
CREATE TABLE channel_message (
  id              text primary key,
  conversation_id text not null references channel_conversation (id),
  number          integer not null,
  sender_id       text not null references channel_participant (id),
  kind            text not null check (kind in ('chat', 'dispatch', 'report', 'notice')),
  body            text not null,
  final           boolean not null default 1,
  meta            text,
  send_key        text,
  created_at      integer not null,
  updated_at      integer,
  unique (conversation_id, number)
);
CREATE TABLE channel_mention (
  message_id  text not null references channel_message (id) on delete cascade,
  target_id   text not null,
  resolved    text not null check (resolved in ('delivered', 'not_on_farm', 'unknown')),
  primary key (message_id, target_id)
);
CREATE TABLE channel_follow (
  conversation_id  text not null references channel_conversation (id),
  participant_id   text not null references channel_participant (id),
  reason           text not null check (reason in ('owner', 'replied', 'mentioned', 'manual')),
  from_number      integer not null,
  unfollowed_at    integer,
  primary key (conversation_id, participant_id)
);
CREATE TABLE channel_read_cursor (
  participant_id   text not null references channel_participant (id),
  conversation_id  text not null references channel_conversation (id),
  read_number      integer not null,
  updated_at       integer not null,
  primary key (participant_id, conversation_id)
);
CREATE TABLE channel_seen_mark (
  participant_id  text not null references channel_participant (id),
  message_id      text not null references channel_message (id) on delete cascade,
  primary key (participant_id, message_id)
);
CREATE TABLE channel_delivery (
  recipient_id   text not null references channel_participant (id),
  message_id     text not null references channel_message (id) on delete cascade,
  reason         text not null check (reason in ('mention', 'everyone', 'own_thread', 'follower', 'general', 'dispatch', 'addressed', 'playbook')),
  wakes          boolean not null,
  held_by        text check (held_by in ('hop_limit', 'cooldown', 'wake_breaker')),
  state          text not null default 'pending' check (state in ('pending', 'announced', 'handed', 'seen', 'dropped')),
  launch         text,
  announced_at   integer,
  handed_at      integer,
  seen_at        integer,
  dropped_why    text,
  created_at     integer not null,
  primary key (recipient_id, message_id),
  check ((held_by is null) or wakes),
  check ((state in ('announced', 'handed')) = (launch is not null) or state in ('seen', 'dropped'))
);
CREATE TABLE issue (
  id          text primary key,
  number      integer not null unique,
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
  schedule    text,
  created_at  integer not null,
  queued_at   integer,
  closed_at   integer,
  closed      text check (closed in ('merged', 'merged_into_plan', 'dismissed', 'lost', 'answered'))
);
CREATE INDEX issue_by_parent on issue (parent);
CREATE TABLE issue_session (
  session         text primary key,
  issue           text not null references issue (id) on delete cascade,
  started_at      integer not null
);
CREATE TABLE session_run (
  id           text primary key,
  session      text not null,
  issue        text,
  triggered_by text not null,
  heard        text,
  started_at   integer not null,
  ended_at     integer,
  outcome      text,
  summary      text,
  spent        text
);
CREATE TABLE playbook_event (
  id          text primary key,
  playbook_id text not null,
  node_id     text,
  kind        text not null,
  actor       text not null check (actor in ('user', 'manager', 'system')),
  payload     text not null default '{}',
  created_at  integer not null
);
CREATE INDEX playbook_event_by_playbook on playbook_event (playbook_id, id);
CREATE TABLE schedule (
  id          text primary key,
  name        text not null,
  body        text not null,
  channel_id  text not null references channel_conversation (id) on delete cascade,
  agent       text,
  project     text,
  spec        text not null,
  tz          text not null,
  enabled     boolean not null default 1,
  created_at  integer not null,
  last_run    integer
);
CREATE TABLE game_ledger (
  id      text primary key,
  kind    text not null,
  at      integer not null,
  payload text not null default '{}'
);
CREATE TABLE memory (
  id           text primary key,
  agent        text not null,
  kind         text not null,
  body         text not null,
  project      text,
  session      text,
  created_at   integer not null,
  recalled     integer not null default 0,
  recalled_at  integer
);
CREATE INDEX memory_by_agent on memory (agent, created_at desc);
CREATE UNIQUE INDEX memory_one_issue on memory (agent, session) where kind = 'issue';
CREATE TABLE connector_account (
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
  channel_id     text references channel_conversation (id)
);
CREATE TABLE connector_inbound (
  connector   text not null,
  ext_id      text not null,
  message_id  text references channel_message (id) on delete set null,
  created_at  integer not null,
  primary key (connector, ext_id)
);
CREATE TABLE connector_outbox (
  id          text primary key,
  connector   text not null,
  message_id  text not null references channel_message (id) on delete cascade,
  body        text not null,
  state       text not null default 'pending' check (state in ('pending', 'sent', 'dropped')),
  ext_id      text,
  tries       integer not null default 0,
  error       text,
  created_at  integer not null,
  sent_at     integer
);
CREATE INDEX connector_outbox_pending on connector_outbox (connector, id) where state = 'pending';
CREATE INDEX connector_outbox_by_ext on connector_outbox (connector, ext_id) where ext_id is not null;
CREATE TABLE gate (
  id    integer primary key check (id = 1),
  open  boolean not null
);
CREATE TABLE gate_device (
  id         text primary key,
  name       text not null,
  key_hash   text not null unique,
  paired_at  integer not null,
  last_seen  integer
);
CREATE INDEX issue_session_by_issue on issue_session (issue, started_at);
CREATE TABLE channel_participant (
  id         text primary key,
  kind       text not null check (kind in ('user', 'manager', 'agent', 'system')),
  name       text not null,
  agent_id   text,
  runtime    text,
  joined_at  integer not null,
  left_at    integer,
  check ((kind = 'agent') = (agent_id is not null))
);
CREATE UNIQUE INDEX channel_conversation_by_name on channel_conversation (name) where name is not null;
CREATE INDEX channel_conversation_by_subject on channel_conversation (subject_kind, subject_id);
CREATE UNIQUE INDEX channel_conversation_one_general on channel_conversation (kind) where kind = 'general';
CREATE INDEX channel_mention_by_target on channel_mention (target_id, message_id);
CREATE INDEX channel_message_by_conversation on channel_message (conversation_id, number);
CREATE INDEX channel_message_by_sender on channel_message (sender_id, id);
CREATE UNIQUE INDEX channel_message_send_key on channel_message (sender_id, send_key) where send_key is not null;
CREATE INDEX channel_delivery_open on channel_delivery (recipient_id, message_id) where state in ('pending', 'announced', 'handed');
CREATE INDEX session_run_by_issue on session_run (issue, started_at);
CREATE INDEX session_run_by_session on session_run (session, started_at);
CREATE TABLE session (
  id        text primary key,
  agent     text not null,
  name      text not null,
  runtime   text not null,
  task      text not null,
  project   text,
  issue     text,
  playbook  text,
  hired_at  integer not null,
  ended_at  integer,
  closed    text check (closed in ('merged', 'merged_into_plan', 'dismissed', 'lost', 'answered'))
);
CREATE INDEX session_by_agent on session (agent, hired_at);
