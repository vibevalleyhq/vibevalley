-- Issues and their runs (tickets/issues.go).

-- name: ListIssues :many
select * from issue order by rank, created_at, id;

-- name: GetIssue :one
select * from issue where id = ?;

-- name: AddIssue :exec
insert into issue (id, title, description, project, agent, priority, rank, created_at, schedule)
values (sqlc.arg(id), sqlc.arg(title), sqlc.arg(description), sqlc.arg(project), sqlc.arg(agent), sqlc.arg(priority),
        (select coalesce(max(rank), 0) + 1 from issue), sqlc.arg(created_at), sqlc.arg(schedule));

-- name: EditIssue :exec
update issue set title = ?, description = ?, project = ?, agent = ?, priority = ? where id = ?;

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
-- A run starts on it: made from the run's job when it is new, else open again and out of the queue.
insert into issue (id, title, description, project, agent, created_at) values (?, ?, ?, ?, ?, ?)
on conflict (id) do update set queued_at = null, closed_at = null, closed = null;

-- name: KeepIssue :exec
-- An issue made from a run of before the book: only when it is not there yet.
insert into issue (id, title, description, project, agent, created_at, playbook) values (?, ?, ?, ?, ?, ?, ?)
on conflict (id) do nothing;

-- name: AddRun :exec
insert into issue_run (run, issue, started_at) values (?, ?, ?) on conflict (run) do nothing;

-- name: IssueOfRun :one
select issue from issue_run where run = ?;

-- name: AllRuns :many
select issue, run from issue_run order by started_at, run;

-- name: RunsOf :many
select run from issue_run where issue = ? order by started_at, run;

-- name: KeptIssues :many
-- What the core state keeps: the open issues and the latest closed ones, each with its sub-issues.
with latest as (select id from issue where parent is null and closed_at is not null order by closed_at desc limit sqlc.arg(closed))
select * from issue
where closed_at is null or id in (select id from latest) or parent in (select id from latest)
   or parent in (select id from issue where closed_at is null);

-- name: RunsOfKept :many
with latest as (select id from issue where parent is null and closed_at is not null order by closed_at desc limit sqlc.arg(closed))
select issue_run.issue, issue_run.run from issue_run
where issue_run.issue in (
  select id from issue
  where closed_at is null or id in (select id from latest) or parent in (select id from latest)
     or parent in (select id from issue where closed_at is null))
order by issue_run.started_at, issue_run.run;

-- name: Family :many
-- An issue and its sub-issues.
select * from issue where id = sqlc.arg(id) or parent = sqlc.arg(id);

-- name: RunsOfFamily :many
select issue_run.issue, issue_run.run from issue_run
where issue_run.issue in (select id from issue where id = sqlc.arg(id) or parent = sqlc.arg(id))
order by issue_run.started_at, issue_run.run;

-- name: PutIssue :exec
-- An issue as its playbook has it now; its runs and its queue are not the playbook's.
insert into issue (id, title, description, project, agent, priority, rank, created_at, closed_at, closed, parent, blocked_by, plan, step)
values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
on conflict (id) do update set
  title = excluded.title, description = excluded.description, project = excluded.project, agent = excluded.agent, rank = excluded.rank,
  closed_at = excluded.closed_at, closed = excluded.closed, parent = excluded.parent, blocked_by = excluded.blocked_by,
  plan = excluded.plan, step = excluded.step;

-- name: PlanIDs :many
select id from issue where plan is not null;

-- name: TaggedIssues :many
-- Issues of before playbooks were issues, tagged with the playbook (and the step) their run was for.
select id, playbook from issue where playbook is not null and plan is null and step is null;

-- name: MoveRuns :exec
update issue_run set issue = sqlc.arg(dest) where issue = sqlc.arg(src);
