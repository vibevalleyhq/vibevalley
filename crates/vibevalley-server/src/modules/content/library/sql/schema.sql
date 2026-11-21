create table if not exists media_library_item (
  attachment_id text primary key,
  kind          text not null check (kind in ('generated', 'uploaded', 'fetched')),
  origin        text not null,
  added_at      integer not null,
  last_at       integer not null
);
create table if not exists media_library_job (job_id text primary key);
create index if not exists media_library_item_recent on media_library_item (last_at desc, attachment_id);
