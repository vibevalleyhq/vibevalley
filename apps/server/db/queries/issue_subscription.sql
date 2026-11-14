-- The threads whose words go to an issue (issue/intake.ts).

-- name: SubscribeIssue :many
-- bound: one subscription, only if unclaimed or already owned by this issue.
insert into issue_subscription (thread_key, issue_id) values (sqlc.arg(thread_key), sqlc.arg(issue_id))
on conflict (thread_key) do update set issue_id = excluded.issue_id where issue_subscription.issue_id = excluded.issue_id
returning issue_id;

-- name: SubscribedIssues :many
-- bound: one user per supplied thread key.
select distinct issue_id from issue_subscription where thread_key in (select unnest(sqlc.arg(keys)::text[]));
