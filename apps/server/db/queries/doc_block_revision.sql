-- Each block's text by rev (doc/doc.ts): the base a stale update is read against, and what lost a conflict.

-- name: AddDocBlockRevision :exec
insert into doc_block_revision (id, block_id, rev, spans, actor, kind, created_at)
values (sqlc.arg(id), sqlc.arg(block_id), sqlc.arg(rev), sqlc.arg(spans), sqlc.arg(actor), sqlc.arg(kind), sqlc.arg(created_at));

-- name: DocBlockRevision :one
select spans from doc_block_revision where block_id = sqlc.arg(block_id) and rev = sqlc.arg(rev) and kind = 'normal' order by created_at desc limit 1;
