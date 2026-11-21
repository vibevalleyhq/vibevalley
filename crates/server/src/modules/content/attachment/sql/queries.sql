-- name: KeepAttachment :exec
INSERT INTO attachment (id, name, type, size, created_at)
VALUES (?1, ?2, ?3, ?4, ?5)
ON CONFLICT (id) DO NOTHING;

-- name: GetAttachment :one
SELECT id, name, type, size FROM attachment WHERE id = ?1;
