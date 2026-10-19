-- The schema as it stands after the ids became uuidv7 (2026-10-17), as one baseline: every row the server makes has a
-- text uuidv7 primary key; chat messages carry a number inside their conversation for the #channel:number address, and
-- issues carry a number of their own. There is no upgrade path: the TypeScript farm is re-imported into this shape.

CREATE TABLE channel_conversation (
  id            text primary key,
  kind          text not null check (kind in ('general', 'channel', 'thread')),
  parent_id     text unique references channel_message (id),
  parent_number integer,
  subject_kind  text check (subject_kind in ('issue', 'graph', 'talk')),
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
  reason         text not null check (reason in ('mention', 'everyone', 'own_thread', 'follower', 'general', 'dispatch', 'addressed', 'graph')),
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
  graph       text,
  task        text,
  schedule    text,
  created_at  integer not null,
  queued_at   integer,
  closed_at   integer,
  closed      text check (closed in ('merged', 'merged_into_graph', 'dismissed', 'lost', 'answered')),
  pull_request text,
  acceptance  text not null default 'glance' check (acceptance in ('glance', 'required')),
  accepted_at integer,
  findings    text,
  asks        text,
  criteria    text
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
CREATE TABLE task_event (
  id          text primary key,
  graph_id    text not null,
  task_id     text,
  kind        text not null,
  actor       text not null check (actor in ('user', 'manager', 'system')),
  payload     text not null default '{}',
  created_at  integer not null
);
CREATE INDEX task_event_by_graph on task_event (graph_id, id);
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
  last_run    integer,
  -- Who set it, and whether it waits for the owner to say yes (schedule/rules.go's needsOK): a waiting one stays off
  -- until the owner turns it on, which clears pending.
  by          text not null default 'owner' check (by in ('owner', 'manager')),
  pending     boolean not null default 0
);
CREATE TABLE game_ledger (
  id      text primary key,
  kind    text not null,
  at      integer not null,
  payload text not null default '{}'
);
CREATE TABLE memory (
  id           text primary key,
  scope        text not null check (scope in ('owner', 'agent')),
  agent        text,                -- the profile id; null for scope owner
  kind         text not null check (kind in ('profile', 'note', 'issue', 'episode')),
  title        text,
  body         text not null,
  terms        text not null default '',   -- body cut by gse, space-joined, lower case
  terms_of     integer not null default 0, -- which cut: memory.TermsVersion
  labels       text not null default '[]', -- JSON array
  importance   integer not null default 0 check (importance between 0 and 3),
  project      text,                -- null: every project
  session      text,                -- the Session it came from
  author       text not null check (author in ('owner', 'agent', 'manager', 'system')),
  replaced_by  text,                -- the memory that superseded it; never recalled again
  created_at   integer not null,
  updated_at   integer not null,
  recalled     integer not null default 0,
  recalled_at  integer,
  check ((scope = 'owner') = (agent is null))
);
CREATE INDEX memory_by_agent ON memory (agent, created_at desc);
CREATE INDEX memory_by_scope ON memory (scope, kind) WHERE replaced_by IS NULL;
CREATE UNIQUE INDEX memory_one_issue ON memory (agent, session) WHERE kind = 'issue';
-- External content: the text lives once, in memory; the index holds only the terms.
CREATE VIRTUAL TABLE memory_term USING fts5(terms, content = 'memory', content_rowid = 'rowid', tokenize = 'unicode61');
CREATE TRIGGER memory_term_insert AFTER INSERT ON memory BEGIN
  INSERT INTO memory_term (rowid, terms) VALUES (new.rowid, new.terms);
END;
CREATE TRIGGER memory_term_delete AFTER DELETE ON memory BEGIN
  INSERT INTO memory_term (memory_term, rowid, terms) VALUES ('delete', old.rowid, old.terms);
END;
CREATE TRIGGER memory_term_update AFTER UPDATE OF terms ON memory BEGIN
  INSERT INTO memory_term (memory_term, rowid, terms) VALUES ('delete', old.rowid, old.terms);
  INSERT INTO memory_term (rowid, terms) VALUES (new.rowid, new.terms);
END;
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
  payload     text not null default '',
  delivered   integer not null default 1 check (delivered in (0, 1)),
  primary key (connector, ext_id)
);
CREATE INDEX connector_inbound_pending ON connector_inbound (connector, delivered) WHERE delivered = 0;
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
CREATE TABLE lan (
  id    integer primary key check (id = 1),
  open  boolean not null
);
CREATE TABLE lan_device (
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
  brief     text not null,
  project   text,
  issue     text,
  graph     text,
  hired_at  integer not null,
  ended_at  integer,
  closed    text check (closed in ('merged', 'merged_into_graph', 'dismissed', 'lost', 'answered'))
);
CREATE INDEX session_by_agent on session (agent, hired_at);
CREATE TABLE session_run_issue (
  run text not null references session_run(id) on delete cascade,
  issue text not null references issue(id) on delete cascade,
  primary key (run, issue)
);
CREATE INDEX session_run_issue_by_issue on session_run_issue(issue, run);
CREATE TABLE issue_queue (
  issue text primary key references issue(id) on delete cascade,
  channel text not null,
  triggered_by text not null
);
CREATE TABLE task_graph (
  graph text not null,
  owner text not null,
  id text not null,
  position integer not null,
  title text not null,
  brief text not null,
  after text not null,
  executor text not null,
  state text not null,
  result text not null,
  tries integer not null,
  updated_at integer not null,
  finished_at integer,
  primary key (graph, id)
);
CREATE INDEX task_graph_by_owner on task_graph (owner, finished_at);
