-- Media jobs of every kind (media/): one table, told apart by kind.

-- name: MediaJob :one
-- Any kind: an id taken by another kind is refused as a different job.
select * from media_job where id = sqlc.arg(id);

-- name: RecentMediaJobs :many
-- bound: the latest 100 of these kinds; older jobs stay addressable by id for idempotency.
select * from media_job where kind = any(sqlc.arg(kinds)::text[]) order by created_at desc, id limit 100;

-- name: PendingMediaJobs :many
-- bound: media admission keeps at most eight jobs active.
select * from media_job where kind = any(sqlc.arg(kinds)::text[]) and phase in ('queued', 'generating', 'downloading');

-- name: InsertMediaJob :exec
insert into media_job (id, kind, request, source, connection, revision, model, phase, input, inputs, credential_hash, fingerprint, "authorization", cleanup, created_at, updated_at)
values (sqlc.arg(id), sqlc.arg(kind), sqlc.arg(request), sqlc.arg(source), sqlc.arg(connection), sqlc.arg(revision)::int, sqlc.arg(model), sqlc.arg(phase),
  sqlc.narg(input), coalesce(sqlc.narg(inputs), '[]'), coalesce(sqlc.narg(credential_hash), ''), coalesce(sqlc.narg(fingerprint), ''), sqlc.narg(authorization),
  coalesce(sqlc.narg(cleanup), 'done'), sqlc.arg(now)::float8, sqlc.arg(now)::float8);

-- name: ChangeImageJob :exec
update media_job set phase = sqlc.arg(phase), result_url = sqlc.narg(result_url), attachment = sqlc.narg(attachment), usage = sqlc.narg(usage),
problem = sqlc.arg(problem), updated_at = sqlc.arg(now)::float8 where id = sqlc.arg(id);

-- name: ChangeSpeechJob :exec
update media_job set phase = sqlc.arg(phase), result_url = sqlc.narg(result_url), attachment = sqlc.narg(attachment),
remote_task = sqlc.narg(remote_task), result_format = sqlc.narg(result_format), content_type = sqlc.narg(content_type), metadata = sqlc.narg(metadata), usage = sqlc.narg(usage),
result_input = sqlc.narg(result_input),
problem = sqlc.arg(problem), updated_at = sqlc.arg(now)::float8 where id = sqlc.arg(id);

-- name: ChangeAudioJob :exec
update media_job set phase = sqlc.arg(phase), remote_task = sqlc.narg(remote_task), result_url = sqlc.narg(result_url),
  result = sqlc.narg(result), attachment = sqlc.narg(attachment), result_input = sqlc.narg(result_input), preview_input = sqlc.narg(preview_input),
  result_format = sqlc.narg(result_format), content_type = sqlc.narg(content_type), metadata = sqlc.narg(metadata),
  usage = sqlc.narg(usage),
  problem = sqlc.arg(problem), updated_at = sqlc.arg(now)::float8 where id = sqlc.arg(id);

-- name: ChangeUnderstandingJob :exec
update media_job set phase = sqlc.arg(phase), source = sqlc.arg(source), result = sqlc.narg(result), cleanup = sqlc.arg(cleanup), problem = sqlc.arg(problem),
updated_at = sqlc.arg(now)::float8 where id = sqlc.arg(id);

-- name: InterruptImageJobs :exec
-- A restart: an image job never asked again was canceled; one asked may have been made, so it is unknown.
update media_job set phase = case when phase = 'queued' then 'canceled' else 'unknown' end,
problem = sqlc.arg(problem), updated_at = sqlc.arg(now)::float8 where kind = 'image' and phase in ('queued', 'generating');

-- name: InterruptRemoteJobs :exec
-- A restart for jobs a vendor runs as its own task (speech, audio): one with a remote task (not streamed) is followed up instead.
update media_job set phase = case when phase = 'queued' then 'canceled' else 'unknown' end,
problem = sqlc.arg(problem), updated_at = sqlc.arg(now)::float8 where kind = any(sqlc.arg(kinds)::text[]) and (phase = 'queued' or
  (phase = 'generating' and (remote_task is null or (request::jsonb -> 'streaming') = 'true'::jsonb)));

-- name: InterruptUnderstandingJobs :exec
update media_job set
phase = case when phase in ('authorized','queued') then 'canceled' when phase in ('uploading','generating') then 'unknown' else phase end,
cleanup = case when phase in ('authorized','queued') then 'done' when cleanup = 'running' then 'blocked' else cleanup end,
problem = case when phase in ('authorized','queued','uploading','generating') then sqlc.arg(problem)::text else problem end,
updated_at = sqlc.arg(now)::float8 where kind = 'understanding' and (phase in ('authorized','queued','uploading','generating') or cleanup = 'running');

-- name: ActiveUnderstandingJobs :many
-- bound: admission shares the limit of eight active jobs.
select * from media_job where kind = 'understanding' and (phase in ('authorized','queued','uploading','generating') or cleanup = 'running');

-- name: AudioCleanup :many
-- bound: at most 100 unresolved terminal cleanups per startup; completed cleanups do not hide older failures.
select * from media_job
where kind in ('speakers', 'voiceDesign', 'clone', 'transcription')
  and (phase in ('ready', 'failed') or (phase = 'canceled' and not exists (
    select 1 from media_remote_file where holder = media_job.id
  )))
  and (
    exists (select 1 from media_remote_file where holder = media_job.id and phase != 'deleted')
    or (input is not null and result is null and exists (
      select 1 from media_input_pin where holder = media_job.id
    ))
  )
order by updated_at, id limit 100;

-- name: ReleaseMediaJobAssets :exec
-- What it holds goes: its inputs, its results kept as inputs, and the vendor's address; the job stays.
update media_job set input = null, result_input = null, preview_input = null, result_url = null, assets_released = 1, updated_at = sqlc.arg(now)::float8
where id = sqlc.arg(id) and phase not in ('queued', 'generating', 'downloading');
