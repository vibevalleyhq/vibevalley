-- name: SubscribeIssue :many
-- bound: one subscription, only if unclaimed or already owned by this issue.
insert into session_subscription (thread_key, issue_id) values (sqlc.arg(thread_key), sqlc.arg(issue_id))
on conflict (thread_key) do update set issue_id = excluded.issue_id where session_subscription.issue_id = excluded.issue_id
returning issue_id;

-- name: SubscribedIssues :many
-- bound: one user per supplied thread key.
select distinct issue_id from session_subscription where thread_key in (select unnest(sqlc.arg(keys)::text[]));
