-- name: Generation :one
select * from media_generation where id = sqlc.arg(id);

-- name: RecentGenerations :many
-- bound: the latest 100 tasks; historical tasks remain addressable by ID for idempotency.
select * from media_generation order by created_at desc, id limit 100;

-- name: PendingGenerations :many
-- bound: at most 8 admitted tasks can be active.
select * from media_generation where phase in ('queued', 'generating', 'downloading');

-- name: InsertGeneration :exec
insert into media_generation (id, request, source, connection, revision, model, phase, created_at, updated_at)
values (sqlc.arg(id), sqlc.arg(request), sqlc.arg(source), sqlc.arg(connection), sqlc.arg(revision), sqlc.arg(model), 'queued', sqlc.arg(now)::int, sqlc.arg(now)::int);

-- name: ChangeGeneration :exec
update media_generation set phase = sqlc.arg(phase), result_url = sqlc.narg(result_url), attachment = sqlc.narg(attachment), usage = sqlc.narg(usage),
problem = sqlc.arg(problem), updated_at = sqlc.arg(now)::int where id = sqlc.arg(id);

-- name: InterruptGenerations :exec
update media_generation set phase = case when phase = 'queued' then 'canceled' else 'unknown' end,
problem = sqlc.arg(problem), updated_at = sqlc.arg(now)::int where phase in ('queued', 'generating');
