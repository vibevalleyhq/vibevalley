-- Issues (issue/issue.ts).

-- name: ListIssues :many
select * from issue order by rank, created_at, id;

-- name: GetIssue :one
select * from issue where id = sqlc.arg(id);

-- name: IssueByNumber :one
select * from issue where number = sqlc.arg(number);

-- name: AddIssue :exec
insert into issue (id, number, title, description, project, assignee, priority, rank, created_at, recurrence, acceptance)
values (sqlc.arg(id), (select coalesce(max(number), 0) + 1 from issue), sqlc.arg(title), sqlc.arg(description), sqlc.narg(project), sqlc.narg(assignee),
        sqlc.arg(priority), (select coalesce(max(rank), 0) + 1 from issue), sqlc.arg(created_at), sqlc.narg(recurrence), sqlc.arg(acceptance));

-- name: EditIssue :exec
update issue set title = sqlc.arg(title), description = sqlc.arg(description), project = sqlc.narg(project), assignee = sqlc.narg(assignee),
  priority = sqlc.arg(priority), acceptance = sqlc.arg(acceptance), criteria = sqlc.narg(criteria) where id = sqlc.arg(id);

-- name: DraftIssue :exec
-- A draft handed back: its words, its criteria and what it asks, in one write.
update issue set title = sqlc.arg(title), description = sqlc.arg(description), criteria = sqlc.narg(criteria), asks = sqlc.narg(asks)
where id = sqlc.arg(id);

-- name: AcceptIssue :exec
-- A verdict on what was handed back: passed (accepted_at set) or not (cleared), with the weeds as they stand now.
update issue set accepted_at = sqlc.narg(accepted_at), findings = sqlc.narg(findings) where id = sqlc.arg(id);

-- name: SetIssueAsks :exec
update issue set asks = sqlc.narg(asks) where id = sqlc.arg(id);

-- name: SetIssueChecks :exec
update issue set checks = sqlc.narg(checks) where id = sqlc.arg(id);

-- name: RemoveIssue :exec
delete from issue where id = sqlc.arg(id);

-- name: PlaceIssue :exec
update issue set rank = sqlc.arg(rank) where id = sqlc.arg(id);

-- name: QueueIssue :exec
update issue set queued_at = coalesce(queued_at, sqlc.arg(at)) where id = sqlc.arg(id);

-- name: UnqueueIssue :exec
update issue set queued_at = null where id = sqlc.arg(id);

-- name: CloseIssue :exec
update issue set closed_at = sqlc.arg(closed_at), closed = sqlc.narg(closed) where id = sqlc.arg(id);

-- name: OpenIssue :exec
-- A session starts on it: made from the session's job when it is new, else open again and out of the queue.
insert into issue (id, number, title, description, project, assignee, created_at)
values (sqlc.arg(id), (select coalesce(max(number), 0) + 1 from issue), sqlc.arg(title), sqlc.arg(description), sqlc.narg(project), sqlc.narg(assignee), sqlc.arg(created_at))
on conflict (id) do update set queued_at = null, closed_at = null, closed = null;

-- name: KeptIssues :many
-- What the core state keeps: the open issues and the latest closed ones, each with its sub-issues.
with latest as (select id from issue where parent is null and closed_at is not null order by closed_at desc limit sqlc.arg(closed)::int)
select * from issue
where closed_at is null or id in (select id from latest) or parent in (select id from latest)
   or parent in (select id from issue where closed_at is null);

-- name: Family :many
-- An issue and its sub-issues.
select * from issue where id = sqlc.arg(id) or parent = sqlc.arg(id);

-- name: PutIssue :exec
-- An issue as its task graph has it now; its sessions and its queue are not the graph's.
insert into issue (id, number, title, description, project, assignee, priority, rank, created_at, closed_at, closed, parent, blocked_by, graph, task)
values (sqlc.arg(id), (select coalesce(max(number), 0) + 1 from issue), sqlc.arg(title), sqlc.arg(description), sqlc.narg(project), sqlc.narg(assignee),
        sqlc.arg(priority), sqlc.arg(rank), sqlc.arg(created_at), sqlc.narg(closed_at), sqlc.narg(closed), sqlc.narg(parent), sqlc.narg(blocked_by),
        sqlc.narg(graph), sqlc.narg(task))
on conflict (id) do update set
  title = excluded.title, description = excluded.description, project = excluded.project, assignee = excluded.assignee, rank = excluded.rank,
  closed_at = excluded.closed_at, closed = excluded.closed, parent = excluded.parent, blocked_by = excluded.blocked_by,
  graph = excluded.graph, task = excluded.task;

-- name: GraphIDs :many
select id from issue where graph is not null;

-- name: LatestOfRecurrence :one
-- A recurrence's issue: the one it made last.
select * from issue where recurrence = sqlc.arg(recurrence) order by created_at desc, id desc limit 1;

-- name: ReopenIssue :exec
update issue set closed_at = null, closed = null, queued_at = null, checks = null, handed_back = null where id = sqlc.arg(id);

-- name: OpenOf :many
select id, handed_back from issue where assignee = sqlc.arg(assignee) and closed_at is null;

-- name: SetHandedBack :exec
-- How the manager's last turn on its issue ended (JSON); null while it is on it.
update issue set handed_back = sqlc.narg(handed_back) where id = sqlc.arg(id);

-- name: SetIssuePullRequest :exec
update issue set pull_request = sqlc.narg(pull_request) where id = sqlc.arg(id);
