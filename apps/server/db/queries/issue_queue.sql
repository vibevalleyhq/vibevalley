-- Issues waiting for room, with where and why they were sent (issue/queue.ts).

-- name: EnqueueIssue :exec
insert into issue_queue (issue, channel, triggered_by) values (sqlc.arg(issue), sqlc.arg(channel), sqlc.arg(triggered_by)) on conflict do nothing;

-- name: QueuedIssue :one
select * from issue_queue where issue = sqlc.arg(issue);

-- name: DequeueIssue :exec
delete from issue_queue where issue = sqlc.arg(issue);
