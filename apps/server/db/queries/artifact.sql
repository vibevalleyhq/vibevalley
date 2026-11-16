-- Artifacts (artifact/artifact.ts).

-- name: AddArtifact :exec
insert into artifact (id, title, body, artifact_type, is_default, display, channel_id, issue, by_id, by_name, version, seq, created_at, updated_at)
values (sqlc.arg(id), sqlc.arg(title), sqlc.arg(body), sqlc.narg(artifact_type), sqlc.arg(is_default), sqlc.narg(display), sqlc.narg(channel_id), sqlc.narg(issue), sqlc.arg(by_id), sqlc.arg(by_name), sqlc.arg(version), 0,
        sqlc.arg(created_at), sqlc.arg(created_at));

-- name: Artifact :one
-- With the announcing message's channel and number, where a blocks or store one's comments are.
select a.*, m.channel_id as said_channel, m.number as said_number
from artifact a left join channel_message m on m.id = a.message_id where a.id = sqlc.arg(id);

-- name: DefaultDesignSystemArtifact :one
select a.*, m.channel_id as said_channel, m.number as said_number
from artifact a left join channel_message m on m.id = a.message_id
where a.artifact_type = 'design-system' and a.is_default = true
limit 1;

-- name: ClearDefaultDesignSystem :exec
update artifact set is_default = false, updated_at = sqlc.arg(updated_at) where is_default = true;

-- name: SetArtifactDefault :exec
update artifact set is_default = sqlc.arg(is_default), updated_at = sqlc.arg(updated_at) where id = sqlc.arg(id);

-- name: ArtifactsInChannel :many
-- bound: one channel's artifacts, what its artifact list shows whole.
select a.*, m.channel_id as said_channel, m.number as said_number
from artifact a left join channel_message m on m.id = a.message_id
where a.channel_id = sqlc.arg(channel_id) order by a.updated_at desc, a.id;

-- name: ArtifactsForIssue :many
-- bound: one issue's artifacts.
select a.*, m.channel_id as said_channel, m.number as said_number
from artifact a left join channel_message m on m.id = a.message_id
where a.issue = sqlc.arg(issue) order by a.updated_at desc, a.id;

-- name: Artifacts :many
select a.*, m.channel_id as said_channel, m.number as said_number
from artifact a left join channel_message m on m.id = a.message_id
order by a.updated_at desc, a.id limit sqlc.arg(limit_n)::int;

-- name: ArtifactVersioned :exec
update artifact set version = sqlc.arg(version), updated_at = sqlc.arg(updated_at) where id = sqlc.arg(id);

-- name: ArtifactAccepted :exec
-- A batch of a blocks or store artifact was taken: its seq is the batch's.
update artifact set seq = sqlc.arg(seq), updated_at = sqlc.arg(updated_at) where id = sqlc.arg(id);

-- name: ArtifactSaid :exec
update artifact set message_id = sqlc.arg(message_id) where id = sqlc.arg(id);

-- name: ArtifactRenamed :exec
update artifact set title = sqlc.arg(title), updated_at = sqlc.arg(updated_at) where id = sqlc.arg(id);

-- name: ArtifactShown :exec
update artifact set display = sqlc.arg(display), updated_at = sqlc.arg(updated_at) where id = sqlc.arg(id) and body = 'html';

-- name: DeleteArtifact :exec
delete from artifact where id = sqlc.arg(id);
