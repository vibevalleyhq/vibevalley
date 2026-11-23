create table if not exists remote_config (
  id         integer primary key check (id = 1),
  enabled    integer not null default 0,
  bind_addr  text,
  port       integer not null,
  updated_at integer not null
);

create table if not exists remote_device (
  id           text primary key,
  name         text not null,
  platform     text not null,
  token_hash   text not null unique,
  scope        text not null,
  created_at   integer not null,
  last_seen_at integer,
  revoked_at   integer
);
