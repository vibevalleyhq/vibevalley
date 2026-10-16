-- The yard gate (farm/lan.go): whether it is open, and the devices allowed through it. A device's key is kept as its
-- SHA-256 only.

create table lan_gate (
  id    integer primary key check (id = 1),
  open  integer not null
);

create table lan_devices (
  id         text primary key,
  name       text not null,
  key_hash   text not null unique,
  paired_at  integer not null,
  last_seen  integer
);
