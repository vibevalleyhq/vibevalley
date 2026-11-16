-- Batch log for store artifacts (artifact/entries.ts).

-- name: AddArtifactEntryChange :exec
insert into artifact_entry_change (artifact_id, seq, actor, paths, deleted, created_at)
values (sqlc.arg(artifact_id), sqlc.arg(seq), sqlc.arg(actor), sqlc.arg(paths), sqlc.arg(deleted), sqlc.arg(created_at));

-- name: ArtifactEntryChangesAfter :many
select * from artifact_entry_change
where artifact_id = sqlc.arg(artifact_id) and seq > sqlc.arg(seq)
order by seq limit sqlc.arg(n)::int;

-- name: PruneArtifactEntryChanges :exec
delete from artifact_entry_change where created_at < sqlc.arg(before);
