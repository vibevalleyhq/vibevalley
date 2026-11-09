-- name: Input :one
select *, exists(select 1 from media_input_pin where input_id = media_input.id)::int as pinned from media_input where id = sqlc.arg(id);

-- name: Inputs :many
-- bound: admission allows at most 256 input reservations, including failed and deleting rows.
select *, exists(select 1 from media_input_pin where input_id = media_input.id)::int as pinned from media_input order by created_at desc, id;

-- name: ExpiredInputs :many
-- bound: admission allows at most 256 input reservations.
select *, 0::int as pinned from media_input where (expires_at <= sqlc.arg(now)::int or phase = 'deleting')
and not exists(select 1 from media_input_pin where input_id = media_input.id);

-- name: InputCapacity :one
select coalesce(sum(size), 0)::int as bytes, count(*)::int as count from media_input;

-- name: InsertInput :exec
insert into media_input (id, metadata, size, phase, created_at, expires_at)
values (sqlc.arg(id), sqlc.arg(metadata), sqlc.arg(size)::int, 'reserved', sqlc.arg(now)::int, sqlc.arg(expires)::int);

-- name: ChangeInput :exec
update media_input set phase = sqlc.arg(phase), hash = sqlc.narg(hash), expires_at = sqlc.arg(expires)::int where id = sqlc.arg(id);

-- name: DeleteInput :exec
delete from media_input where id = sqlc.arg(id);

-- name: OtherInputHash :one
select count(*)::int as count from media_input where hash = sqlc.arg(hash) and id != sqlc.arg(id);

-- name: InterruptInputs :exec
update media_input set phase = 'failed' where phase = 'uploading';
