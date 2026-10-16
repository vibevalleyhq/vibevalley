-- Issues (tickets/issues.go; the board calls them 工单): a job from when it is written down until it closes, one id all
-- along. The helpers that worked it are its runs, oldest first. The board's 待办 move here with their ids; the backlog
-- table is left as it was.

create table issue (
  id          text primary key,
  text        text not null,
  project     text,
  agent       text,
  priority    text not null default 'normal' check (priority in ('urgent', 'high', 'normal', 'low')),
  rank        integer not null default 0,
  created_at  integer not null,
  queued_at   integer,
  closed_at   integer,
  closed      text check (closed in ('harvested', 'merged', 'dismissed', 'lost')),
  playbook    text
);

create table issue_run (
  run         text primary key,
  issue       text not null references issue (id) on delete cascade,
  started_at  integer not null
);

create index issue_run_by_issue on issue_run (issue, started_at);

insert into issue (id, text, project, agent, priority, rank, created_at, queued_at)
  select id, text, project, agent, priority, rank, created_at, queued_at from backlog;
