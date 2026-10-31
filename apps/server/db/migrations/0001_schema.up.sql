-- The database (PGlite, Postgres in this process): one baseline, edited in place. It is the Go server's
-- server/migrations/0001_schema.sql in Postgres: times are Unix milliseconds as double precision (exact to 2^53, and
-- numbers to the code, as the shapes have them); JSON is kept as text and read with @vibevalley/protocol/schema; a
-- memory's terms are searched by a tsvector column.

CREATE TYPE channel_participant_kind AS ENUM ('owner', 'orchestrator', 'session', 'profile', 'system');
CREATE TABLE channel_participant (
  id         text primary key,
  -- A profile is a helper profile the owner talks with alone (its id is profile:<agent>), not one of its sessions.
  kind       channel_participant_kind not null,
  name       text not null,
  agent_id   text,
  runtime    text,
  joined_at  double precision not null,
  left_at    double precision,
  -- The order they joined in, for those who joined at the same millisecond.
  seq        integer generated always as identity,
  check ((kind in ('session', 'profile')) = (agent_id is not null))
);
CREATE TYPE channel_type AS ENUM ('channel', 'direct', 'thread');
CREATE TYPE channel_subject_kind AS ENUM ('issue', 'graph', 'talk');
CREATE TYPE channel_notify AS ENUM ('all', 'mentions', 'none');
CREATE TABLE channel (
  id            text primary key,
  type          channel_type not null,
  is_default    boolean not null default false,
  root_id       text unique,
  root_number   integer,
  subject_kind  channel_subject_kind,
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
  -- Moves on with every message written or changed here: what a follower catches up from (channel_message.revision).
  revision      integer not null default 0,
  -- A channel's group in the sidebar; none is ungrouped.
  category      text,
  -- Its place in the sidebar, lowest first; none comes after the placed, oldest first.
  position      integer,
  archived_at   double precision,
  -- What of it counts for the owner: everything, only what @s the owner, or nothing.
  notify        channel_notify not null default 'all',
  -- The orchestrator's profile id that looks after a channel: the owner's words there go to it; none is the default one.
  orchestrator  text,
  check ((type = 'thread') = (root_id is not null)),
  check ((type = 'direct') = (peer_id is not null)),
  check (type <> 'direct' or name is null),
  check ((type = 'thread') = (parent_id is not null)),
  -- A direct channel with a helper profile is its talk issue's thread too.
  check ((subject_kind is null) or type in ('thread', 'direct')),
  check (not is_default or type = 'channel'),
  check (not is_default or archived_at is null),
  check (orchestrator is null or type = 'channel')
);
CREATE TYPE channel_message_kind AS ENUM ('chat', 'dispatch', 'report', 'notice');
CREATE TABLE channel_message (
  id              text primary key,
  channel_id text not null references channel (id),
  number          integer not null,
  sender_id       text not null references channel_participant (id),
  kind            channel_message_kind not null,
  body            text not null,
  meta            text,
  send_key        text,
  created_at      double precision not null,
  -- The channel's revision when it was last written or changed.
  revision        integer not null,
  -- The number of the message in the same channel it answers.
  reply_number    integer,
  edited_at       double precision,
  -- Deleted: its words gone, its number kept.
  deleted_at      double precision,
  pinned_at       double precision,
  -- {"emoji": ["participant", …]}, in the order they came.
  reactions       text,
  unique (channel_id, number),
  unique (channel_id, revision)
);
CREATE TABLE channel_attachment (
  -- The sha256 of its bytes, kept under the home directory's attachments/: the same file is kept once.
  id          text primary key,
  name        text not null,
  type        text not null,
  size        integer not null,
  created_at  double precision not null
);
CREATE TYPE channel_mention_resolved AS ENUM ('delivered', 'absent', 'unknown');
CREATE TABLE channel_mention (
  message_id  text not null references channel_message (id) on delete cascade,
  target_id   text not null,
  resolved    channel_mention_resolved not null,
  primary key (message_id, target_id)
);
CREATE TYPE channel_follow_reason AS ENUM ('owner', 'replied', 'mentioned', 'manual');
CREATE TABLE channel_follow (
  channel_id  text not null references channel (id),
  participant_id   text not null references channel_participant (id),
  reason           channel_follow_reason not null,
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
CREATE TYPE channel_delivery_reason AS ENUM ('mention', 'everyone', 'own_thread', 'follower', 'channel', 'direct', 'dispatch', 'addressed', 'graph');
CREATE TYPE channel_delivery_held_by AS ENUM ('hop_limit', 'cooldown', 'wake_breaker');
CREATE TYPE channel_delivery_state AS ENUM ('pending', 'announced', 'handed', 'seen', 'dropped');
CREATE TABLE channel_delivery (
  recipient_id   text not null references channel_participant (id),
  message_id     text not null references channel_message (id) on delete cascade,
  reason         channel_delivery_reason not null,
  wakes          boolean not null,
  held_by        channel_delivery_held_by,
  state          channel_delivery_state not null default 'pending',
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
CREATE TYPE issue_priority AS ENUM ('urgent', 'high', 'medium', 'low');
CREATE TYPE issue_delivered AS ENUM ('merged', 'merged_into_parent', 'pull_request', 'kept', 'none');
CREATE TYPE issue_canceled AS ENUM ('dismissed', 'lost');
CREATE TYPE issue_deliver AS ENUM ('change', 'branch', 'answer');
CREATE TABLE issue (
  id          text primary key,
  number      integer not null unique,
  title       text not null default '',
  description text not null,
  project     text,
  assignee    text,
  priority    issue_priority not null default 'medium',
  rank        integer not null default 0,
  parent      text references issue (id) on delete cascade,
  blocked_by  text,
  graph       text,
  task        text,
  cron    text,
  created_at  double precision not null,
  queued_at   double precision,
  closed_at   double precision,
  -- Closed, an issue is done with what it delivered, or canceled with why; never both.
  delivered   issue_delivered,
  canceled    issue_canceled,
  pull_request text,
  deliver issue_deliver not null default 'change',
  -- A profile's talk with the owner: the direct channel it is said in. Off the board; read-only, its rounds' leftovers go.
  talk    text unique,
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
CREATE TYPE session_run_outcome AS ENUM ('completed', 'failed', 'interrupted');
CREATE TABLE session_run (
  id           text primary key,
  session      text not null,
  issue        text,
  triggered_by text not null,
  heard        text,
  started_at   double precision not null,
  ended_at     double precision,
  outcome      session_run_outcome,
  summary      text,
  spent        text
);
CREATE TYPE task_event_kind AS ENUM ('splitting', 'drafted', 'started', 'paused', 'resumed', 'ready', 'merged', 'abandoned', 'noted', 'task_started', 'task_sent_back', 'task_merged', 'task_failed', 'task_retried', 'task_requeued', 'task_skipped', 'task_edited', 'task_added', 'task_removed');
CREATE TYPE task_event_actor AS ENUM ('owner', 'orchestrator', 'session', 'system');
CREATE TABLE task_event (
  id          text primary key,
  graph_id    text not null,
  task_id     text,
  kind        task_event_kind not null,
  actor       task_event_actor not null,
  payload     text not null default '{}',
  created_at  double precision not null
);
CREATE INDEX task_event_by_graph on task_event (graph_id, id);
CREATE TYPE cron_set_by AS ENUM ('owner', 'orchestrator', 'session', 'system');
CREATE TABLE cron (
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
  -- Who set it, and whether it waits for the owner to say yes (cron/rules.go's needsOK): a waiting one stays off
  -- until the owner turns it on, which clears pending.
  set_by      cron_set_by not null default 'owner',
  pending     boolean not null default false
);
CREATE TABLE game_ledger (
  id      text primary key,
  kind    text not null,
  at      double precision not null,
  payload text not null default '{}'
);
CREATE TYPE memory_scope AS ENUM ('owner', 'agent');
CREATE TYPE memory_kind AS ENUM ('note', 'issue');
CREATE TYPE memory_author AS ENUM ('owner', 'orchestrator', 'session', 'system');
CREATE TABLE memory (
  id           text primary key,
  scope        memory_scope not null,
  agent        text,                -- the profile id; null for scope owner
  kind         memory_kind not null,
  title        text,
  body         text not null,
  terms        text not null default '',   -- body cut by gse, space-joined, lower case
  terms_of     integer not null default 0, -- which cut: memory.TermsVersion
  labels       text not null default '[]', -- JSON array
  importance   integer not null default 0 check (importance between 0 and 3),
  project      text,                -- null: every project
  session      text,                -- the Session it came from
  author       memory_author not null,
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
CREATE TYPE connector_account_connector AS ENUM ('weixin', 'feishu', 'qq');
CREATE TABLE connector_account (
  connector      connector_account_connector primary key,
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
CREATE TYPE connector_outbox_state AS ENUM ('pending', 'sent', 'dropped');
CREATE TABLE connector_outbox (
  id          text primary key,
  connector   text not null,
  message_id  text not null references channel_message (id) on delete cascade,
  body        text not null,
  state       connector_outbox_state not null default 'pending',
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
CREATE TYPE session_closed AS ENUM ('merged', 'completed', 'dismissed', 'lost');
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
  closed    session_closed,
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
CREATE TYPE runtime_todo_executor AS ENUM ('self', 'subagent');
CREATE TYPE runtime_todo_state AS ENUM ('waiting', 'working', 'done', 'failed', 'skipped');
CREATE TABLE runtime_todo (
  graph text not null,
  keeper text not null,
  id text not null,
  position integer not null,
  title text not null,
  brief text not null,
  after text not null,
  executor runtime_todo_executor not null,
  state runtime_todo_state not null,
  result text not null,
  tries integer not null,
  updated_at double precision not null,
  finished_at double precision,
  primary key (graph, id)
);
CREATE INDEX runtime_todo_by_keeper on runtime_todo (keeper, finished_at);
-- Artifacts (artifact/artifact.ts). A blocks one's blocks are a flat list, nested by parent_id and ordered by
-- (order_key, id); every change is an op, and a batch of ops is one artifact_change with the artifact's next seq.
CREATE TYPE artifact_body AS ENUM ('blocks', 'html');
CREATE TABLE artifact (
  id          text primary key,
  title       text not null,
  -- blocks: written together, block by block (artifact_block); html: a whole page, version by version (artifact_version).
  body        artifact_body not null,
  -- The channel or thread it was announced in, none for one the owner started on the page; the issue it was made for, if any.
  channel_id  text references channel (id),
  -- The message that first announced it: a blocks one's comments are the replies to it (an html one's are each version's).
  message_id  text references channel_message (id) on delete set null,
  issue       text,
  -- Its maker, a profile's id or the owner's, and the name it went by then.
  by_id       text not null,
  by_name     text not null,
  -- html: the latest version; blocks: 0.
  version     integer not null,
  -- blocks: the batches taken (artifact_change); html: 0.
  seq         integer not null default 0,
  created_at  double precision not null,
  updated_at  double precision not null
);
CREATE INDEX artifact_by_channel on artifact (channel_id, updated_at);
CREATE INDEX artifact_by_issue on artifact (issue, updated_at);
CREATE TABLE artifact_version (
  artifact_id text not null references artifact (id) on delete cascade,
  version     integer not null,
  -- The sha256 of its bytes, kept under the home directory's artifacts/: the same content is kept once.
  sha         text not null,
  size        integer not null,
  note        text,
  by_id       text not null,
  by_name     text not null,
  -- The message that announced it: its comments are the replies to it.
  message_id  text references channel_message (id) on delete set null,
  created_at  double precision not null,
  primary key (artifact_id, version)
);
CREATE INDEX artifact_version_by_sha on artifact_version (sha);
CREATE TYPE artifact_block_type AS ENUM ('paragraph', 'heading', 'bulleted', 'numbered', 'todo', 'quote', 'code', 'divider', 'image', 'issue_ref', 'memory_item');
CREATE TABLE artifact_block (
  id          text primary key,
  artifact_id text not null references artifact (id) on delete cascade,
  parent_id   text,
  order_key   text not null,
  type        artifact_block_type not null,
  attrs       text not null default '{}', -- JSON: protocol.BlockAttrs
  spans       text not null default '[]', -- JSON: []protocol.TextSpan
  rev         integer not null,
  deleted     boolean not null default false,
  updated_by  text not null,
  updated_at  double precision not null
);
CREATE INDEX artifact_block_by_artifact on artifact_block (artifact_id, order_key, id);
-- A block's text at each rev (kind normal), and a submitted text that was not taken (kind conflict, at the rev it lost to).
CREATE TYPE artifact_block_revision_kind AS ENUM ('normal', 'conflict');
CREATE TABLE artifact_block_revision (
  id         text primary key,
  block_id   text not null references artifact_block (id) on delete cascade,
  rev        integer not null,
  spans      text not null,
  actor      text not null,
  kind       artifact_block_revision_kind not null,
  created_at double precision not null
);
CREATE INDEX artifact_block_revision_by_block on artifact_block_revision (block_id, rev);
CREATE TABLE artifact_change (
  artifact_id text not null references artifact (id) on delete cascade,
  seq         integer not null,
  batch_id    text not null unique,
  actor       text not null,
  block_ids   text not null, -- JSON: the blocks the batch changed
  results     text not null, -- JSON: []protocol.BlockOpResult, answered again when the batch comes again
  created_at  double precision not null,
  primary key (artifact_id, seq)
);

-- Postgres does not index a foreign key; a delete that cascades and a lookup by it scan without one.
-- A change an agent proposed to a block the owner wrote (artifact/blocks.ts): once open, then accepted or rejected by the
-- owner. A block that moved on since base_rev comes back stale instead of being changed.
CREATE TYPE artifact_suggestion_status AS ENUM ('open', 'accepted', 'rejected');
CREATE TABLE artifact_suggestion (
  id          text primary key,
  artifact_id text not null references artifact (id) on delete cascade,
  block_id    text not null references artifact_block (id) on delete cascade,
  author      text not null,
  at_rev      integer not null,
  change      text not null, -- JSON: protocol.SuggestionChange
  status      artifact_suggestion_status not null default 'open',
  created_at  double precision not null,
  resolved_at double precision,
  resolved_by text
);
CREATE INDEX artifact_suggestion_by_artifact on artifact_suggestion (artifact_id, created_at);
CREATE INDEX artifact_suggestion_open on artifact_suggestion (artifact_id, status);
CREATE INDEX artifact_suggestion_by_block on artifact_suggestion (block_id);

CREATE INDEX channel_by_parent on channel (parent_id) where parent_id is not null;
CREATE INDEX channel_follow_by_participant on channel_follow (participant_id);
CREATE INDEX channel_read_cursor_by_channel on channel_read_cursor (channel_id);
CREATE INDEX channel_seen_mark_by_message on channel_seen_mark (message_id);
CREATE INDEX channel_delivery_by_message on channel_delivery (message_id);
CREATE INDEX cron_by_channel on cron (channel_id);
CREATE INDEX connector_account_by_channel on connector_account (channel_id) where channel_id is not null;
CREATE INDEX connector_inbound_by_message on connector_inbound (message_id) where message_id is not null;
CREATE INDEX connector_outbox_by_message on connector_outbox (message_id);
CREATE INDEX artifact_by_message on artifact (message_id) where message_id is not null;
CREATE INDEX artifact_version_by_message on artifact_version (message_id) where message_id is not null;

-- A thread hangs under a message, which is made after its channel.
ALTER TABLE channel ADD FOREIGN KEY (root_id) REFERENCES channel_message (id);
