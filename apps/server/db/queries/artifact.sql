-- Artifacts (artifact/artifact.ts).

-- name: AddArtifact :exec
insert into artifact (id, title, kind, channel_id, issue, by_id, by_name, version, created_at, updated_at)
values (sqlc.arg(id), sqlc.arg(title), sqlc.arg(kind), sqlc.arg(channel_id), sqlc.narg(issue), sqlc.arg(by_id), sqlc.arg(by_name), 1, sqlc.arg(created_at), sqlc.arg(created_at));

-- name: Artifact :one
select * from artifact where id = sqlc.arg(id);

-- name: ArtifactsInChannel :many
select * from artifact where channel_id = sqlc.arg(channel_id) order by updated_at desc, id;

-- name: ArtifactsForIssue :many
select * from artifact where issue = sqlc.arg(issue) order by updated_at desc, id;

-- name: Artifacts :many
select * from artifact order by updated_at desc, id limit sqlc.arg(limit_n);

-- name: ArtifactVersioned :exec
update artifact set version = sqlc.arg(version), updated_at = sqlc.arg(updated_at) where id = sqlc.arg(id);

-- name: DeleteArtifact :exec
delete from artifact where id = sqlc.arg(id);
