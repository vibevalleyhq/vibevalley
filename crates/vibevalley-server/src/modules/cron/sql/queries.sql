-- name: ListCrons :many
SELECT id, name, body, channel_id, agent, repo, issue_id, spec, tz, enabled, created_at, last_run, set_by, pending
FROM cron
ORDER BY id;

-- name: UpsertCron :exec
INSERT INTO cron (id, name, body, channel_id, agent, repo, issue_id, spec, tz, enabled, created_at, last_run, set_by, pending)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  body = excluded.body,
  channel_id = excluded.channel_id,
  agent = excluded.agent,
  repo = excluded.repo,
  issue_id = excluded.issue_id,
  spec = excluded.spec,
  tz = excluded.tz,
  enabled = excluded.enabled,
  last_run = excluded.last_run,
  set_by = excluded.set_by,
  pending = excluded.pending;

-- name: SetCronIssue :exec
UPDATE cron SET issue_id = ?2 WHERE id = ?1;

-- name: RemoveCron :exec
DELETE FROM cron WHERE id = ?1;
