-- Issues (issue/issue.ts).

-- name: ListIssues :many
-- bound: every issue, as the core holds them.
select issue.*, latest_run.started_at::session_run.started_at? as run_started_at, latest_run.ended_at as run_ended_at,
       latest_run.outcome as run_outcome
from issue left join session_run latest_run on latest_run.id = (
  select r.id from session_run r
  where (r.issue = issue.id or exists (select 1 from session_run_issue l where l.run = r.id and l.issue = issue.id))
    and exists (select 1 from issue_assignment_execution e join issue_assignment a on a.id = e.assignment
      where a.issue = issue.id and e.executor = r.session)
  order by r.started_at desc, r.id desc limit 1
) order by issue.rank, issue.created_at, issue.id;

-- name: GetIssue :one
select issue.*, latest_run.started_at::session_run.started_at? as run_started_at, latest_run.ended_at as run_ended_at,
       latest_run.outcome as run_outcome
from issue left join session_run latest_run on latest_run.id = (
  select r.id from session_run r
  where (r.issue = issue.id or exists (select 1 from session_run_issue l where l.run = r.id and l.issue = issue.id))
    and exists (select 1 from issue_assignment_execution e join issue_assignment a on a.id = e.assignment
      where a.issue = issue.id and e.executor = r.session)
  order by r.started_at desc, r.id desc limit 1
) where issue.id = sqlc.arg(id);

-- name: IssueExists :one
-- Whether an issue is there at all, for the deliveries' routing before the core fact reaches it (Session.useIssues).
select id from issue where id = sqlc.arg(id);

-- name: IssueByNumber :one
select issue.*, latest_run.started_at::session_run.started_at? as run_started_at, latest_run.ended_at as run_ended_at,
       latest_run.outcome as run_outcome
from issue left join session_run latest_run on latest_run.id = (
  select r.id from session_run r
  where (r.issue = issue.id or exists (select 1 from session_run_issue l where l.run = r.id and l.issue = issue.id))
    and exists (select 1 from issue_assignment_execution e join issue_assignment a on a.id = e.assignment
      where a.issue = issue.id and e.executor = r.session)
  order by r.started_at desc, r.id desc limit 1
) where issue.number = sqlc.arg(number);

-- name: AddIssue :exec
insert into issue (id, number, title, description, origin_trigger_id, mandate_strength, max_bot_review_rounds, auto_submit_pr,
                   repo, priority, rank, created_at, cron, deliver, parent, blocked_by, constraints, criteria)
values (sqlc.arg(id), (select coalesce(max(number), 0) + 1 from issue), sqlc.arg(title), sqlc.arg(description), sqlc.narg(origin_trigger_id),
        sqlc.arg(mandate_strength), sqlc.arg(max_bot_review_rounds), sqlc.arg(auto_submit_pr), sqlc.narg(repo), sqlc.arg(priority),
        (select coalesce(max(rank), 0) + 1 from issue), sqlc.arg(created_at), sqlc.narg(cron), sqlc.arg(deliver), sqlc.narg(parent), sqlc.narg(blocked_by), sqlc.narg(constraints), sqlc.narg(criteria));

-- name: SetIssueConstraints :exec
update issue set constraints = sqlc.narg(constraints) where issue.id = sqlc.arg(id);

-- name: EditIssue :exec
update issue set title = sqlc.arg(title), description = sqlc.arg(description), repo = sqlc.narg(repo),
  priority = sqlc.arg(priority), criteria = sqlc.narg(criteria), deliver = sqlc.arg(deliver) where issue.id = sqlc.arg(id);

-- name: RefineIssue :exec
-- A draft handed back: its words, its criteria and what it asks, in one write.
update issue set title = sqlc.arg(title), description = sqlc.arg(description), criteria = sqlc.narg(criteria), questions = sqlc.narg(questions)
where id = sqlc.arg(id);

-- name: ReviewIssue :exec
-- A verdict on what was handed back: passed (reviewed_at set) or not (cleared), with the weeds as they stand now.
update issue set reviewed_at = sqlc.narg(reviewed_at), findings = sqlc.narg(findings) where issue.id = sqlc.arg(id);

-- name: SetIssueQuestions :exec
update issue set questions = sqlc.narg(questions) where issue.id = sqlc.arg(id);


-- name: SetIssueReport :exec
update issue set questions = sqlc.narg(questions), checks = sqlc.narg(checks) where issue.id = sqlc.arg(id);

-- name: RemoveIssue :exec
delete from issue where id = sqlc.arg(id);

-- name: PlaceIssue :exec
update issue set rank = sqlc.arg(rank) where issue.id = sqlc.arg(id);

-- name: QueueIssue :many
-- bound: at most one newly queued issue.
update issue set queued_at = sqlc.arg(at) where id = sqlc.arg(id) and queued_at is null returning id;

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
select issue.*, latest_run.started_at::session_run.started_at? as run_started_at, latest_run.ended_at as run_ended_at,
       latest_run.outcome as run_outcome
from issue left join session_run latest_run on latest_run.id = (
  select r.id from session_run r
  where (r.issue = issue.id or exists (select 1 from session_run_issue l where l.run = r.id and l.issue = issue.id))
    and exists (select 1 from issue_assignment_execution e join issue_assignment a on a.id = e.assignment
      where a.issue = issue.id and e.executor = r.session)
  order by r.started_at desc, r.id desc limit 1
)
where issue.closed_at is null or issue.id in (select id from latest) or issue.parent in (select id from latest)
   or issue.parent in (select id from issue where closed_at is null);

-- name: Family :many
-- bound: one issue and its sub-issues.
-- An issue and its sub-issues.
select issue.*, latest_run.started_at::session_run.started_at? as run_started_at, latest_run.ended_at as run_ended_at,
       latest_run.outcome as run_outcome
from issue left join session_run latest_run on latest_run.id = (
  select r.id from session_run r
  where (r.issue = issue.id or exists (select 1 from session_run_issue l where l.run = r.id and l.issue = issue.id))
    and exists (select 1 from issue_assignment_execution e join issue_assignment a on a.id = e.assignment
      where a.issue = issue.id and e.executor = r.session)
  order by r.started_at desc, r.id desc limit 1
) where issue.id = sqlc.arg(id) or issue.parent = sqlc.arg(id);

-- name: LatestOfCron :one
-- A cron's issue: the one it made last.
select issue.*, latest_run.started_at::session_run.started_at? as run_started_at, latest_run.ended_at as run_ended_at,
       latest_run.outcome as run_outcome
from issue left join session_run latest_run on latest_run.id = (
  select r.id from session_run r
  where (r.issue = issue.id or exists (select 1 from session_run_issue l where l.run = r.id and l.issue = issue.id))
    and exists (select 1 from issue_assignment_execution e join issue_assignment a on a.id = e.assignment
      where a.issue = issue.id and e.executor = r.session)
  order by r.started_at desc, r.id desc limit 1
) where issue.cron = sqlc.arg(cron) order by issue.created_at desc, issue.id desc limit 1;

-- name: ReopenIssue :exec
update issue set closed_at = null, delivered = null, canceled = null, queued_at = null, checks = null where id = sqlc.arg(id);

-- name: SetIssueAnswer :exec
update issue set answer = sqlc.narg(answer) where issue.id = sqlc.arg(id);

-- name: SetIssuePullRequest :exec
update issue set pull_request = sqlc.narg(pull_request) where issue.id = sqlc.arg(id);

-- name: SetIssueConflict :exec
update issue set conflict = sqlc.narg(conflict) where issue.id = sqlc.arg(id);
