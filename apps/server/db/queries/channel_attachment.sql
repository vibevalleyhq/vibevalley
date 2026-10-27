-- Files said with a message, kept once by their sha256 (channel/attachments.ts).

-- name: InsertAttachment :exec
insert into channel_attachment (id, name, type, size, created_at)
values (sqlc.arg(id), sqlc.arg(name), sqlc.arg(type), sqlc.arg(size), sqlc.arg(created_at))
on conflict (id) do nothing;

-- name: AttachmentByID :one
select id, name, type, size from channel_attachment where id = sqlc.arg(id);
