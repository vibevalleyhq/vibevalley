-- Each block's text by rev (artifact/blocks.ts): the base a stale update is read against, and what lost a conflict.

-- name: AddArtifactBlockRevision :exec
insert into artifact_block_revision (id, block_id, rev, spans, actor, kind, created_at)
values (sqlc.arg(id), sqlc.arg(block_id), sqlc.arg(rev), sqlc.arg(spans), sqlc.arg(actor), sqlc.arg(kind), sqlc.arg(created_at));

-- name: ArtifactBlockRevision :one
select spans from artifact_block_revision where block_id = sqlc.arg(block_id) and rev = sqlc.arg(rev) and kind = 'normal' order by created_at desc limit 1;

-- name: PruneArtifactBlockRevisions :exec
-- A text older than before: an update stale by that long is not merged against its base.
delete from artifact_block_revision where created_at < sqlc.arg(before);
