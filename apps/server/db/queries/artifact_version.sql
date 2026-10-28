-- An artifact's versions (artifact/artifact.ts).

-- name: AddArtifactVersion :exec
insert into artifact_version (artifact_id, version, sha, size, note, by_id, by_name, created_at)
values (sqlc.arg(artifact_id), sqlc.arg(version), sqlc.arg(sha), sqlc.arg(size), sqlc.narg(note), sqlc.arg(by_id), sqlc.arg(by_name), sqlc.arg(created_at));

-- name: ArtifactVersionAnnounced :exec
update artifact_version set message_id = sqlc.arg(message_id) where artifact_id = sqlc.arg(artifact_id) and version = sqlc.arg(version);

-- name: ArtifactVersions :many
-- With the announcing message's channel and number, where its comments are.
select v.*, m.channel_id as message_channel, m.number as message_number
from artifact_version v left join channel_message m on m.id = v.message_id
where v.artifact_id = sqlc.arg(artifact_id) order by v.version;

-- name: ArtifactVersion :one
select * from artifact_version where artifact_id = sqlc.arg(artifact_id) and version = sqlc.arg(version);

-- name: ArtifactShaUsers :one
-- How many versions keep this content: its file goes only when none does.
select count(*)::integer as n from artifact_version where sha = sqlc.arg(sha);
