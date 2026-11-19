create table if not exists pkm_comment (
  id          text primary key,
  page        text not null,
  block       text not null,
  span        text,
  author      text not null,
  body        text not null,
  status      text not null default 'open' check (status in ('open', 'suggested', 'accepted', 'rejected')),
  suggested   text,
  rationale   text,
  created_at  integer not null,
  resolved_at integer
);
create index if not exists pkm_comment_by_block on pkm_comment (block, created_at);
create index if not exists pkm_comment_by_page on pkm_comment (page, created_at);
create table if not exists pkm_term (
  block  text not null,
  page   text not null,
  terms  text not null
);
create index if not exists pkm_term_by_page on pkm_term (page);
create table if not exists pkm_change (
  seq          integer primary key autoincrement,
  at           integer not null,
  what         text not null,
  page         text not null,
  before_file  text,
  after_file   text not null,
  before_text  text,
  after_text   text not null
);
