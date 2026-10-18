-- Issues (issue/issue.go).

-- name: ListIssues :many
select * from issue order by rank, created_at, id;

-- name: GetIssue :one
select * from issue where id = ?;

-- name: IssueByNumber :one
select * from issue where number = ?;

-- name: AddIssue :exec
insert into issue (id, number, title, description, project, assignee, priority, rank, created_at, schedule)
values (sqlc.arg(id), (select coalesce(max(number), 0) + 1 from issue), sqlc.arg(title), sqlc.arg(description), sqlc.arg(project), sqlc.arg(assignee),
        sqlc.arg(priority), (select coalesce(max(rank), 0) + 1 from issue), sqlc.arg(created_at), sqlc.arg(schedule));

-- name: EditIssue :exec
update issue set title = ?, description = ?, project = ?, assignee = ?, priority = ? where id = ?;

-- name: RemoveIssue :exec
delete from issue where id = ?;

-- name: PlaceIssue :exec
update issue set rank = ? where id = ?;

-- name: QueueIssue :exec
update issue set queued_at = coalesce(queued_at, sqlc.arg(at)) where id = sqlc.arg(id);

-- name: UnqueueIssue :exec
update issue set queued_at = null where id = ?;

-- name: CloseIssue :exec
update issue set closed_at = ?, closed = ? where id = ?;

-- name: OpenIssue :exec
-- A session starts on it: made from the session's job when it is new, else open again and out of the queue.
insert into issue (id, number, title, description, project, assignee, created_at)
values (?, (select coalesce(max(number), 0) + 1 from issue), ?, ?, ?, ?, ?)
on conflict (id) do update set queued_at = null, closed_at = null, closed = null;

-- name: KeptIssues :many
-- What the core state keeps: the open issues and the latest closed ones, each with its sub-issues.
with latest as (select id from issue where parent is null and closed_at is not null order by closed_at desc limit sqlc.arg(closed))
select * from issue
where closed_at is null or id in (select id from latest) or parent in (select id from latest)
   or parent in (select id from issue where closed_at is null);

-- name: Family :many
-- An issue and its sub-issues.
select * from issue where id = sqlc.arg(id) or parent = sqlc.arg(id);

-- name: PutIssue :exec
-- An issue as its task graph has it now; its sessions and its queue are not the graph's.
insert into issue (id, number, title, description, project, assignee, priority, rank, created_at, closed_at, closed, parent, blocked_by, graph, task)
values (?, (select coalesce(max(number), 0) + 1 from issue), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
on conflict (id) do update set
  title = excluded.title, description = excluded.description, project = excluded.project, assignee = excluded.assignee, rank = excluded.rank,
  closed_at = excluded.closed_at, closed = excluded.closed, parent = excluded.parent, blocked_by = excluded.blocked_by,
  graph = excluded.graph, task = excluded.task;

-- name: GraphIDs :many
select id from issue where graph is not null;

-- name: LatestOfSchedule :one
-- A schedule's issue: the one it made last.
select * from issue where schedule = ? order by created_at desc, id desc limit 1;

-- name: ReopenIssue :exec
update issue set closed_at = null, closed = null, queued_at = null where id = ?;

-- name: OpenOf :many
select id from issue where assignee = ? and closed_at is null;

-- name: SetIssuePullRequest :exec
update issue set pull_request = ? where id = ?;
