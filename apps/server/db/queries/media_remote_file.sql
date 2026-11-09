-- name: RemoteFile :one
select * from media_remote_file where holder = sqlc.arg(holder) and input_id = sqlc.arg(input);

-- name: RemoteFiles :many
-- bound: at most five inputs can be uploaded for one holder.
select * from media_remote_file where holder = sqlc.arg(holder) order by created_at, id;

-- name: InsertRemoteFile :exec
insert into media_remote_file (id, holder, input_id, connection, revision, credential_hash, filename, purpose, size, content_hash, phase, created_at, updated_at)
values (sqlc.arg(id), sqlc.arg(holder), sqlc.arg(input), sqlc.arg(connection), sqlc.arg(revision)::int, sqlc.arg(credential_hash), sqlc.arg(filename), sqlc.arg(purpose), sqlc.arg(size)::int, sqlc.arg(content_hash), 'uploading', sqlc.arg(now)::int, sqlc.arg(now)::int);

-- name: ChangeRemoteFile :exec
update media_remote_file set phase = sqlc.arg(phase), remote_id = sqlc.narg(remote_id), updated_at = sqlc.arg(now)::int where id = sqlc.arg(id);

-- name: InterruptRemoteFile :exec
update media_remote_file set phase = 'unknown', updated_at = sqlc.arg(now)::int where id = sqlc.arg(id) and phase = 'uploading';

-- name: InterruptRemoteFiles :exec
update media_remote_file set phase = 'unknown', updated_at = sqlc.arg(now)::int where phase = 'uploading';
