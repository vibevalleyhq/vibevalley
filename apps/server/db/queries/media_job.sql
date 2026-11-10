-- Media jobs of every kind (media/): one table and one machine (media/machine.ts), told apart by kind.

-- name: MediaJob :one
-- Any kind: an id taken by another kind is refused as a different job.
select * from media_job where id = sqlc.arg(id);

-- name: RecentMediaJobs :many
-- bound: the latest 100 jobs of every kind; older jobs stay addressable by id for idempotency.
select * from media_job order by created_at desc, id limit 100;

-- name: ActiveMediaJobs :many
-- bound: admission keeps at most eight jobs active, waiting, running or cleaning up what they uploaded.
select * from media_job where phase in ('authorized', 'queued', 'uploading', 'generating', 'downloading') or cleanup = 'running';

-- name: InsertMediaJob :exec
insert into media_job (id, kind, request, source, connection, revision, model, phase, input, inputs, fingerprint, "authorization", cleanup, created_at, updated_at)
values (sqlc.arg(id), sqlc.arg(kind), sqlc.arg(request), sqlc.arg(source), sqlc.arg(connection), sqlc.arg(revision)::int, sqlc.arg(model), sqlc.arg(phase),
  sqlc.narg(input), coalesce(sqlc.narg(inputs), '[]'), coalesce(sqlc.narg(fingerprint), ''), sqlc.narg(authorization),
  coalesce(sqlc.narg(cleanup), 'done'), sqlc.arg(now)::float8, sqlc.arg(now)::float8);

-- name: ChangeMediaJob :exec
-- Every column a job's run changes, written back whole under the machine's lock.
update media_job set phase = sqlc.arg(phase), source = sqlc.arg(source), result_url = sqlc.narg(result_url), attachment = sqlc.narg(attachment),
  result = sqlc.narg(result), usage = sqlc.narg(usage), remote_task = sqlc.narg(remote_task), result_format = sqlc.narg(result_format),
  content_type = sqlc.narg(content_type), metadata = sqlc.narg(metadata), result_input = sqlc.narg(result_input), preview_input = sqlc.narg(preview_input),
  cleanup = sqlc.arg(cleanup), problem = sqlc.arg(problem), updated_at = sqlc.arg(now)::float8
where id = sqlc.arg(id);

-- name: InterruptMediaJobs :exec
-- A restart, for every kind: a job that never reached the vendor is canceled; one being asked is unknown, unless the vendor
-- runs it as a task the job follows (generating, with a remote task, not streamed), which is polled again; a vendor-side
-- cleanup cut short is blocked; downloads start again.
update media_job set
phase = case when phase in ('authorized', 'queued') then 'canceled'
  when phase in ('uploading', 'generating') then 'unknown' else phase end,
cleanup = case when phase in ('authorized', 'queued') then 'done' when cleanup = 'running' then 'blocked' else cleanup end,
problem = case when phase in ('authorized', 'queued', 'uploading', 'generating') then sqlc.arg(problem)::text else problem end,
updated_at = sqlc.arg(now)::float8
where phase in ('authorized', 'queued', 'uploading') or cleanup = 'running'
  or (phase = 'generating' and (remote_task is null or (request::jsonb -> 'streaming') = 'true'::jsonb));

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
