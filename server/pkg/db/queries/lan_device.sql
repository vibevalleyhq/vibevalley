-- The devices paired for lan access (lan/lan.go).

-- name: LanDevices :many
select * from lan_device;

-- name: AddLanDevice :exec
insert into lan_device (id, name, key_hash, paired_at) values (?, ?, ?, ?);

-- name: RemoveLanDevice :exec
delete from lan_device where id = ?;

-- name: SeenLanDevice :exec
update lan_device set last_seen = ? where id = ?;
