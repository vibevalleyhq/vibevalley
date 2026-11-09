-- name: Speech :one
select * from media_speech where id = sqlc.arg(id);

-- name: RecentSpeech :many
-- bound: the latest 100 tasks; historical tasks remain addressable by ID for idempotency.
select * from media_speech order by created_at desc, id limit 100;

-- name: PendingSpeech :many
-- bound: at most 8 admitted media tasks can be active.
select * from media_speech where phase in ('queued', 'generating', 'downloading');

-- name: InsertSpeech :exec
insert into media_speech (id, request, source, connection, revision, model, credential_hash, phase, created_at, updated_at)
values (sqlc.arg(id), sqlc.arg(request), sqlc.arg(source), sqlc.arg(connection), sqlc.arg(revision), sqlc.arg(model), sqlc.arg(credential_hash), 'queued', sqlc.arg(now)::int, sqlc.arg(now)::int);

-- name: ChangeSpeech :exec
update media_speech set phase = sqlc.arg(phase), result_url = sqlc.narg(result_url), attachment = sqlc.narg(attachment),
remote_task = sqlc.narg(remote_task), result_format = sqlc.narg(result_format), content_type = sqlc.narg(content_type), metadata = sqlc.narg(metadata), usage = sqlc.narg(usage),
result_input = sqlc.narg(result_input),
problem = sqlc.arg(problem), updated_at = sqlc.arg(now)::int where id = sqlc.arg(id);

-- name: InterruptSpeech :exec
update media_speech set phase = case when phase = 'queued' then 'canceled' else 'unknown' end,
problem = sqlc.arg(problem), updated_at = sqlc.arg(now)::int where phase = 'queued' or (phase = 'generating' and (remote_task is null or json_extract(request, '$.streaming') = 1));

-- name: ReleaseSpeechAssets :exec
update media_speech set result_input = null, result_url = null, assets_released = 1, updated_at = sqlc.arg(now)::int
where id = sqlc.arg(id) and phase not in ('queued', 'generating', 'downloading');
