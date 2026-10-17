-- A session is a row from the start (.agents/notes/proposed/architecture/2026-10-17-session-run-step.md): who, for which
-- issue and project, when it started and ended and how its issue took it. Its runs are session_run; its events are
-- events/<id>.json. The heads in events/*.head.json are moved in on load (session/records.go).
create table session (
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
create index session_by_agent on session (agent, hired_at);
