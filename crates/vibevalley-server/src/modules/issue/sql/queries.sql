-- name: ListIssues :many
SELECT i.*, e.evidence FROM issue AS i LEFT JOIN issue_delivery_evidence AS e ON e.issue_id = i.id ORDER BY i.number;

-- name: PutIssue :exec
INSERT OR REPLACE INTO issue (id, number, title, description, repo, priority, rank, deliver, parent, cron, created_at, queued_at, closed_at, reviewed_at, canceled, delivered, mandate, constraints, conflict, pull_request, last_run, answer, blocked_by, criteria, checks, findings, questions, assignments)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28);

-- name: PutIssueEvidence :exec
INSERT OR REPLACE INTO issue_delivery_evidence (issue_id, evidence)
VALUES (?1, ?2);

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
