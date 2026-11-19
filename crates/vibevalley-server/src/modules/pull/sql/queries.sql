-- name: ListPulls :many
SELECT id, platform, repo, number, url, branch, base, state, issue_id, check_fingerprint, check_revision, created_at, updated_at
FROM pull
ORDER BY created_at, id;

-- name: UpsertPull :one
INSERT INTO pull (id, platform, repo, number, url, branch, base, state, issue_id, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
ON CONFLICT (repo, number) DO UPDATE SET
  platform = excluded.platform,
  url = excluded.url,
  branch = excluded.branch,
  base = excluded.base,
  state = excluded.state,
  issue_id = COALESCE(excluded.issue_id, pull.issue_id),
  updated_at = excluded.updated_at
RETURNING id, platform, repo, number, url, branch, base, state, issue_id, check_fingerprint, check_revision, created_at, updated_at;

-- name: SetPullState :one
UPDATE pull
SET state = ?2, updated_at = ?3
WHERE id = ?1
RETURNING id, platform, repo, number, url, branch, base, state, issue_id, check_fingerprint, check_revision, created_at, updated_at;

-- name: ObservePullChecks :one
UPDATE pull
SET check_fingerprint = ?2, check_revision = ?3, updated_at = ?4
WHERE id = ?1
RETURNING id, platform, repo, number, url, branch, base, state, issue_id, check_fingerprint, check_revision, created_at, updated_at;

-- name: KnownPullEvents :many
SELECT key, bot_round_key, bot_round
FROM pull_event
WHERE pull_id = ?1;

-- name: KeepPullEvent :exec
INSERT INTO pull_event (pull_id, key, bot_round_key, bot_round)
VALUES (?1, ?2, ?3, ?4)
ON CONFLICT DO NOTHING;
