-- name: ListProfiles :many
SELECT state_json
FROM agent_profile
ORDER BY id ASC;

-- name: ListSkills :many
SELECT state_json
FROM agent_skill
ORDER BY id ASC;

-- name: ListRuntimes :many
SELECT state_json
FROM agent_runtime
ORDER BY id ASC;

-- name: SaveProfile :exec
INSERT INTO agent_profile (id, state_json, updated_at_ms)
VALUES (?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
	state_json = excluded.state_json,
	updated_at_ms = excluded.updated_at_ms;

-- name: DeleteProfile :exec
DELETE FROM agent_profile WHERE id = ?;

-- name: SaveSkill :exec
INSERT INTO agent_skill (id, built_in, state_json, updated_at_ms)
VALUES (?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
	built_in = excluded.built_in,
	state_json = excluded.state_json,
	updated_at_ms = excluded.updated_at_ms;

-- name: DeleteSkill :exec
DELETE FROM agent_skill WHERE id = ?;

-- name: SaveRuntime :exec
INSERT INTO agent_runtime (id, state_json)
VALUES (?, ?)
ON CONFLICT (id) DO UPDATE SET
	state_json = excluded.state_json;
