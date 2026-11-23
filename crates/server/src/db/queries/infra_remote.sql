-- name: GetConfig :one
select enabled, bind_addr, port, updated_at
from remote_config
where id = 1;

-- name: SaveConfig :exec
insert into remote_config (id, enabled, bind_addr, port, updated_at)
values (1, ?1, ?2, ?3, ?4)
on conflict (id) do update set
  enabled = excluded.enabled,
  bind_addr = excluded.bind_addr,
  port = excluded.port,
  updated_at = excluded.updated_at;

-- name: InsertDevice :exec
insert into remote_device (id, name, platform, token_hash, scope, created_at)
values (?1, ?2, ?3, ?4, ?5, ?6);

-- name: FindDeviceByTokenHash :one
select id, name, platform, scope, created_at, last_seen_at, revoked_at
from remote_device
where token_hash = ?1;

-- name: FindDeviceById :one
select id, name, platform, scope, created_at, last_seen_at, revoked_at
from remote_device
where id = ?1;

-- name: ListDevices :many
select id, name, platform, scope, created_at, last_seen_at, revoked_at
from remote_device
order by created_at desc;

-- name: TouchDeviceLastSeen :exec
update remote_device
set last_seen_at = ?2
where id = ?1;

-- name: RevokeDevice :exec
update remote_device
set revoked_at = ?2
where id = ?1 and revoked_at is null;
