create table if not exists connector_account (
  connector     text primary key,
  secrets       text not null,
  user_id       text,
  pair_code     text,
  cursor        text not null default '',
  reply_context text,
  last_inbound  integer,
  paused_until  integer,
  connected_at  integer not null,
  channel_id    text
);
create table if not exists connector_inbound (
  seq          integer primary key autoincrement,
  connector    text not null,
  ext_id       text not null,
  from_id      text not null,
  body         text not null,
  reply        text not null,
  quoted       text not null,
  message_id   text,
  created_at   integer not null,
  delivered    integer not null default 0,
  unique (connector, ext_id)
);
create table if not exists connector_outbox (
  seq        integer primary key autoincrement,
  connector  text not null,
  message_id text not null,
  body       text not null,
  state      text not null default 'pending' check (state in ('pending', 'sent', 'dropped')),
  ext_id     text,
  error      text,
  created_at integer not null,
  sent_at    integer
);
create index if not exists connector_outbox_waiting on connector_outbox (connector, state, seq);
create index if not exists connector_outbox_ext on connector_outbox (connector, ext_id);
