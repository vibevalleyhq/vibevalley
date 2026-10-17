-- The workers that worked each issue, oldest first (issue/issue.go).

-- name: AddWorker :exec
insert into issue_worker (worker, issue, started_at) values (?, ?, ?) on conflict (worker) do nothing;

-- name: IssueOfWorker :one
select issue from issue_worker where worker = ?;

-- name: AllWorkers :many
select issue, worker from issue_worker order by started_at, worker;

-- name: WorkersOf :many
select worker from issue_worker where issue = ? order by started_at, worker;

-- name: WorkersOfKept :many
with latest as (select id from issue where parent is null and closed_at is not null order by closed_at desc limit sqlc.arg(closed))
select issue_worker.issue, issue_worker.worker from issue_worker
where issue_worker.issue in (
  select id from issue
  where closed_at is null or id in (select id from latest) or parent in (select id from latest)
     or parent in (select id from issue where closed_at is null))
order by issue_worker.started_at, issue_worker.worker;

-- name: WorkersOfFamily :many
select issue_worker.issue, issue_worker.worker from issue_worker
where issue_worker.issue in (select id from issue where id = sqlc.arg(id) or parent = sqlc.arg(id))
order by issue_worker.started_at, issue_worker.worker;
