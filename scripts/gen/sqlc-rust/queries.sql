-- name: GetProject :one
SELECT id, path, name, position, last_opened_ms FROM projects WHERE id = ?1;
-- name: ProjectValues :one
SELECT CAST(last_opened_ms / 1000.0 AS REAL) AS opened_seconds, CAST(name AS BLOB) AS name_bytes
FROM projects WHERE id = ?1;
-- name: ListProjects :many
SELECT id, path, name, position, last_opened_ms FROM projects ORDER BY position, id;
-- name: RenameProject :execrows
UPDATE projects SET name = ?1 WHERE id = ?2;
-- name: ListTerminals :many
SELECT id, title FROM terminals WHERE project_id = ?1 ORDER BY ord;
-- name: ProjectTerminals :many
SELECT p.id, t.id AS terminal_id
FROM projects p LEFT JOIN terminals t ON p.id = t.project_id
ORDER BY p.id, t.ord;
-- name: SetTitle :exec
UPDATE terminals SET title = sqlc.narg(title) WHERE id = sqlc.arg(id) AND project_id = sqlc.arg(project_id);
