-- The database (PGlite, Postgres in this process): one baseline, edited in place. It is the Go server's
-- server/migrations/0001_schema.sql in Postgres: times are Unix milliseconds as double precision (exact to 2^53, and
-- numbers to the code, as the shapes have them); JSON is kept as text and read with @vibevalley/protocol/schema; a
-- memory's terms are searched by a tsvector column.

CREATE TABLE channel_participant (
  id         text primary key,
  kind       text not null check (kind in ('owner', 'orchestrator', 'session', 'system')),
  name       text not null,
  agent_id   text,
  runtime    text,
  joined_at  double precision not null,
  left_at    double precision,
  -- The order they joined in, for those who joined at the same millisecond.
  seq        integer generated always as identity,
  check ((kind = 'session') = (agent_id is not null))
);
CREATE TABLE channel (
  id            text primary key,
  type          text not null check (type in ('channel', 'direct', 'thread')),
  is_default    boolean not null default false,
  root_id       text unique,
  root_number   integer,
  subject_kind  text check (subject_kind in ('issue', 'graph', 'talk')),
  subject_id    text,
  last_number   integer,
  reply_count   integer not null default 0,
  created_at    double precision not null,
  name          text,
  description   text,
  project       text,
  parent_id     text references channel (id),
  -- A direct channel is the owner's and one other participant's: the peer.
  peer_id       text unique references channel_participant (id),
  check ((type = 'thread') = (root_id is not null)),
  check ((type = 'direct') = (peer_id is not null)),
  check (type <> 'direct' or name is null),
  check ((type = 'thread') = (parent_id is not null)),
  check ((subject_kind is null) or type = 'thread'),
  check (not is_default or type = 'channel')
);
CREATE TABLE channel_message (
  id              text primary key,
  channel_id text not null references channel (id),
  number          integer not null,
  sender_id       text not null references channel_participant (id),
  kind            text not null check (kind in ('chat', 'dispatch', 'report', 'notice')),
  body            text not null,
  meta            text,
  send_key        text,
  created_at      double precision not null,
  unique (channel_id, number)
);
CREATE TABLE channel_mention (
  message_id  text not null references channel_message (id) on delete cascade,
  target_id   text not null,
  resolved    text not null check (resolved in ('delivered', 'absent', 'unknown')),
  primary key (message_id, target_id)
);
CREATE TABLE channel_follow (
  channel_id  text not null references channel (id),
  participant_id   text not null references channel_participant (id),
  reason           text not null check (reason in ('owner', 'replied', 'mentioned', 'manual')),
  from_number      integer not null,
  unfollowed_at    double precision,
  primary key (channel_id, participant_id)
);
CREATE TABLE channel_read_cursor (
  participant_id   text not null references channel_participant (id),
  channel_id  text not null references channel (id),
  read_number      integer not null,
  updated_at       double precision not null,
  primary key (participant_id, channel_id)
);
CREATE TABLE channel_seen_mark (
  participant_id  text not null references channel_participant (id),
  message_id      text not null references channel_message (id) on delete cascade,
  primary key (participant_id, message_id)
);
CREATE TABLE channel_delivery (
  recipient_id   text not null references channel_participant (id),
  message_id     text not null references channel_message (id) on delete cascade,
  reason         text not null check (reason in ('mention', 'everyone', 'own_thread', 'follower', 'channel', 'direct', 'dispatch', 'addressed', 'graph')),
  wakes          boolean not null,
  held_by        text check (held_by in ('hop_limit', 'cooldown', 'wake_breaker')),
  state          text not null default 'pending' check (state in ('pending', 'announced', 'handed', 'seen', 'dropped')),
  launch         text,
  announced_at   double precision,
  handed_at      double precision,
  seen_at        double precision,
  dropped_why    text,
  created_at     double precision not null,
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
  recurrence    text,
  created_at  double precision not null,
  queued_at   double precision,
  closed_at   double precision,
  -- Closed, an issue is done with what it delivered, or canceled with why; never both.
  delivered   text check (delivered in ('merged', 'merged_into_parent', 'pull_request', 'kept', 'none')),
  canceled    text check (canceled in ('dismissed', 'lost')),
  pull_request text,
  review  text not null default 'glance' check (review in ('glance', 'required')),
  deliver text not null default 'change' check (deliver in ('change', 'answer')),
  reviewed_at double precision,
  findings    text,
  questions        text,
  criteria    text,
  checks      text,
  -- An in-process agent's latest run on it (JSON IssueRun): no end while it goes on.
  last_run text,
  -- An answer issue's conclusion (JSON IssueAnswer), read from its latest round's report.
  answer   text,
  check (delivered is null or canceled is null)
);
CREATE INDEX issue_by_parent on issue (parent);
CREATE TABLE issue_session (
  session         text primary key,
  issue           text not null references issue (id) on delete cascade,
  started_at      double precision not null
);
CREATE TABLE session_run (
  id           text primary key,
  session      text not null,
  issue        text,
  triggered_by text not null,
  heard        text,
  started_at   double precision not null,
  ended_at     double precision,
  outcome      text,
  summary      text,
  spent        text
);
CREATE TABLE task_event (
  id          text primary key,
  graph_id    text not null,
  task_id     text,
  kind        text not null,
  actor       text not null check (actor in ('owner', 'orchestrator', 'session', 'system')),
  payload     text not null default '{}',
  created_at  double precision not null
);
CREATE INDEX task_event_by_graph on task_event (graph_id, id);
CREATE TABLE recurrence (
  id          text primary key,
  name        text not null,
  body        text not null,
  channel_id  text not null references channel (id) on delete cascade,
  agent       text,
  project     text,
  spec        text not null,
  tz          text not null,
  enabled     boolean not null default true,
  created_at  double precision not null,
  last_run    double precision,
  -- Who set it, and whether it waits for the owner to say yes (recurrence/rules.go's needsOK): a waiting one stays off
  -- until the owner turns it on, which clears pending.
  set_by      text not null default 'owner' check (set_by in ('owner', 'orchestrator', 'session', 'system')),
  pending     boolean not null default false
);
CREATE TABLE game_ledger (
  id      text primary key,
  kind    text not null,
  at      double precision not null,
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
  author       text not null check (author in ('owner', 'orchestrator', 'session', 'system')),
  replaced_by  text,                -- the memory that superseded it; never recalled again
  created_at   double precision not null,
  updated_at   double precision not null,
  recalled     integer not null default 0,
  recalled_at  double precision,
  -- The terms as Postgres searches them, each word one lexeme as it is (memory/terms.ts).
  terms_vector tsvector generated always as (array_to_tsvector(string_to_array(terms, ' '))) stored,
  check ((scope = 'owner') = (agent is null))
);
CREATE INDEX memory_by_agent ON memory (agent, created_at desc);
CREATE INDEX memory_by_scope ON memory (scope, kind) WHERE replaced_by IS NULL;
CREATE UNIQUE INDEX memory_one_issue ON memory (agent, session) WHERE kind = 'issue';
CREATE INDEX memory_by_terms ON memory USING gin (terms_vector);
CREATE TABLE connector_account (
  connector      text primary key check (connector in ('weixin', 'feishu', 'qq')),
  secrets        text not null,
  owner_id       text,
  pair_code      text,
  cursor         text not null default '',
  reply_context  text,
  reply_at       double precision,
  last_inbound   double precision,
  paused_until   double precision,
  connected_at   double precision not null,
  channel_id     text references channel (id)
);
CREATE TABLE connector_inbound (
  connector   text not null,
  ext_id      text not null,
  message_id  text references channel_message (id) on delete set null,
  created_at  double precision not null,
  payload     text not null default '',
  delivered   boolean not null default true,
  -- The order they were accepted in.
  seq         integer generated always as identity,
  primary key (connector, ext_id)
);
CREATE INDEX connector_inbound_pending ON connector_inbound (connector, delivered) WHERE not delivered;
CREATE TABLE connector_outbox (
  id          text primary key,
  connector   text not null,
  message_id  text not null references channel_message (id) on delete cascade,
  body        text not null,
  state       text not null default 'pending' check (state in ('pending', 'sent', 'dropped')),
  ext_id      text,
  tries       integer not null default 0,
  error       text,
  created_at  double precision not null,
  sent_at     double precision
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
  paired_at  double precision not null,
  last_seen  double precision
);
CREATE INDEX issue_session_by_issue on issue_session (issue, started_at);
CREATE UNIQUE INDEX channel_by_name on channel (name) where name is not null;
CREATE INDEX channel_by_subject on channel (subject_kind, subject_id);
CREATE UNIQUE INDEX channel_one_default on channel (is_default) where is_default;
CREATE INDEX channel_mention_by_target on channel_mention (target_id, message_id);
CREATE INDEX channel_message_by_channel on channel_message (channel_id, number);
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
  hired_at  double precision not null,
  ended_at  double precision,
  closed    text check (closed in ('merged', 'completed', 'dismissed', 'lost')),
  place       text,
  oar_session text,
  last_text   text,
  recalled    text
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
CREATE TABLE agent_task (
  graph text not null,
  keeper text not null,
  id text not null,
  position integer not null,
  title text not null,
  brief text not null,
  after text not null,
  executor text not null check (executor in ('self', 'subagent')),
  state text not null check (state in ('waiting', 'working', 'done', 'failed', 'skipped')),
  result text not null,
  tries integer not null,
  updated_at double precision not null,
  finished_at double precision,
  primary key (graph, id)
);
CREATE INDEX agent_task_by_keeper on agent_task (keeper, finished_at);
-- Documents (doc/doc.go): blocks in a flat list, nested by parent_id and ordered by (order_key, id); every change is an op,
-- and a batch of ops is one doc_change with the doc's next seq.
CREATE TABLE doc (
  id         text primary key,
  title      text not null,
  seq        integer not null default 0,
  created_at double precision not null,
  updated_at double precision not null
);
CREATE TABLE doc_block (
  id         text primary key,
  doc_id     text not null references doc (id) on delete cascade,
  parent_id  text,
  order_key  text not null,
  type       text not null,
  attrs      text not null default '{}', -- JSON: protocol.BlockAttrs
  spans      text not null default '[]', -- JSON: []protocol.Span
  rev        integer not null,
  deleted    boolean not null default false,
  updated_by text not null,
  updated_at double precision not null
);
CREATE INDEX doc_block_by_doc on doc_block (doc_id, order_key, id);
-- A block's text at each rev (kind normal), and a submitted text that was not taken (kind conflict, at the rev it lost to).
CREATE TABLE doc_block_revision (
  id         text primary key,
  block_id   text not null references doc_block (id) on delete cascade,
  rev        integer not null,
  spans      text not null,
  actor      text not null,
  kind       text not null check (kind in ('normal', 'conflict')),
  created_at double precision not null
);
CREATE INDEX doc_block_revision_by_block on doc_block_revision (block_id, rev);
CREATE TABLE doc_change (
  doc_id     text not null references doc (id) on delete cascade,
  seq        integer not null,
  batch_id   text not null unique,
  actor      text not null,
  block_ids  text not null, -- JSON: the blocks the batch changed
  results    text not null, -- JSON: []protocol.DocOpResult, answered again when the batch comes again
  created_at double precision not null,
  primary key (doc_id, seq)
);

-- A thread hangs under a message, which is made after its channel.
ALTER TABLE channel ADD FOREIGN KEY (root_id) REFERENCES channel_message (id);
