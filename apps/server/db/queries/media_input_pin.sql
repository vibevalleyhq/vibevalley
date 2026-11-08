-- name: InputPinnedBy :one
select exists(select 1 from media_input_pin where input_id = sqlc.arg(id) and holder = sqlc.arg(holder))::int as pinned;

-- name: PinInput :exec
insert into media_input_pin (input_id, holder) values (sqlc.arg(id), sqlc.arg(holder)) on conflict do nothing;

-- name: UnpinInputs :exec
delete from media_input_pin where holder = sqlc.arg(holder);
