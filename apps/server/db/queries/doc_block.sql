-- A document's blocks (doc/doc.ts), tombstones included.

-- name: DocBlocks :many
select * from doc_block where doc_id = sqlc.arg(doc_id) order by order_key, id;

-- name: DocBlockDoc :one
-- Which doc a block id is taken by: ids are the client's, and unique across docs.
select doc_id from doc_block where id = sqlc.arg(id);

-- name: PutDocBlock :exec
insert into doc_block (id, doc_id, parent_id, order_key, type, attrs, spans, rev, deleted, updated_by, updated_at)
values (sqlc.arg(id), sqlc.arg(doc_id), sqlc.narg(parent_id), sqlc.arg(order_key), sqlc.arg(type), sqlc.arg(attrs), sqlc.arg(spans),
        sqlc.arg(rev), sqlc.arg(deleted), sqlc.arg(updated_by), sqlc.arg(updated_at))
on conflict (id) do update set parent_id = excluded.parent_id, order_key = excluded.order_key, type = excluded.type,
  attrs = excluded.attrs, spans = excluded.spans, rev = excluded.rev, deleted = excluded.deleted,
  updated_by = excluded.updated_by, updated_at = excluded.updated_at;
