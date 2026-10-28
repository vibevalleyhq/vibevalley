-- Issues (issue/issue.ts).

-- name: ListIssues :many
select * from issue order by rank, created_at, id;

-- name: GetIssue :one
select * from issue where id = sqlc.arg(id);

-- name: IssueByNumber :one
select * from issue where number = sqlc.arg(number);

-- name: AddIssue :exec
insert into issue (id, number, title, description, project, assignee, priority, rank, created_at, cron, deliver, talk)
values (sqlc.arg(id), (select coalesce(max(number), 0) + 1 from issue), sqlc.arg(title), sqlc.arg(description), sqlc.narg(project), sqlc.narg(assignee),
        sqlc.arg(priority), (select coalesce(max(rank), 0) + 1 from issue), sqlc.arg(created_at), sqlc.narg(cron), sqlc.arg(deliver), sqlc.narg(talk));

-- name: EditIssue :exec
update issue set title = sqlc.arg(title), description = sqlc.arg(description), project = sqlc.narg(project), assignee = sqlc.narg(assignee),
  priority = sqlc.arg(priority), criteria = sqlc.narg(criteria), deliver = sqlc.arg(deliver) where id = sqlc.arg(id);

-- name: RefineIssue :exec
-- A draft handed back: its words, its criteria and what it asks, in one write.
update issue set title = sqlc.arg(title), description = sqlc.arg(description), criteria = sqlc.narg(criteria), questions = sqlc.narg(questions)
where id = sqlc.arg(id);

-- name: ReviewIssue :exec
-- A verdict on what was handed back: passed (reviewed_at set) or not (cleared), with the weeds as they stand now.
update issue set reviewed_at = sqlc.narg(reviewed_at), findings = sqlc.narg(findings) where id = sqlc.arg(id);

-- name: SetIssueQuestions :exec
update issue set questions = sqlc.narg(questions) where id = sqlc.arg(id);

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

-- name: CompleteIssue :exec
update issue set closed_at = sqlc.arg(closed_at), delivered = sqlc.arg(delivered), canceled = null where id = sqlc.arg(id);

-- name: CancelIssue :exec
update issue set closed_at = sqlc.arg(closed_at), canceled = sqlc.arg(canceled), delivered = null where id = sqlc.arg(id);

-- name: CompleteOpenIssue :exec
-- As a session leaves: only an issue still open, so a verdict written meanwhile (a pull request merged) stands.
update issue set closed_at = sqlc.arg(closed_at), delivered = sqlc.arg(delivered) where id = sqlc.arg(id) and closed_at is null;

-- name: CancelOpenIssue :exec
update issue set closed_at = sqlc.arg(closed_at), canceled = sqlc.arg(canceled) where id = sqlc.arg(id) and closed_at is null;

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
insert into issue (id, number, title, description, project, assignee, priority, rank, created_at, closed_at, delivered, canceled, parent, blocked_by, graph, task)
values (sqlc.arg(id), (select coalesce(max(number), 0) + 1 from issue), sqlc.arg(title), sqlc.arg(description), sqlc.narg(project), sqlc.narg(assignee),
        sqlc.arg(priority), sqlc.arg(rank), sqlc.arg(created_at), sqlc.narg(closed_at), sqlc.narg(delivered), sqlc.narg(canceled), sqlc.narg(parent), sqlc.narg(blocked_by),
        sqlc.narg(graph), sqlc.narg(task))
on conflict (id) do update set
  title = excluded.title, description = excluded.description, project = excluded.project, assignee = excluded.assignee, rank = excluded.rank,
  closed_at = excluded.closed_at, delivered = excluded.delivered, canceled = excluded.canceled, parent = excluded.parent, blocked_by = excluded.blocked_by,
  graph = excluded.graph, task = excluded.task;

-- name: GraphIDs :many
select id from issue where graph is not null;

-- name: LatestOfCron :one
-- A cron's issue: the one it made last.
select * from issue where cron = sqlc.arg(cron) order by created_at desc, id desc limit 1;

-- name: AssignIssue :exec
-- Who does it is the profile its latest session works as: another one when it was handed over.
update issue set assignee = sqlc.arg(assignee) where id = sqlc.arg(id);

-- name: ReopenIssue :exec
update issue set closed_at = null, delivered = null, canceled = null, queued_at = null, checks = null, last_run = null where id = sqlc.arg(id);

-- name: OpenOf :many
select id, last_run from issue where assignee = sqlc.arg(assignee) and closed_at is null;

-- name: SetIssueAnswer :exec
update issue set answer = sqlc.narg(answer) where id = sqlc.arg(id);

-- name: SetLastRun :exec
update issue set last_run = sqlc.narg(last_run) where id = sqlc.arg(id);

-- name: SetIssuePullRequest :exec
update issue set pull_request = sqlc.narg(pull_request) where id = sqlc.arg(id);

-- name: TalkOf :one
-- A profile's talk with the owner, by its direct channel.
select id from issue where talk = sqlc.arg(talk);
