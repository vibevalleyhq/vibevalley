-- Named entries of a store artifact (artifact/entries.ts).

-- name: ArtifactEntries :many
-- bound: entryMaxCount (500) entries per store artifact.
select * from artifact_entry where artifact_id = sqlc.arg(artifact_id) order by path;

-- name: ArtifactEntriesByPrefix :many
-- bound: entryMaxCount (500) entries per store artifact.
select * from artifact_entry
where artifact_id = sqlc.arg(artifact_id) and path like sqlc.arg(prefix_like)
order by path;

-- name: ArtifactEntriesByPaths :many
-- bound: paths changed in one batch (<= entryMaxCount).
select * from artifact_entry
where artifact_id = sqlc.arg(artifact_id) and path = any(sqlc.arg(paths)::text[])
order by path;

-- name: ArtifactEntry :one
select * from artifact_entry where artifact_id = sqlc.arg(artifact_id) and path = sqlc.arg(path);

-- name: ArtifactEntryCount :one
select count(*)::int as n from artifact_entry where artifact_id = sqlc.arg(artifact_id);

-- name: UpsertArtifactEntry :exec
insert into artifact_entry (artifact_id, path, kind, mime, value, attachment_id, size, rev, updated_by, updated_at)
values (sqlc.arg(artifact_id), sqlc.arg(path), sqlc.arg(kind), sqlc.arg(mime), sqlc.narg(value), sqlc.narg(attachment_id), sqlc.arg(size), sqlc.arg(rev), sqlc.arg(updated_by), sqlc.arg(updated_at))
on conflict (artifact_id, path) do update set
  kind = excluded.kind,
  mime = excluded.mime,
  value = excluded.value,
  attachment_id = excluded.attachment_id,
  size = excluded.size,
  rev = excluded.rev,
  updated_by = excluded.updated_by,
  updated_at = excluded.updated_at;

-- name: DeleteArtifactEntry :exec
delete from artifact_entry where artifact_id = sqlc.arg(artifact_id) and path = sqlc.arg(path);
