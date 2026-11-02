-- name: RecordOccurrence :exec
insert into cron_occurrence (id, cron_id, cron_json, missed, created_at)
values (sqlc.arg(id), sqlc.arg(cron_id), sqlc.arg(cron_json), sqlc.arg(missed), sqlc.arg(created_at));

-- name: PendingOccurrences :many
select id, cron_json, missed from cron_occurrence order by created_at, id limit 1000;

-- name: AcknowledgeOccurrence :exec
delete from cron_occurrence where id = sqlc.arg(id);
