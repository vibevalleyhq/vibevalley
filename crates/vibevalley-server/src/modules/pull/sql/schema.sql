create table if not exists pull (
  id                text primary key,
  platform          text not null check (platform in ('github', 'gitlab')),
  repo              text not null,
  number            integer not null,
  url               text not null,
  branch            text not null default '',
  base              text not null default '',
  state             text not null check (state in ('open', 'merged', 'closed')),
  issue_id          text references issue (id) on delete set null,
  check_fingerprint text not null default '',
  check_revision    integer not null default 0,
  created_at        integer not null,
  updated_at        integer not null,
  unique (repo, number)
);
create index if not exists pull_by_issue on pull (issue_id) where issue_id is not null;
create index if not exists pull_by_state on pull (state) where state = 'open';

create table if not exists pull_event (
  pull_id       text not null references pull (id) on delete cascade,
  key           text not null,
  bot_round_key text,
  bot_round     integer,
  primary key (pull_id, key)
);
