-- Files the farm keeps, once each by their sha256 (attachment/attachment.ts).

-- name: InsertAttachment :exec
insert into attachment (id, name, type, size, created_at)
values (sqlc.arg(id), sqlc.arg(name), sqlc.arg(type), sqlc.arg(size), sqlc.arg(created_at))
on conflict (id) do nothing;

-- name: AttachmentByID :one
select id, name, type, size from attachment where id = sqlc.arg(id);
