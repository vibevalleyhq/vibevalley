create table if not exists session (
  id text primary key,
  controller text not null,
  role text,
  name text not null,
  profile text,
  runtime text not null,
  brief text not null,
  cwd text,
  policy text not null,
  bindings text not null,
  hired_at integer not null,
  runs integer not null,
  last_run text,
  spent text,
  tool_connections text,
  machine text,
  phase text not null,
  departed integer not null default 0,
  title text,
  model text,
  effort text,
  permission_mode text
);
create index if not exists session_departed on session (departed, hired_at);
create table if not exists session_run_subagents (
  run text primary key, summary text not null
);
create table if not exists session_extra (
  session text primary key, agent_session text, base text, run text
);
create table if not exists session_run (
  id text primary key, session text not null, issue text,
  triggered_by text not null, heard text not null, started_at integer not null,
  ended_at integer, outcome text, summary text not null, spent text
);
create index if not exists session_run_issue on session_run (issue, started_at);
create index if not exists session_run_session on session_run (session, started_at desc);
create table if not exists session_counter (
  name text primary key, last_number integer not null
);
create table if not exists session_mailbox (
  id integer primary key autoincrement,
  session_id text not null,
  idempotency_key text not null unique,
  source text not null,
  payload text not null,
  status text not null,
  created_at integer not null,
  updated_at integer not null,
  result text
);
create index if not exists session_mailbox_pending on session_mailbox (session_id, status, id);
create table if not exists session_event (
  session_id text not null,
  seq integer not null,
  run_id text,
  payload text not null,
  primary key (session_id, seq)
);
create index if not exists session_event_run on session_event (session_id, run_id, seq);
