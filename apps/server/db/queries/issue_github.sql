-- name: EnsureGitHubCursor :exec
insert into issue_github (repo, pr_number) values (sqlc.arg(repo), sqlc.arg(pr_number)) on conflict do nothing;

-- name: GitHubCursor :one
select check_fingerprint, check_revision from issue_github where repo = sqlc.arg(repo) and pr_number = sqlc.arg(pr_number);

-- name: ObserveGitHubChecks :exec
update issue_github set check_fingerprint = sqlc.arg(check_fingerprint), check_revision = sqlc.arg(check_revision)
where repo = sqlc.arg(repo) and pr_number = sqlc.arg(pr_number);
