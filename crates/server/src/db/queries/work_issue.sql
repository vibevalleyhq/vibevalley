-- name: ListIssues :many
SELECT i.*, e.evidence FROM issue AS i LEFT JOIN issue_delivery_evidence AS e ON e.issue_id = i.id ORDER BY i.number;

-- name: PutIssue :exec
INSERT INTO issue (id, number, title, description, repo, priority, rank, deliver, parent, created_at, queued_at, closed_at, reviewed_at, canceled, delivered, mandate, constraints, conflict, last_run, answer, blocked_by, criteria, checks, findings, questions, assignments)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)
ON CONFLICT(id) DO UPDATE SET
  number = excluded.number,
  title = excluded.title,
  description = excluded.description,
  repo = excluded.repo,
  priority = excluded.priority,
  rank = excluded.rank,
  deliver = excluded.deliver,
  parent = excluded.parent,
  created_at = excluded.created_at,
  queued_at = excluded.queued_at,
  closed_at = excluded.closed_at,
  reviewed_at = excluded.reviewed_at,
  canceled = excluded.canceled,
  delivered = excluded.delivered,
  mandate = excluded.mandate,
  constraints = excluded.constraints,
  conflict = excluded.conflict,
  last_run = excluded.last_run,
  answer = excluded.answer,
  blocked_by = excluded.blocked_by,
  criteria = excluded.criteria,
  checks = excluded.checks,
  findings = excluded.findings,
  questions = excluded.questions,
  assignments = excluded.assignments;

-- name: PutIssueEvidence :exec
INSERT INTO issue_delivery_evidence (issue_id, evidence)
VALUES (?1, ?2)
ON CONFLICT(issue_id) DO UPDATE SET evidence = excluded.evidence;

-- name: DeleteIssueEvidence :exec
DELETE FROM issue_delivery_evidence WHERE issue_id = ?1;

-- name: DeleteIssueWords :exec
DELETE FROM issue_word WHERE issue = ?1;

-- name: DeleteIssue :exec
DELETE FROM issue WHERE id = ?1;

-- name: ReadIssueNumber :one
SELECT last_number FROM issue_counter WHERE id = 1;

-- name: WriteIssueNumber :exec
INSERT INTO issue_counter (id, last_number) VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET last_number = excluded.last_number;

-- name: KeepIssueWords :exec
INSERT INTO issue_word (issue, text, created_at) VALUES (?1, ?2, ?3);

-- name: ListIssueWords :many
SELECT text FROM issue_word WHERE issue = ?1 ORDER BY seq;
