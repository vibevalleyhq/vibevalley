-- name: KnownGitHubEvents :many
-- bound: the events taken in for one pull request.
select key, bot_round_key, bot_round from issue_github_event where repo = sqlc.arg(repo) and pr_number = sqlc.arg(pr_number);

-- name: KeepGitHubEvent :exec
insert into issue_github_event (repo, pr_number, key, bot_round_key, bot_round)
values (sqlc.arg(repo), sqlc.arg(pr_number), sqlc.arg(key), sqlc.narg(bot_round_key), sqlc.narg(bot_round))
on conflict do nothing;
