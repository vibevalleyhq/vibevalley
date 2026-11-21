create table if not exists cron (
  id          text primary key,
  name        text not null,
  body        text not null,
  channel_id  text not null,
  agent       text,
  repo        text,
  issue_id    text references issue (id) on delete set null,
  spec        text not null,
  tz          text not null,
  enabled     integer not null default 1,
  created_at  integer not null,
  last_run    integer,
  set_by      text not null default 'user' check (set_by in ('user', 'agent', 'system')),
  pending     integer not null default 0
);
create index if not exists cron_by_channel on cron (channel_id);
create index if not exists cron_by_issue on cron (issue_id) where issue_id is not null;
