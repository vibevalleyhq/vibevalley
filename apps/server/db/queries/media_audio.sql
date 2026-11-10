-- name: Audio :one
select * from media_audio where id = sqlc.arg(id);

-- name: RecentAudio :many
-- bound: latest 100 tasks; historical IDs remain addressable for idempotency.
select * from media_audio order by created_at desc, id limit 100;

-- name: PendingAudio :many
-- bound: global media admission limits active tasks to eight.
select * from media_audio where phase in ('queued', 'generating', 'downloading');

-- name: AudioCleanup :many
-- bound: at most 100 unresolved terminal cleanups per startup; completed cleanups do not hide older failures.
select * from media_audio
where (phase in ('ready', 'failed') or (phase = 'canceled' and not exists (
    select 1 from media_remote_file where holder = media_audio.id
  )))
  and (
    exists (select 1 from media_remote_file where holder = media_audio.id and phase != 'deleted')
    or (input is not null and result is null and exists (
      select 1 from media_input_pin where holder = media_audio.id
    ))
  )
order by updated_at, id limit 100;

-- name: InsertAudio :exec
insert into media_audio (id, kind, request, source, input, connection, revision, model, fingerprint, phase, created_at, updated_at)
values (sqlc.arg(id), sqlc.arg(kind), sqlc.arg(request), sqlc.arg(source), sqlc.narg(input), sqlc.arg(connection), sqlc.arg(revision),
  sqlc.arg(model), sqlc.arg(fingerprint), 'queued', sqlc.arg(now)::float8, sqlc.arg(now)::float8);

-- name: ChangeAudio :exec
update media_audio set phase = sqlc.arg(phase), remote_task_id = sqlc.narg(remote_task_id), result_url = sqlc.narg(result_url),
  result = sqlc.narg(result), attachment = sqlc.narg(attachment), result_input = sqlc.narg(result_input), preview_input = sqlc.narg(preview_input),
  result_format = sqlc.narg(result_format), content_type = sqlc.narg(content_type), metadata = sqlc.narg(metadata),
  usage = sqlc.narg(usage),
  problem = sqlc.arg(problem), updated_at = sqlc.arg(now)::float8 where id = sqlc.arg(id);

-- name: InterruptAudio :exec
update media_audio set phase = case when phase = 'queued' then 'canceled' else 'unknown' end,
  problem = sqlc.arg(problem), updated_at = sqlc.arg(now)::float8 where phase = 'queued' or
  (phase = 'generating' and (remote_task_id is null or (request::jsonb -> 'streaming') = 'true'::jsonb));

-- name: ReleaseAudioAssets :exec
update media_audio set input = null, result_input = null, preview_input = null, result_url = null,
  assets_released = 1, updated_at = sqlc.arg(now)::float8
where id = sqlc.arg(id) and phase not in ('queued', 'generating', 'downloading');
