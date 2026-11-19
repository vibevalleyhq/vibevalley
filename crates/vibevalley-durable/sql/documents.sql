-- name: GetDocument :one
SELECT * FROM durable_document WHERE scope_kind = ?1 AND scope_id = ?2 AND doc_kind = ?3;
-- name: DocumentsByKind :many
SELECT * FROM durable_document WHERE scope_kind = ?1 AND doc_kind = ?2 ORDER BY scope_id;
-- name: DocumentsByScope :many
SELECT * FROM durable_document WHERE scope_kind = ?1 AND scope_id = ?2 ORDER BY doc_kind;
-- name: PutDocument :one
INSERT INTO durable_document (scope_kind,scope_id,doc_kind,rev,state_json,updated_at_ms)
VALUES (?1,?2,?3,1,?4,?5)
ON CONFLICT(scope_kind,scope_id,doc_kind) DO UPDATE SET rev=rev+1,state_json=excluded.state_json,updated_at_ms=excluded.updated_at_ms
RETURNING rev;
-- name: DeleteDocument :exec
DELETE FROM durable_document WHERE scope_kind = ?1 AND scope_id = ?2 AND doc_kind = ?3;
