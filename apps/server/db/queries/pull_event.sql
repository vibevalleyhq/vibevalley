-- Pull request reviews and comments taken in (pull/pull.ts).

-- name: KnownPullEvents :many
-- bound: the events taken in for one pull request.
select key, bot_round_key, bot_round from pull_event where pull_id = sqlc.arg(pull_id);

-- name: KeepPullEvent :exec
insert into pull_event (pull_id, key, bot_round_key, bot_round)
values (sqlc.arg(pull_id), sqlc.arg(key), sqlc.narg(bot_round_key), sqlc.narg(bot_round))
on conflict do nothing;
