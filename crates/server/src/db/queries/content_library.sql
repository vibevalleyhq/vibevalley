-- name: GetItem :one
SELECT i.attachment_id, i.origin, i.added_at, i.last_at, a.name, a.type, a.size
FROM media_library_item i JOIN attachment a ON a.id = i.attachment_id
WHERE i.attachment_id = ?1 AND i.removed_at IS NULL;

-- name: ListItems :many
WITH requested AS (SELECT CAST(sqlc.arg(sort) AS TEXT) AS ordering)
SELECT i.attachment_id, i.origin, i.added_at, i.last_at, a.name, a.type, a.size
FROM media_library_item i JOIN attachment a ON a.id = i.attachment_id
CROSS JOIN requested
WHERE i.removed_at IS NULL
AND (CAST(sqlc.arg(kind) AS TEXT) = '' OR i.kind = sqlc.arg(kind))
AND (CAST(sqlc.arg(media_type) AS TEXT) = ''
  OR (sqlc.arg(media_type) = 'other' AND substr(a.type, 1, instr(a.type || '/', '/') - 1) NOT IN ('image','audio','video'))
  OR substr(a.type, 1, instr(a.type || '/', '/') - 1) = sqlc.arg(media_type))
AND (CAST(sqlc.arg(search) AS TEXT) = '' OR instr(lower(a.name), sqlc.arg(search)) > 0)
ORDER BY CASE WHEN requested.ordering = 'name' THEN lower(a.name) END,
         CASE WHEN requested.ordering = 'size' THEN a.size END DESC,
         i.last_at DESC, i.attachment_id
LIMIT CAST(sqlc.arg(item_limit) AS INTEGER);

-- name: KeepItem :exec
INSERT INTO media_library_item (attachment_id, kind, origin, added_at, last_at)
VALUES (?1, ?2, ?3, ?4, ?4)
ON CONFLICT (attachment_id) DO UPDATE SET
  kind = CASE WHEN media_library_item.removed_at IS NOT NULL THEN excluded.kind ELSE media_library_item.kind END,
  origin = CASE WHEN media_library_item.removed_at IS NOT NULL THEN excluded.origin ELSE media_library_item.origin END,
  last_at = max(media_library_item.last_at, excluded.last_at),
  removed_at = NULL;

-- name: KeepGenerated :exec
INSERT INTO media_library_item (attachment_id, kind, origin, added_at, last_at, source_job_id)
VALUES (?1, ?2, ?3, ?4, ?4, ?5)
ON CONFLICT DO NOTHING;

-- name: SoftRemoveGeneratedItem :exec
UPDATE media_library_item SET removed_at = ?2 WHERE attachment_id = ?1 AND source_job_id IS NOT NULL;

-- name: DeleteNonGeneratedItem :exec
DELETE FROM media_library_item WHERE attachment_id = ?1 AND source_job_id IS NULL;
