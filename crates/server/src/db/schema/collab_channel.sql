create table if not exists channel_participant (
  id text primary key,
  kind text not null check (kind in ('user', 'agent', 'system')),
  name text not null,
  agent_id text,
  home_id text,
  joined_at integer not null,
  left_at integer,
  check (kind = 'agent' or agent_id is null)
);
create table if not exists channel (
  id text primary key,
  type text not null check (type in ('channel', 'direct', 'thread')),
  is_default integer not null default 0,
  root_id text unique,
  root_number integer,
  subject_kind text check (subject_kind in ('issue', 'talk')),
  subject_id text,
  last_number integer,
  reply_count integer not null default 0,
  created_at integer not null,
  name text,
  description text,
  repo text,
  parent_id text references channel (id),
  peer_id text unique references channel_participant (id),
  revision integer not null default 0,
  category text,
  position integer,
  archived_at integer,
  notify text not null default 'all' check (notify in ('all', 'mentions', 'none'))
);
create table if not exists channel_message (
  id text primary key,
  channel_id text not null references channel (id),
  number integer not null,
  sender_id text not null references channel_participant (id),
  kind text not null check (kind in ('chat', 'dispatch', 'report', 'notice')),
  body text not null,
  meta text,
  send_key text,
  created_at integer not null,
  revision integer not null,
  reply_number integer,
  edited_at integer,
  deleted_at integer,
  pinned_at integer,
  reactions text,
  unique (channel_id, number),
  unique (channel_id, revision)
);
create table if not exists channel_mention (
  message_id text not null references channel_message (id) on delete cascade,
  target_id text not null,
  resolved text not null check (resolved in ('delivered', 'absent', 'unknown')),
  primary key (message_id, target_id)
);
create table if not exists channel_member (
  channel_id text not null references channel (id),
  participant_id text not null references channel_participant (id),
  reason text not null check (reason in ('user', 'replied', 'mentioned', 'manual')),
  from_number integer not null,
  left_at integer,
  primary key (channel_id, participant_id)
);
create table if not exists channel_read_cursor (
  participant_id text not null references channel_participant (id),
  channel_id text not null references channel (id),
  read_number integer not null,
  updated_at integer not null,
  primary key (participant_id, channel_id)
);
create table if not exists channel_seen (
  participant_id text not null references channel_participant (id),
  message_id text not null references channel_message (id) on delete cascade,
  seen_at integer not null,
  primary key (participant_id, message_id)
);
create table if not exists channel_event (
  seq integer primary key autoincrement,
  kind text not null check (kind in ('posted', 'removed')),
  channel_id text not null,
  message_id text not null,
  at integer not null
);
create table if not exists channel_delivery (
  id integer primary key autoincrement,
  message_id text not null references channel_message (id) on delete cascade,
  channel_id text not null references channel (id) on delete cascade,
  recipient_kind text not null check (recipient_kind in ('session', 'issue', 'orchestrator', 'direct')),
  recipient_id text not null,
  reason text not null check (reason in ('mention', 'everyone', 'own_thread', 'member', 'channel', 'direct', 'addressed')),
  wakes integer not null default 0,
  held_by text check (held_by in ('hop_limit', 'cooldown')),
  status text not null default 'pending' check (status in ('pending', 'delivered', 'withdrawn', 'failed')),
  created_at integer not null,
  settled_at integer,
  unique (message_id, recipient_kind, recipient_id)
);
create unique index if not exists channel_by_name on channel (name) where name is not null and type <> 'thread';
create index if not exists channel_by_subject on channel (subject_kind, subject_id);
create unique index if not exists channel_one_default on channel (is_default) where is_default;
create index if not exists channel_by_parent on channel (parent_id) where parent_id is not null;
create index if not exists channel_mention_by_target on channel_mention (target_id, message_id);
create index if not exists channel_message_by_channel on channel_message (channel_id, number);
create index if not exists channel_message_by_sender on channel_message (sender_id, id);
create unique index if not exists channel_message_send_key on channel_message (sender_id, send_key) where send_key is not null;
create index if not exists channel_event_by_message on channel_event (message_id);
create index if not exists channel_delivery_by_recipient on channel_delivery (recipient_kind, recipient_id, status, id);
create index if not exists channel_delivery_by_message on channel_delivery (message_id, status);
create index if not exists channel_member_by_participant on channel_member (participant_id);
create index if not exists channel_read_cursor_by_channel on channel_read_cursor (channel_id);
create index if not exists channel_seen_by_message on channel_seen (message_id);

create view if not exists channel_message_detail as
select m.*, p.name as sender_name, p.kind as sender_kind, p.agent_id as sender_agent
from channel_message m join channel_participant p on p.id = m.sender_id;

create view if not exists channel_message_location as
select d.*, c.type as channel_type, c.root_number,
       cast(coalesce(c.parent_id, c.id) as text) as top_id, cast(coalesce(ch.name, c.name, '') as text) as channel_name
from channel_message_detail d join channel c on c.id = d.channel_id left join channel ch on ch.id = c.parent_id;
