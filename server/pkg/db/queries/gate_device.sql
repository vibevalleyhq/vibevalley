-- The devices let in through the yard gate (gate/gate.go).

-- name: LanDevices :many
select * from gate_device;

-- name: AddLanDevice :exec
insert into gate_device (id, name, key_hash, paired_at) values (?, ?, ?, ?);

-- name: RemoveLanDevice :exec
delete from gate_device where id = ?;

-- name: SeenLanDevice :exec
update gate_device set last_seen = ? where id = ?;
