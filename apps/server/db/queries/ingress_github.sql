-- name: EnsureGitHubCursor :exec
insert into ingress_github (project, pr_number) values (sqlc.arg(project), sqlc.arg(pr_number)) on conflict do nothing;

-- name: GitHubCursor :one
select check_fingerprint, check_revision from ingress_github where project = sqlc.arg(project) and pr_number = sqlc.arg(pr_number);

-- name: ObserveGitHubChecks :exec
update ingress_github set check_fingerprint = sqlc.arg(check_fingerprint), check_revision = sqlc.arg(check_revision)
where project = sqlc.arg(project) and pr_number = sqlc.arg(pr_number);
