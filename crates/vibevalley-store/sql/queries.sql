-- name: ListProjects :many
SELECT id, path, name, position, last_opened_ms FROM projects ORDER BY position, id;

-- name: GetProject :one
SELECT id, path, name, position, last_opened_ms FROM projects WHERE id = ?1;

-- name: FindProjectId :one
SELECT id FROM projects WHERE path = ?1;

-- name: RequireProject :one
SELECT id FROM projects WHERE id = ?1;

-- name: InsertProject :one
INSERT INTO projects (path, name, position, last_opened_ms)
VALUES (sqlc.arg(path), sqlc.arg(name), (SELECT COALESCE(MAX(position), -1) + 1 FROM projects), sqlc.arg(last_opened_ms))
RETURNING id;

-- name: DeleteLayout :exec
DELETE FROM layouts WHERE project_id = ?1;

-- name: RemoveProject :execrows
DELETE FROM projects WHERE id = ?1;

-- name: RenameProject :execrows
UPDATE projects SET name = ?1 WHERE id = ?2;

-- name: RelocateProject :execrows
UPDATE projects SET path = ?1 WHERE id = ?2;

-- name: TouchProject :execrows
UPDATE projects SET last_opened_ms = ?1 WHERE id = ?2;

-- name: ListProjectIds :many
SELECT id FROM projects ORDER BY position, id;

-- name: SetPosition :exec
UPDATE projects SET position = ?1 WHERE id = ?2;

-- name: ReadLayout :one
SELECT json FROM layouts WHERE project_id = ?1;

-- name: WriteLayout :exec
INSERT INTO layouts (project_id, json) VALUES (?1, ?2)
ON CONFLICT(project_id) DO UPDATE SET json = excluded.json;

-- name: ListTerminals :many
SELECT id, project_id, cwd, title, scrollback FROM terminals WHERE project_id = ?1 ORDER BY ord;

-- name: DeleteTerminals :exec
DELETE FROM terminals WHERE project_id = ?1;

-- name: InsertTerminal :exec
INSERT INTO terminals (project_id, id, ord, cwd, title, scrollback) VALUES (?1, ?2, ?3, ?4, ?5, ?6);

-- name: ReadSetting :one
SELECT value FROM settings WHERE key = ?1;

-- name: WriteSetting :exec
INSERT INTO settings (key, value) VALUES (?1, ?2)
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

-- name: DeleteSetting :exec
DELETE FROM settings WHERE key = ?1;
