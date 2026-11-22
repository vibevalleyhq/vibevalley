-- name: ListIssues :many
SELECT id, number, title, description, repo, priority, rank, deliver, parent, created_at, queued_at, closed_at, reviewed_at, canceled, delivered, mandate, constraints, conflict, last_run, answer, delivery_evidence, blocked_by, criteria, checks, findings, questions, assignments
FROM issue ORDER BY number;

-- name: PutIssue :exec
INSERT INTO issue (id, number, title, description, repo, priority, rank, deliver, parent, created_at, queued_at, closed_at, reviewed_at, canceled, delivered, mandate, constraints, conflict, last_run, answer, delivery_evidence, blocked_by, criteria, checks, findings, questions, assignments)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27)
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
  delivery_evidence = excluded.delivery_evidence,
  blocked_by = excluded.blocked_by,
  criteria = excluded.criteria,
  checks = excluded.checks,
  findings = excluded.findings,
  questions = excluded.questions,
  assignments = excluded.assignments;

-- name: DeleteIssue :exec
DELETE FROM issue WHERE id = ?1;

-- name: GetIssueQueuedWords :one
SELECT queued_words FROM issue WHERE id = ?1;

-- name: SetIssueQueuedWords :exec
UPDATE issue SET queued_words = ?2 WHERE id = ?1;
