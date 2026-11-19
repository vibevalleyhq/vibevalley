-- name: GetInput :one
SELECT id, metadata, phase, hash, created_at, expires_at FROM media_input WHERE id = ?1;

-- name: ListInputs :many
SELECT id, metadata, phase, hash, created_at, expires_at FROM media_input ORDER BY created_at DESC, id;

-- name: GetPin :one
SELECT CAST(EXISTS(SELECT 1 FROM media_input_pin WHERE input_id = ?1) AS INTEGER) AS pinned;

-- name: PinnedInputs :many
SELECT DISTINCT input_id FROM media_input_pin;

-- name: InputQuota :one
SELECT CAST(COALESCE(SUM(size), 0) AS INTEGER) AS bytes, COUNT(*) AS entries FROM media_input;

-- name: ReserveInput :exec
INSERT INTO media_input (id,metadata,size,phase,created_at,expires_at) VALUES (?1,?2,?3,'reserved',?4,?5);

-- name: SetInputPhase :exec
UPDATE media_input SET phase=?2 WHERE id=?1;

-- name: MarkInputDeleting :execrows
UPDATE media_input SET phase='deleting' WHERE id=?1 AND NOT EXISTS
(SELECT 1 FROM media_input_pin WHERE input_id=media_input.id);

-- name: ForgetInput :exec
DELETE FROM media_input WHERE id=?1;

-- name: ExpiredInputs :many
SELECT id FROM media_input WHERE (expires_at <= ?1 OR phase = 'deleting')
AND NOT EXISTS (SELECT 1 FROM media_input_pin WHERE input_id = media_input.id);

-- name: InterruptUploads :exec
UPDATE media_input SET phase = 'failed' WHERE phase = 'uploading';

-- name: SaveInputHash :exec
UPDATE media_input SET hash = ?2 WHERE id = ?1;

-- name: InputReady :exec
UPDATE media_input SET phase='ready', expires_at=?2 WHERE id=?1;

-- name: PinInput :exec
INSERT OR IGNORE INTO media_input_pin (input_id,holder) VALUES (?1,?2);

-- name: ReleasePins :exec
DELETE FROM media_input_pin WHERE holder=?1;

-- name: GetJob :one
SELECT data FROM media_job WHERE id=?1;

-- name: RecentJobs :many
SELECT data FROM media_job ORDER BY created_at DESC, id LIMIT 100;

-- name: ActiveJobs :many
SELECT data FROM media_job WHERE phase IN ('queued','generating','downloading','authorized','uploading');

-- name: WaitingJobs :many
SELECT data FROM media_job WHERE phase IN ('queued','generating','downloading') ORDER BY created_at,id;

-- name: AuthorizedJobs :many
SELECT data FROM media_job WHERE phase='authorized';

-- name: ActiveCount :one
SELECT COUNT(*) AS total FROM media_job WHERE phase IN ('queued','generating','downloading','authorized','uploading');

-- name: SaveJob :exec
INSERT INTO media_job (id,kind,phase,data,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6)
ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,data=excluded.data,updated_at=excluded.updated_at;
