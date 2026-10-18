-- name: EnqueueIssue :exec
insert into issue_queue (issue, channel, triggered_by) values (?, ?, ?) on conflict do nothing;

-- name: QueuedIssue :one
select * from issue_queue where issue = ?;

-- name: DequeueIssue :exec
delete from issue_queue where issue = ?;
