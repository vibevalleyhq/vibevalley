-- Documents (doc/doc.go).

-- name: Docs :many
select * from doc order by updated_at desc, id;

-- name: Doc :one
select * from doc where id = ?;

-- name: AddDoc :exec
insert into doc (id, title, seq, created_at, updated_at) values (?, ?, 0, ?, ?);

-- name: DocAccepted :exec
-- A batch was taken: the doc's seq is the batch's.
update doc set seq = sqlc.arg(seq), updated_at = sqlc.arg(updated_at) where id = sqlc.arg(id);
