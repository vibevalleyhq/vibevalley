-- Pull requests (pull/pull.ts).

-- name: ListPulls :many
-- bound: every pull request tracked by the farm, loaded into the pull index.
select * from pull order by created_at, id;

-- name: GetPull :one
select * from pull where id = sqlc.arg(id);

-- name: GetPullByRepoNumber :one
select * from pull where repo = sqlc.arg(repo) and number = sqlc.arg(number);

-- name: UpsertPull :one
insert into pull (id, platform, repo, number, url, branch, base, state, issue_id, created_at, updated_at)
values (sqlc.arg(id), sqlc.arg(platform), sqlc.arg(repo), sqlc.arg(number), sqlc.arg(url), sqlc.arg(branch),
        sqlc.arg(base), sqlc.arg(state), sqlc.narg(issue_id), sqlc.arg(created_at), sqlc.arg(updated_at))
on conflict (repo, number) do update
set platform = excluded.platform,
    url = excluded.url,
    branch = excluded.branch,
    base = excluded.base,
    state = excluded.state,
    issue_id = coalesce(excluded.issue_id, pull.issue_id),
    updated_at = excluded.updated_at
returning *;

-- name: SetPullState :one
update pull
set state = sqlc.arg(state), updated_at = sqlc.arg(updated_at)
where id = sqlc.arg(id)
returning *;

-- name: ObservePullChecks :one
update pull
set check_fingerprint = sqlc.arg(check_fingerprint),
    check_revision = sqlc.arg(check_revision),
    updated_at = sqlc.arg(updated_at)
where id = sqlc.arg(id)
returning *;
