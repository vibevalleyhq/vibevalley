-- name: Understanding :one
select * from media_understanding where id = sqlc.arg(id);

-- name: RecentUnderstanding :many
-- bound: the most recent 100 tasks; historical IDs remain addressable for idempotency.
select * from media_understanding order by created_at desc, id limit 100;

-- name: ActiveUnderstanding :many
-- bound: admission shares the limit of eight active tasks with image generation.
select * from media_understanding where phase in ('queued','uploading','generating') or cleanup = 'running';

-- name: InsertUnderstanding :exec
insert into media_understanding (id, request, inputs, connection, revision, model, phase, cleanup, created_at, updated_at)
values (sqlc.arg(id), sqlc.arg(request), sqlc.arg(inputs), sqlc.arg(connection), sqlc.arg(revision)::int, sqlc.arg(model), 'queued', 'pending', sqlc.arg(now)::int, sqlc.arg(now)::int);

-- name: ChangeUnderstanding :exec
update media_understanding set phase = sqlc.arg(phase), result = sqlc.narg(result), cleanup = sqlc.arg(cleanup), problem = sqlc.arg(problem), updated_at = sqlc.arg(now)::int where id = sqlc.arg(id);

-- name: InterruptUnderstanding :exec
update media_understanding set
phase = case when phase = 'queued' then 'canceled' when phase in ('uploading','generating') then 'unknown' else phase end,
cleanup = case when phase = 'queued' then 'done' when cleanup = 'running' then 'blocked' else cleanup end,
problem = case when phase in ('queued','uploading','generating') then sqlc.arg(problem)::text else problem end,
updated_at = sqlc.arg(now)::int where phase in ('queued','uploading','generating') or cleanup = 'running';
