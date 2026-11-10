-- An artifact's versions (artifact/artifact.ts).

-- name: AddArtifactVersion :exec
insert into artifact_version (artifact_id, version, attachment_id, size, note, by_id, by_name, created_at)
values (sqlc.arg(artifact_id), sqlc.arg(version), sqlc.arg(attachment_id), sqlc.arg(size), sqlc.narg(note), sqlc.arg(by_id), sqlc.arg(by_name), sqlc.arg(created_at));

-- name: ArtifactVersionAnnounced :exec
update artifact_version set message_id = sqlc.arg(message_id) where artifact_id = sqlc.arg(artifact_id) and version = sqlc.arg(version);

-- name: ArtifactVersions :many
-- bound: one artifact's versions, each one the user or a helper wrote.
-- With the announcing message's channel and number, where its comments are.
select v.*, m.channel_id as message_channel, m.number as message_number
from artifact_version v left join channel_message m on m.id = v.message_id
where v.artifact_id = sqlc.arg(artifact_id) order by v.version;

-- name: ArtifactVersion :one
select * from artifact_version where artifact_id = sqlc.arg(artifact_id) and version = sqlc.arg(version);
