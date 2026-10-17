-- What happened to each playbook (playbook/log.go).

-- name: AddPlaybookEvent :exec
insert into playbook_event (playbook_id, node_id, kind, actor, payload, created_at) values (?, ?, ?, ?, ?, ?);

-- name: PlaybookEvents :many
select * from playbook_event where playbook_id = ? order by seq limit ?;
