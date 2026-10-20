-- Each block's text by rev (doc/doc.go): the base a stale update is read against, and what lost a conflict.

-- name: AddDocBlockRevision :exec
insert into doc_block_revision (id, block_id, rev, spans, actor, kind, created_at) values (?, ?, ?, ?, ?, ?, ?);

-- name: DocBlockRevision :one
select spans from doc_block_revision where block_id = ? and rev = ? and kind = 'normal' order by created_at desc limit 1;
