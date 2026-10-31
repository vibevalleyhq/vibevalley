-- Each batch a blocks artifact took (artifact/blocks.ts): its seq, and its results for a batch that comes again.

-- name: ArtifactChangeByBatch :one
select * from artifact_change where batch_id = sqlc.arg(batch_id);

-- name: AddArtifactChange :exec
insert into artifact_change (artifact_id, seq, batch_id, actor, block_ids, results, created_at)
values (sqlc.arg(artifact_id), sqlc.arg(seq), sqlc.arg(batch_id), sqlc.arg(actor), sqlc.arg(block_ids), sqlc.arg(results), sqlc.arg(created_at));

-- name: PruneArtifactChanges :exec
-- A batch older than before: a client sends a batch again within seconds, not days.
delete from artifact_change where created_at < sqlc.arg(before);
