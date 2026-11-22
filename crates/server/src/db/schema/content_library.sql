create table if not exists media_library_item (
  attachment_id text primary key,
  kind          text not null check (kind in ('generated', 'uploaded', 'fetched')),
  origin        text not null,
  added_at      integer not null,
  last_at       integer not null,
  source_job_id text,
  removed_at    integer
);
create index if not exists media_library_item_recent on media_library_item (last_at desc, attachment_id) where removed_at is null;
create unique index if not exists media_library_item_by_job on media_library_item (source_job_id) where source_job_id is not null;
