-- Each change an agent proposes to a block the owner wrote (artifact/blocks.ts); the owner accepts or rejects it.

-- name: AddArtifactSuggestion :exec
insert into artifact_suggestion (id, artifact_id, block_id, author, at_rev, change, status, created_at)
values (sqlc.arg(id), sqlc.arg(artifact_id), sqlc.arg(block_id), sqlc.arg(author), sqlc.arg(at_rev), sqlc.arg(change), 'open', sqlc.arg(created_at));

-- name: ArtifactSuggestionByID :one
select * from artifact_suggestion where id = sqlc.arg(id);

-- name: ArtifactSuggestions :many
select * from artifact_suggestion where artifact_id = sqlc.arg(artifact_id) order by created_at, id limit sqlc.arg(n);

-- name: ResolveArtifactSuggestion :exec
update artifact_suggestion set status = sqlc.arg(status), resolved_at = sqlc.arg(resolved_at), resolved_by = sqlc.arg(resolved_by)
where id = sqlc.arg(id) and status = 'open';
