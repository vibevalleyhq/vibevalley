-- Documents (doc/doc.ts).

-- name: Docs :many
select * from doc order by updated_at desc, id;

-- name: Doc :one
select * from doc where id = sqlc.arg(id);

-- name: AddDoc :exec
insert into doc (id, title, seq, created_at, updated_at) values (sqlc.arg(id), sqlc.arg(title), 0, sqlc.arg(created_at), sqlc.arg(updated_at));

-- name: DocAccepted :exec
-- A batch was taken: the doc's seq is the batch's.
update doc set seq = sqlc.arg(seq), updated_at = sqlc.arg(updated_at) where id = sqlc.arg(id);
