create table if not exists artifact (
  id            text primary key,
  title         text not null,
  body          text not null check (body in ('blocks', 'html', 'store')),
  artifact_type text check (artifact_type is null or artifact_type in ('docs', 'slides', 'dashboard', 'motion', 'whiteboard', 'design', 'design-system')),
  is_default    integer not null default 0 check (not is_default or artifact_type = 'design-system'),
  display       text check ((body = 'html') = (display is not null) and (display is null or display in ('page', 'slides', 'motion'))),
  channel_id    text,
  message_id    text,
  issue         text references issue (id) on delete set null,
  by_id         text not null,
  by_name       text not null,
  version       integer not null,
  seq           integer not null default 0,
  created_at    integer not null,
  updated_at    integer not null
);
create index if not exists artifact_by_channel on artifact (channel_id, updated_at);
create index if not exists artifact_by_issue on artifact (issue, updated_at);
create index if not exists artifact_by_type on artifact (artifact_type, updated_at);
create unique index if not exists artifact_default_design_system on artifact (artifact_type) where is_default = 1;
create table if not exists artifact_version (
  artifact_id text not null references artifact (id) on delete cascade,
  version     integer not null,
  attachment_id text not null,
  size        integer not null,
  note        text,
  by_id       text not null,
  by_name     text not null,
  message_id  text,
  created_at  integer not null,
  primary key (artifact_id, version)
);
create table if not exists artifact_block (
  id          text primary key,
  artifact_id text not null references artifact (id) on delete cascade,
  parent_id   text,
  order_key   text not null,
  type        text not null check (type in ('paragraph', 'heading', 'bulleted', 'numbered', 'todo', 'quote', 'code', 'divider', 'image', 'issue_ref', 'memory_item')),
  attrs       text not null default '{}',
  spans       text not null default '[]',
  rev         integer not null,
  deleted     integer not null default 0,
  updated_by  text not null,
  updated_at  integer not null
);
create index if not exists artifact_block_by_artifact on artifact_block (artifact_id, order_key, id);
create table if not exists artifact_block_revision (
  id         text primary key,
  block_id   text not null references artifact_block (id) on delete cascade,
  rev        integer not null,
  spans      text not null,
  actor      text not null,
  kind       text not null check (kind in ('normal', 'conflict')),
  created_at integer not null
);
create index if not exists artifact_block_revision_by_block on artifact_block_revision (block_id, rev);
create table if not exists artifact_change (
  artifact_id text not null references artifact (id) on delete cascade,
  seq         integer not null,
  batch_id    text not null unique,
  actor       text not null,
  block_ids   text not null,
  results     text not null,
  created_at  integer not null,
  primary key (artifact_id, seq)
);
create table if not exists artifact_suggestion (
  id          text primary key,
  artifact_id text not null references artifact (id) on delete cascade,
  block_id    text not null references artifact_block (id) on delete cascade,
  author      text not null,
  at_rev      integer not null,
  change      text not null,
  status      text not null default 'open' check (status in ('open', 'accepted', 'rejected')),
  created_at  integer not null,
  resolved_at integer,
  resolved_by text
);
create index if not exists artifact_suggestion_by_artifact on artifact_suggestion (artifact_id, created_at);
create table if not exists artifact_entry (
  artifact_id   text not null references artifact (id) on delete cascade,
  path          text not null,
  kind          text not null check (kind in ('text', 'json', 'asset')),
  mime          text not null,
  value         text,
  attachment_id text,
  size          integer not null,
  rev           integer not null,
  updated_by    text not null,
  updated_at    integer not null,
  primary key (artifact_id, path)
);
create index if not exists artifact_entry_by_artifact on artifact_entry (artifact_id, path);
create table if not exists artifact_entry_change (
  artifact_id text not null references artifact (id) on delete cascade,
  seq         integer not null,
  actor       text not null,
  paths       text not null,
  deleted     text not null,
  created_at  integer not null,
  primary key (artifact_id, seq)
);
create index if not exists artifact_entry_change_by_created on artifact_entry_change (created_at);
