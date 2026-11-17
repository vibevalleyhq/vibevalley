-- name: LoadExistingNoteIDs :many
SELECT id, rel_path
FROM pkm_notes;

-- name: UpdateNote :exec
UPDATE pkm_notes
SET slug = ?, title = ?, tier = ?, sha256 = ?, frontmatter_json = ?, tags_json = ?, body = ?, updated_at_ms = ?
WHERE id = ?;

-- name: InsertNote :execresult
INSERT INTO pkm_notes (rel_path, slug, title, tier, sha256, frontmatter_json, tags_json, body, updated_at_ms)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: InsertAlias :exec
INSERT OR IGNORE INTO pkm_aliases (alias_slug, rel_path)
VALUES (?, ?);

-- name: DeleteAliasesByPath :exec
DELETE FROM pkm_aliases
WHERE rel_path = ?;

-- name: DeleteBlocksByPath :exec
DELETE FROM pkm_blocks
WHERE rel_path = ?;

-- name: DeleteLinksBySourcePath :exec
DELETE FROM pkm_links
WHERE source_path = ?;

-- name: DeleteVectorByID :execrows
DELETE FROM _vec_pkm_vectors
WHERE dataset_id = ? AND id = ?;

-- name: UpsertVector :exec
INSERT INTO _vec_pkm_vectors (dataset_id, id, content, meta, embedding)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(dataset_id, id) DO UPDATE SET
    content = excluded.content,
    meta = excluded.meta,
    embedding = excluded.embedding;

-- name: DeleteVectorStorage :exec
DELETE FROM vector_storage
WHERE shadow_table_name = ? AND dataset_id = ?;

-- name: GetNoteIDByPath :one
SELECT id
FROM pkm_notes
WHERE rel_path = ?;

-- name: DeleteNoteByID :exec
DELETE FROM pkm_notes
WHERE id = ?;

-- name: GetNoteByPathOrRef :one
SELECT rel_path, slug, title, tier, sha256, frontmatter_json, tags_json, body, updated_at_ms
FROM pkm_notes
WHERE rel_path = ? OR slug = ? OR lower(title) = lower(?)
LIMIT 1;

-- name: ListBlockBacklinks :many
SELECT l.source_path,
       CAST(COALESCE(NULLIF(l.target_title, ''), b.page_title, '') AS TEXT) AS target_title,
       l.block_id, l.line, l.byte_start, l.byte_end, l.snippet
FROM pkm_links l
LEFT JOIN pkm_blocks b ON b.block_id = l.block_id
WHERE l.block_id = ?
ORDER BY l.source_path ASC, l.byte_start ASC;

-- name: ResolveBlock :one
SELECT block_id, rel_path, body, line, byte_start, byte_end
FROM pkm_blocks
WHERE block_id = ?;

-- name: SearchShortTerms :many
SELECT rel_path,
       CAST((CASE WHEN INSTR(lower(title), sqlc.arg(term)) > 0 THEN 4.0 ELSE 0.0 END) +
       (CASE WHEN INSTR(lower(tags_json), sqlc.arg(term)) > 0 THEN 2.0 ELSE 0.0 END) +
       (CASE WHEN INSTR(lower(body), sqlc.arg(term)) > 0 THEN 1.0 ELSE 0.0 END) AS REAL) AS s
FROM pkm_notes
WHERE INSTR(lower(title), sqlc.arg(term)) > 0 OR INSTR(lower(tags_json), sqlc.arg(term)) > 0 OR INSTR(lower(body), sqlc.arg(term)) > 0
ORDER BY s DESC
LIMIT sqlc.arg(limit_count);

-- name: QueryBacklinksBySlugs :many
SELECT l.source_path,
       CAST(COALESCE(NULLIF(l.target_title, ''), b.page_title, '') AS TEXT) AS target_title,
       l.block_id, l.line, l.byte_start, l.byte_end, l.snippet
FROM pkm_links l
LEFT JOIN pkm_blocks b ON b.block_id = l.block_id
WHERE l.target_slug IN (sqlc.slice('target_slugs'))
ORDER BY l.source_path ASC, l.byte_start ASC;

-- name: QueryBacklinksBySlugsAndKind :many
SELECT l.source_path,
       CAST(COALESCE(NULLIF(l.target_title, ''), b.page_title, '') AS TEXT) AS target_title,
       l.block_id, l.line, l.byte_start, l.byte_end, l.snippet
FROM pkm_links l
LEFT JOIN pkm_blocks b ON b.block_id = l.block_id
WHERE l.kind = ? AND l.target_slug IN (sqlc.slice('target_slugs'))
ORDER BY l.source_path ASC, l.byte_start ASC;

-- name: QueryBacklinksBySlugsOrPaths :many
SELECT l.source_path,
       CAST(COALESCE(NULLIF(l.target_title, ''), b.page_title, '') AS TEXT) AS target_title,
       l.block_id, l.line, l.byte_start, l.byte_end, l.snippet
FROM pkm_links l
LEFT JOIN pkm_blocks b ON b.block_id = l.block_id
WHERE l.target_slug IN (sqlc.slice('target_slugs'))
   OR (l.block_id <> '' AND b.rel_path IN (sqlc.slice('target_paths')))
ORDER BY l.source_path ASC, l.byte_start ASC;

-- name: QueryBacklinksBySlugsOrPathsAndKind :many
SELECT l.source_path,
       CAST(COALESCE(NULLIF(l.target_title, ''), b.page_title, '') AS TEXT) AS target_title,
       l.block_id, l.line, l.byte_start, l.byte_end, l.snippet
FROM pkm_links l
LEFT JOIN pkm_blocks b ON b.block_id = l.block_id
WHERE l.kind = ?
  AND (l.target_slug IN (sqlc.slice('target_slugs'))
       OR (l.block_id <> '' AND b.rel_path IN (sqlc.slice('target_paths'))))
ORDER BY l.source_path ASC, l.byte_start ASC;

-- name: FindNotesBySlugsOrPath :many
SELECT rel_path, slug
FROM pkm_notes
WHERE rel_path = ? OR slug IN (sqlc.slice('slugs'));

-- name: FindNotesByAliasSlugs :many
SELECT a.rel_path, n.slug
FROM pkm_aliases a
JOIN pkm_notes n ON n.rel_path = a.rel_path
WHERE a.alias_slug IN (sqlc.slice('alias_slugs'));

-- name: ListAliasSlugsByPaths :many
SELECT alias_slug
FROM pkm_aliases
WHERE rel_path IN (sqlc.slice('rel_paths'));

-- name: ListForwardLinks :many
SELECT l.kind,
       CAST(COALESCE(NULLIF(l.target_title, ''), b.page_title, '') AS TEXT) AS target_title,
       l.target_slug,
       l.block_id,
       l.source_block_id,
       l.line,
       l.byte_start,
       l.byte_end,
       l.snippet
FROM pkm_links l
LEFT JOIN pkm_blocks b ON b.block_id = l.block_id
WHERE l.source_path = ?
ORDER BY l.byte_start ASC;

-- name: ListBlocksByPath :many
SELECT block_id, body, line, byte_start, byte_end
FROM pkm_blocks
WHERE rel_path = ?
ORDER BY byte_start ASC;

-- name: ListNoteSHAs :many
SELECT rel_path, sha256
FROM pkm_notes;

-- name: ListSourcePathsByTargetSlugs :many
SELECT DISTINCT l.source_path
FROM pkm_links l
WHERE l.target_slug IN (sqlc.slice('target_slugs'));

-- name: ListSourcePathsByTargetSlugsOrPaths :many
SELECT DISTINCT l.source_path
FROM pkm_links l
LEFT JOIN pkm_blocks b ON b.block_id = l.block_id
WHERE l.target_slug IN (sqlc.slice('target_slugs'))
   OR (l.block_id <> '' AND b.rel_path IN (sqlc.slice('target_paths')));

-- name: LoadSearchMetaByPaths :many
SELECT rel_path, title, slug, tier, tags_json, body
FROM pkm_notes
WHERE rel_path IN (sqlc.slice('rel_paths'));

-- name: LoadBacklinkCounts :many
SELECT target_slug, CAST(COUNT(*) AS INTEGER) AS cnt
FROM pkm_links
WHERE target_slug <> ''
GROUP BY target_slug;

-- name: ListAllNotesForSearch :many
SELECT rel_path, title, slug, tier, tags_json, body, updated_at_ms
FROM pkm_notes
ORDER BY updated_at_ms DESC, rel_path ASC;
