-- The database (Postgres: a database.url, or PGlite in the home): one baseline, edited in place. Times are Unix
-- milliseconds as double precision (exact to 2^53, and numbers to the code, as the shapes have them); no column is
-- bigint, which a Postgres driver hands back as a string. A closed set of words is text with a check (col in (…)), which
-- the generated code reads as its literals; JSON is kept as text and read with @vibevalley/protocol/schema (a query casts
-- it to jsonb to look inside); a memory's and a note block's terms are searched through term_vector and term_query.

-- Terms are cut before they are kept (memory/gse.ts): only a space parts two words, so db/migrations or v1.2.3 is one
-- word, and the words are kept as they are (no stemming, no stop words).
CREATE FUNCTION term_vector(terms text) RETURNS tsvector LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN array_to_tsvector(array_remove(string_to_array(terms, ' '), ''));
-- Any of words, each quoted so none reads as an operator; prefix: a word matches the words it begins.
CREATE FUNCTION term_query(words text[], prefix boolean) RETURNS tsquery LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN (SELECT string_agg('''' || replace(replace(w, '\', '\\'), '''', '''''') || '''' || CASE WHEN prefix THEN ':*' ELSE '' END, ' | ')
          FROM unnest(words) AS w WHERE w <> '')::tsquery;

CREATE TABLE channel_participant (
  id         text primary key,
  -- A profile is a helper profile the owner talks with alone (its id is profile:<agent>), not one of its sessions.
  kind       text not null check (kind in ('owner', 'orchestrator', 'session', 'profile', 'system')),
  name       text not null,
  agent_id   text,
  runtime    text,
  joined_at  double precision not null,
  left_at    double precision,
  -- The order they joined in, for those who joined at the same millisecond (numbered by channel_participant_seq).
  seq        integer not null default 0,
  check ((kind in ('session', 'profile')) = (agent_id is not null))
);
CREATE TABLE channel (
  id            text primary key,
  type          text not null check (type in ('channel', 'direct', 'thread')),
  is_default    boolean not null default false,
  -- A thread hangs under a message, which is made after its channel (its key is added once channel_message is there).
  root_id       text unique,
  root_number   integer,
  subject_kind  text check (subject_kind in ('issue', 'talk')),
  subject_id    text,
  last_number   integer,
  reply_count   integer not null default 0,
  created_at    double precision not null,
  name          text,
  description   text,
  repo       text,
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
  notify        text not null default 'all' check (notify in ('all', 'mentions', 'none')),
  check ((type = 'thread') = (root_id is not null)),
  check ((type = 'direct') = (peer_id is not null)),
  check (type <> 'direct' or name is null),
  check ((type = 'thread') = (parent_id is not null)),
  check ((subject_kind is null) or type = 'thread'),
  check (not is_default or type = 'channel'),
  check (not is_default or archived_at is null)
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
ALTER TABLE channel ADD FOREIGN KEY (root_id) REFERENCES channel_message (id);
CREATE TABLE media_input (
  id TEXT PRIMARY KEY NOT NULL,
  metadata TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 512000000),
  phase TEXT NOT NULL CHECK (phase IN ('reserved','uploading','ready','failed','deleting')),
  hash TEXT CHECK (hash IS NULL OR hash ~ '^[0-9a-f]{64}$'),
  created_at double precision NOT NULL,
  expires_at double precision NOT NULL,
  CHECK (phase != 'ready' OR hash IS NOT NULL)
);
CREATE INDEX media_input_hash ON media_input(hash);
CREATE INDEX media_input_expiry ON media_input(expires_at);
CREATE TABLE media_input_pin (
  input_id TEXT NOT NULL REFERENCES media_input(id) ON DELETE RESTRICT,
  holder TEXT NOT NULL,
  PRIMARY KEY (input_id, holder)
);
CREATE INDEX media_input_pin_holder ON media_input_pin(holder);

CREATE TABLE media_remote_file (
  id TEXT PRIMARY KEY NOT NULL,
  holder TEXT NOT NULL,
  -- Remote cleanup receipts must survive deletion of the local input reservation.
  input_id TEXT NOT NULL,
  connection TEXT NOT NULL,
  revision INTEGER NOT NULL,
  credential_hash TEXT NOT NULL,
  filename TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('image','video','audio')),
  size INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('uploading','ready','rejected','unknown','deleting','deleted')),
  remote_id TEXT,
  created_at double precision NOT NULL,
  updated_at double precision NOT NULL,
  UNIQUE (holder, input_id),
  CHECK (phase NOT IN ('ready','deleting') OR remote_id IS NOT NULL)
);
CREATE INDEX media_remote_file_phase ON media_remote_file(phase);

CREATE TABLE media_understanding (
  id TEXT PRIMARY KEY NOT NULL,
  request TEXT NOT NULL,
  inputs TEXT NOT NULL,
  source TEXT NOT NULL,
  "authorization" TEXT,
  connection TEXT NOT NULL,
  revision INTEGER NOT NULL,
  model TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('authorized','queued','uploading','generating','ready','incomplete','failed','unknown','canceled')),
  result TEXT,
  cleanup TEXT NOT NULL CHECK (cleanup IN ('pending','running','done','blocked','unknown')),
  problem TEXT NOT NULL DEFAULT '',
  created_at double precision NOT NULL,
  updated_at double precision NOT NULL
);
CREATE INDEX media_understanding_recent ON media_understanding(created_at DESC, id);
CREATE INDEX media_understanding_phase ON media_understanding(phase, cleanup);

CREATE TABLE media_generation (
  id TEXT PRIMARY KEY NOT NULL,
  request TEXT NOT NULL,
  source TEXT NOT NULL,
  usage TEXT,
  connection TEXT NOT NULL,
  revision INTEGER NOT NULL,
  model TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('queued','generating','downloading','ready','failed','unknown','canceled','download_failed')),
  result_url TEXT,
  attachment TEXT,
  problem TEXT NOT NULL DEFAULT '',
  created_at double precision NOT NULL,
  updated_at double precision NOT NULL
);
CREATE INDEX media_generation_recent ON media_generation(created_at DESC, id);
CREATE INDEX media_generation_phase ON media_generation(phase);

CREATE TABLE media_speech (
  id TEXT PRIMARY KEY NOT NULL,
  request TEXT NOT NULL,
  source TEXT NOT NULL,
  connection TEXT NOT NULL,
  revision INTEGER NOT NULL,
  model TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  remote_task TEXT,
  result_format TEXT CHECK (result_format IN ('mp3','wav','pcm','flac','aac','opus')),
  content_type TEXT,
  metadata TEXT,
  usage TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('queued','generating','downloading','ready','failed','unknown','canceled','download_failed')),
  result_url TEXT,
  attachment TEXT,
  result_input TEXT,
  assets_released INTEGER NOT NULL DEFAULT 0 CHECK (assets_released IN (0,1)),
  problem TEXT NOT NULL DEFAULT '',
  created_at double precision NOT NULL,
  updated_at double precision NOT NULL
);
CREATE INDEX media_speech_recent ON media_speech(created_at DESC, id);
CREATE INDEX media_speech_phase ON media_speech(phase);

CREATE TABLE media_audio (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('speakers','voiceDesign','clone','transcription')),
  request TEXT NOT NULL,
  source TEXT NOT NULL,
  input TEXT,
  connection TEXT NOT NULL,
  revision INTEGER NOT NULL,
  model TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('queued','generating','downloading','ready','failed','unknown','canceled','download_failed')),
  remote_task_id TEXT,
  result_url TEXT,
  result_format TEXT CHECK (result_format IN ('mp3','wav','pcm','flac','aac','opus')),
  content_type TEXT,
  metadata TEXT,
  usage TEXT,
  result TEXT,
  attachment TEXT,
  result_input TEXT,
  preview_input TEXT,
  assets_released INTEGER NOT NULL DEFAULT 0 CHECK (assets_released IN (0,1)),
  problem TEXT NOT NULL DEFAULT '',
  created_at double precision NOT NULL,
  updated_at double precision NOT NULL
);
CREATE INDEX media_audio_phase ON media_audio(phase);
CREATE INDEX media_audio_created ON media_audio(created_at DESC, id);

CREATE TABLE channel_attachment (
  -- The sha256 of its bytes, kept under the home directory's attachments/: the same file is kept once.
  id          text primary key,
  name        text not null,
  type        text not null,
  size        integer not null,
  created_at  double precision not null
);
CREATE TABLE channel_mention (
  message_id  text not null references channel_message (id) on delete cascade,
  target_id   text not null,
  resolved    text not null check (resolved in ('delivered', 'absent', 'unknown')),
  primary key (message_id, target_id)
);
CREATE TABLE channel_member (
  channel_id  text not null references channel (id),
  participant_id   text not null references channel_participant (id),
  reason           text not null check (reason in ('owner', 'replied', 'mentioned', 'manual')),
  from_number      integer not null,
  left_at    double precision,
  primary key (channel_id, participant_id)
);
CREATE TABLE channel_read_cursor (
  participant_id   text not null references channel_participant (id),
  channel_id  text not null references channel (id),
  read_number      integer not null,
  updated_at       double precision not null,
  primary key (participant_id, channel_id)
);
CREATE TABLE mailbox_trigger (
  id text primary key,
  seq integer not null default 0, -- the order they were recorded in (mailbox_trigger_seq)
  source text not null,
  source_key text not null,
  trigger_json text not null,
  payload_json text not null,
  occurred_at double precision not null,
  routed_at double precision,
  routing_scope text,
  routing_position integer,
  check ((routed_at is null and routing_scope is null and routing_position is null) or
         (routed_at is not null and routing_scope is not null and routing_position is not null)),
  unique (source, source_key)
);
CREATE TABLE ingress_github (
  repo text not null,
  pr_number integer not null,
  check_fingerprint text not null default '',
  check_revision integer not null default 0,
  primary key (repo, pr_number)
);

CREATE TABLE issue (
  id          text primary key,
  number      integer not null unique,
  title       text not null default '',
  description text not null,
  origin_trigger_id text,
  mandate_strength text not null check (mandate_strength in ('explicit', 'inferred')),
  max_bot_review_rounds integer not null,
  auto_submit_pr boolean not null,
  repo     text,
  priority    text not null default 'medium' check (priority in ('urgent', 'high', 'medium', 'low')),
  rank        integer not null default 0,
  parent      text references issue (id) on delete cascade,
  blocked_by  text,
  constraints text,
  cron    text,
  created_at  double precision not null,
  queued_at   double precision,
  closed_at   double precision,
  -- Closed, an issue is done with what it delivered, or canceled with why; never both.
  delivered   text check (delivered in ('merged', 'merged_into_parent', 'pull_request', 'submitted', 'kept', 'none')),
  canceled    text check (canceled in ('dismissed', 'lost')),
  pull_request text,
  deliver text not null default 'change' check (deliver in ('change', 'branch', 'answer', 'pull_request')),
  reviewed_at double precision,
  findings    text,
  questions        text,
  criteria    text,
  checks      text,
  conflict text,
  -- An answer issue's conclusion (JSON IssueAnswer), read from its latest round's report.
  answer   text,
  check (delivered is null or canceled is null)
);
CREATE INDEX issue_by_parent on issue (parent);
CREATE TABLE issue_assignment (
  id              text primary key,
  issue           text not null references issue (id) on delete cascade,
  agent           text not null,
  assigned_at     double precision not null,
  ended_at        double precision
);
-- The computers helpers work on (machine/machine.ts): the server's own, and in time those let in from the command line.
CREATE TABLE machine (
  id         text primary key,
  name       text not null,
  here       boolean not null default false,
  joined_at  double precision not null
);
CREATE UNIQUE INDEX machine_one_here ON machine (here) WHERE here;
CREATE TABLE session (
  id          text primary key,
  role        text not null check (role in ('orchestrator', 'worker')),
  agent       text not null,
  name        text not null,
  runtime     text not null,
  brief       text not null,
  repo     text,
  issue       text,
  channel     text,
  hired_at    double precision not null,
  ended_at    double precision,
  closed      text check (closed in ('merged', 'completed', 'dismissed', 'lost')),
  place       text,
  oar_session text,
  last_text   text,
  recalled    text,
  pending_report text,
  phase text not null default '{"_tag":"resting"}',
  refining boolean not null default false,
  runs integer not null default 0,
  last_run text,
  spent text,
  -- The machine it works on; none for an agent hosted in the server's process.
  machine text references machine (id)
);
CREATE INDEX session_by_machine on session (machine) where machine is not null;
CREATE TABLE issue_assignment_execution (
  assignment text not null references issue_assignment(id) on delete cascade,
  executor text not null references session(id),
  started_at double precision not null,
  primary key (assignment, executor)
);
CREATE INDEX session_by_agent on session (agent, hired_at);
-- One order across the deliveries and the routed triggers (mailbox_owner_route reads both): each takes the next id here.
CREATE TABLE mailbox_order (
  id integer primary key
);
CREATE TABLE mailbox_delivery (
  position integer not null default 0, -- the next of mailbox_order
  scope text not null,
  session_id     text not null references session (id) on delete cascade,
  envelope_id    text not null,
  channel_id     text references channel (id) on delete cascade,
  message_id     text references channel_message (id) on delete cascade,
  source         text not null check (source in ('workbench', 'channel', 'connector', 'voice', 'github', 'cron', 'patrol')),
  urgency        text not null check (urgency in ('interrupt', 'steer', 'queue', 'digest')),
  reason         text not null,
  wakes          boolean not null,
  held_by        text check (held_by in ('hop_limit', 'cooldown', 'wake_breaker')),
  state          text not null default 'pending' check (state in ('pending', 'handed', 'consumed', 'dropped')),
  payload_json   text not null,
  launch         text,
  handed_at      double precision,
  consumed_at        double precision,
  dropped_why    text,
  created_at     double precision not null,
  primary key (session_id, envelope_id),
  check ((held_by is null) or wakes),
  check ((state = 'handed') = (launch is not null) or state in ('consumed', 'dropped'))
);
CREATE TABLE mailbox_subscription (
  thread_key text primary key,
  issue_id text not null references issue(id) on delete cascade
);
CREATE INDEX mailbox_subscription_by_issue on mailbox_subscription(issue_id);
CREATE TABLE mailbox_issue (
  trigger_id text primary key references mailbox_trigger(id) on delete cascade,
  issue_id text not null references issue(id) on delete cascade,
  state text not null default 'held' check (state in ('held', 'forwarded', 'returned')),
  session_id text references session(id) on delete set null,
  reason text,
  created_at double precision not null
);
CREATE INDEX mailbox_issue_by_issue on mailbox_issue(issue_id, state, created_at);
-- At most one held input per issue: a newer hold replaces the older one.
CREATE FUNCTION mailbox_issue_one_held() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM mailbox_issue WHERE issue_id = NEW.issue_id AND trigger_id <> NEW.trigger_id AND state = 'held'
    AND EXISTS (SELECT 1 FROM mailbox_trigger t WHERE t.id = NEW.trigger_id AND t.source = 'cron');
  RETURN NEW;
END $$;
CREATE TRIGGER mailbox_issue_one_held BEFORE INSERT ON mailbox_issue
  FOR EACH ROW WHEN (NEW.state = 'held' AND NEW.reason = 'human') EXECUTE FUNCTION mailbox_issue_one_held();
CREATE TRIGGER mailbox_issue_one_held_again BEFORE UPDATE OF state ON mailbox_issue
  FOR EACH ROW WHEN (NEW.state = 'held' AND NEW.reason = 'human') EXECUTE FUNCTION mailbox_issue_one_held();

CREATE INDEX mailbox_trigger_route_order on mailbox_trigger (routing_scope, routing_position) where routed_at is not null;
CREATE INDEX mailbox_delivery_scope_position on mailbox_delivery (scope, position);
CREATE TABLE session_run (
  id           text primary key,
  session      text not null references session(id) on delete cascade,
  issue        text,
  triggered_by text not null,
  heard        text,
  started_at   double precision not null,
  ended_at     double precision,
  outcome      text check (outcome in ('completed', 'failed', 'interrupted')),
  summary      text,
  spent        text
);
CREATE TABLE cron (
  id          text primary key,
  name        text not null,
  body        text not null,
  channel_id  text not null references channel (id) on delete cascade,
  agent       text,
  repo     text,
  spec        text not null,
  tz          text not null,
  enabled     boolean not null default true,
  created_at  double precision not null,
  last_run    double precision,
  -- Who set it, and whether it waits for the owner to say yes (cron/rules.go's needsOK): a waiting one stays off
  -- until the owner turns it on, which clears pending.
  set_by      text not null default 'owner' check (set_by in ('owner', 'agent', 'system')),
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
  kind         text not null check (kind in ('note', 'issue')),
  title        text,
  body         text not null,
  terms        text not null default '',   -- body cut by gse, space-joined, lower case
  terms_of     integer not null default 0, -- which cut: memory.TermsVersion
  labels       text not null default '[]', -- JSON array
  importance   integer not null default 0 check (importance between 0 and 3),
  repo      text,                -- null: every repo
  session      text,                -- the Session it came from
  author       text not null check (author in ('owner', 'agent', 'system')),
  replaced_by  text,                -- the memory that superseded it; never recalled again
  created_at   double precision not null,
  updated_at   double precision not null,
  recalled     integer not null default 0,
  recalled_at  double precision,
  check ((scope = 'owner') = (agent is null))
);
CREATE INDEX memory_by_agent ON memory (agent, created_at desc);
CREATE INDEX memory_by_scope ON memory (scope, kind) WHERE replaced_by IS NULL;
CREATE UNIQUE INDEX memory_one_issue ON memory (agent, session) WHERE kind = 'issue';
-- The terms as a search reads them (memory.sql MatchMemories).
CREATE INDEX memory_terms ON memory USING gin (term_vector(terms));
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
  -- The order they were accepted in (connector_inbound_seq).
  seq         integer not null default 0,
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
CREATE INDEX issue_assignment_by_issue on issue_assignment (issue, assigned_at, id);
CREATE UNIQUE INDEX issue_assignment_current on issue_assignment (issue) where ended_at is null;
CREATE INDEX issue_assignment_execution_by_executor on issue_assignment_execution (executor);
CREATE UNIQUE INDEX channel_by_name on channel (name) where name is not null;
CREATE INDEX channel_by_subject on channel (subject_kind, subject_id);
CREATE UNIQUE INDEX channel_one_default on channel (is_default) where is_default;
CREATE INDEX channel_mention_by_target on channel_mention (target_id, message_id);
CREATE INDEX channel_message_by_channel on channel_message (channel_id, number);
CREATE INDEX channel_message_by_sender on channel_message (sender_id, id);
CREATE UNIQUE INDEX channel_message_send_key on channel_message (sender_id, send_key) where send_key is not null;
CREATE INDEX mailbox_delivery_open on mailbox_delivery (session_id, envelope_id) where state in ('pending', 'handed');
CREATE INDEX session_run_by_issue on session_run (issue, started_at);
CREATE INDEX session_run_by_session on session_run (session, started_at);
CREATE TABLE session_run_issue (
  run text not null references session_run(id) on delete cascade,
  issue text not null references issue(id) on delete cascade,
  primary key (run, issue)
);
CREATE INDEX session_run_issue_by_issue on session_run_issue(issue, run);
CREATE TABLE runtime_todo (
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
CREATE INDEX runtime_todo_by_keeper on runtime_todo (keeper, finished_at);
-- Artifacts (artifact/artifact.ts). A blocks one's blocks are a flat list, nested by parent_id and ordered by
-- (order_key, id); every change is an op, and a batch of ops is one artifact_change with the artifact's next seq.
CREATE TABLE artifact (
  id          text primary key,
  title       text not null,
  -- blocks: written together, block by block (artifact_block); html: a whole page, version by version (artifact_version).
  body        text not null check (body in ('blocks', 'html')),
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
CREATE TABLE artifact_block (
  id          text primary key,
  artifact_id text not null references artifact (id) on delete cascade,
  parent_id   text,
  order_key   text not null,
  type        text not null check (type in ('paragraph', 'heading', 'bulleted', 'numbered', 'todo', 'quote', 'code', 'divider', 'image', 'issue_ref', 'memory_item')),
  attrs       text not null default '{}', -- JSON: protocol.BlockAttrs
  spans       text not null default '[]', -- JSON: []protocol.TextSpan
  rev         integer not null,
  deleted     boolean not null default false,
  updated_by  text not null,
  updated_at  double precision not null
);
CREATE INDEX artifact_block_by_artifact on artifact_block (artifact_id, order_key, id);
-- A block's text at each rev (kind normal), and a submitted text that was not taken (kind conflict, at the rev it lost to).
CREATE TABLE artifact_block_revision (
  id         text primary key,
  block_id   text not null references artifact_block (id) on delete cascade,
  rev        integer not null,
  spans      text not null,
  actor      text not null,
  kind       text not null check (kind in ('normal', 'conflict')),
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
CREATE TABLE artifact_suggestion (
  id          text primary key,
  artifact_id text not null references artifact (id) on delete cascade,
  block_id    text not null references artifact_block (id) on delete cascade,
  author      text not null,
  at_rev      integer not null,
  change      text not null, -- JSON: protocol.SuggestionChange
  status      text not null default 'open' check (status in ('open', 'accepted', 'rejected')),
  created_at  double precision not null,
  resolved_at double precision,
  resolved_by text
);
CREATE INDEX artifact_suggestion_by_artifact on artifact_suggestion (artifact_id, created_at);
CREATE INDEX artifact_suggestion_open on artifact_suggestion (artifact_id, status);
CREATE INDEX artifact_suggestion_by_block on artifact_suggestion (block_id);

CREATE INDEX channel_by_parent on channel (parent_id) where parent_id is not null;
CREATE INDEX channel_member_by_participant on channel_member (participant_id);
CREATE INDEX channel_read_cursor_by_channel on channel_read_cursor (channel_id);
CREATE INDEX mailbox_delivery_by_message on mailbox_delivery (message_id);
CREATE INDEX mailbox_issue_by_session on mailbox_issue (session_id) where session_id is not null;
CREATE INDEX mailbox_delivery_by_channel on mailbox_delivery (channel_id) where channel_id is not null;
CREATE INDEX cron_by_channel on cron (channel_id);
CREATE INDEX connector_account_by_channel on connector_account (channel_id) where channel_id is not null;
CREATE INDEX connector_inbound_by_message on connector_inbound (message_id) where message_id is not null;
CREATE INDEX connector_outbox_by_message on connector_outbox (message_id);
CREATE INDEX artifact_by_message on artifact (message_id) where message_id is not null;
CREATE INDEX artifact_version_by_message on artifact_version (message_id) where message_id is not null;

CREATE VIEW mailbox_owner_route AS
select routing_scope as scope, routing_position as position from mailbox_trigger
where routed_at is not null and trigger_json::jsonb -> 'actor' ->> 'kind' = 'owner'
union all
select scope, position from mailbox_delivery
where payload_json::jsonb -> 'trigger' -> 'actor' ->> 'kind' = 'owner'
  and envelope_id <> payload_json::jsonb -> 'trigger' ->> 'id';

CREATE TABLE runtime_spend (
  day text NOT NULL,
  runtime text NOT NULL,
  cny double precision NOT NULL CHECK (cny >= 0 AND cny < 'Infinity'::double precision),
  PRIMARY KEY (day, runtime)
);

-- PKM (pkm/pkm.ts): the pages are files in the vault; these hold what the files do not. A remark the owner wrote in a file
-- is kept here by an id made from its block, so its status outlives a reading of the file.
CREATE TABLE pkm_comment (
  id          text primary key,
  page        text not null,      -- the page's slug
  block       text not null,
  span        text,               -- the words an inline remark is on
  author      text not null,      -- the owner's id, or the agent's that proposed the rewrite
  body        text not null,
  status      text not null default 'open' check (status in ('open', 'suggested', 'accepted', 'rejected')),
  suggested   text,               -- the block's text as proposed
  rationale   text,
  created_at  double precision not null,
  resolved_at double precision
);
CREATE INDEX pkm_comment_by_block ON pkm_comment (block, created_at);
CREATE INDEX pkm_comment_by_page ON pkm_comment (page, created_at);

-- The notes' blocks as a search reads them (pkm.search): each block's words, cut as memory cuts them (memory/recall.ts),
-- from its page's title, the path above it and its text. Kept whole by pkm/pkm.ts each time it reads or writes a page.
CREATE TABLE pkm_term (
  block  text not null,
  page   text not null,
  terms  text not null
);
CREATE INDEX pkm_term_terms ON pkm_term USING gin (term_vector(terms));
CREATE INDEX pkm_term_by_page ON pkm_term (page);

-- Each file a change wrote, as it was before (none: the change made it) and after: pkm.undo puts back the newest.
CREATE TABLE pkm_change (
  seq          integer generated by default as identity primary key,
  at           double precision not null,
  what         text not null,
  page         text not null,
  before_file  text,
  after_file   text not null,
  before_text  text,
  after_text   text not null
);

-- The orders they came in: each new row takes one more than the most there was.
CREATE FUNCTION next_seq() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('SELECT coalesce(max(seq), 0) + 1 FROM %I', TG_TABLE_NAME) INTO NEW.seq;
  RETURN NEW;
END $$;
CREATE TRIGGER channel_participant_seq BEFORE INSERT ON channel_participant FOR EACH ROW EXECUTE FUNCTION next_seq();
CREATE TRIGGER mailbox_trigger_seq BEFORE INSERT ON mailbox_trigger FOR EACH ROW EXECUTE FUNCTION next_seq();
CREATE TRIGGER connector_inbound_seq BEFORE INSERT ON connector_inbound FOR EACH ROW EXECUTE FUNCTION next_seq();
-- A delivery's and a routed trigger's position is the next of mailbox_order, taken by their queries
-- (mailbox_delivery.sql, mailbox_trigger.sql); the order is moved past it here so nothing takes it again. A delivery
-- written without one (position 0) is given the next here.
CREATE FUNCTION mailbox_order_past(at integer) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF at > (SELECT coalesce(max(id), 0) FROM mailbox_order) THEN
    INSERT INTO mailbox_order (id) VALUES (at);
  END IF;
END $$;
CREATE FUNCTION mailbox_delivery_position() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.position = 0 THEN
    INSERT INTO mailbox_order (id) SELECT coalesce(max(id), 0) + 1 FROM mailbox_order RETURNING id INTO NEW.position;
  ELSE
    PERFORM mailbox_order_past(NEW.position);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mailbox_delivery_position BEFORE INSERT ON mailbox_delivery FOR EACH ROW EXECUTE FUNCTION mailbox_delivery_position();
CREATE FUNCTION mailbox_trigger_routed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM mailbox_order_past(NEW.routing_position);
  RETURN NEW;
END $$;
CREATE TRIGGER mailbox_trigger_routed AFTER UPDATE OF routing_position ON mailbox_trigger
  FOR EACH ROW WHEN (NEW.routing_position IS NOT NULL) EXECUTE FUNCTION mailbox_trigger_routed();
