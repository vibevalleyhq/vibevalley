create table if not exists issue (
  id           text primary key,
  number       integer not null unique,
  title        text not null,
  description  text not null,
  repo         text,
  priority     text not null,
  rank         integer,
  deliver      text not null,
  parent       text,
  cron         text,
  created_at   integer not null,
  queued_at    integer,
  closed_at    integer,
  reviewed_at  integer,
  canceled     text,
  delivered    text,
  mandate      text not null,
  constraints  text,
  conflict     text,
  pull_request text,
  last_run     text,
  answer       text,
  blocked_by   text not null,
  criteria     text not null,
  checks       text not null,
  findings     text not null,
  questions    text not null,
  assignments  text not null
);
create table if not exists issue_delivery_evidence (issue_id text primary key, evidence text not null);
create index if not exists issue_parent on issue (parent);
create table if not exists issue_word (
  seq        integer primary key autoincrement,
  issue      text not null,
  text       text not null,
  created_at integer not null
);
create index if not exists issue_word_waiting on issue_word (issue, seq);
create table if not exists issue_counter (
  id          integer primary key check (id = 1),
  last_number integer not null
);
