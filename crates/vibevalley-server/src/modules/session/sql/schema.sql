create table if not exists session (
  id text primary key,
  role text not null,
  name text not null,
  agent text not null,
  runtime text not null,
  brief text not null,
  repo text,
  branch text,
  worktree text,
  hired_at integer not null,
  runs integer not null,
  last_run text,
  spent text,
  channel text,
  issue text,
  refining integer not null,
  tool_connections text,
  machine text,
  phase text not null,
  departed integer not null default 0
);
create index if not exists session_issue on session (issue);
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
