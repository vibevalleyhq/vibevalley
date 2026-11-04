-- Remarks on the notes' blocks and the rewrites proposed for them (pkm/pkm.ts).

-- name: OpenComments :many
-- bound: the remarks not yet resolved, on one page or all.
select * from pkm_comment
where status in ('open', 'suggested') and (sqlc.narg(page)::text is null or page = sqlc.narg(page))
order by created_at, id;

-- name: Comment :one
select * from pkm_comment where id = sqlc.arg(id);

-- name: NewestOn :one
select * from pkm_comment where block = sqlc.arg(block) order by created_at desc, id desc limit 1;

-- name: KeepRemark :exec
-- A remark read from a file: its words follow the file while it is open; one resolved stays as it was.
insert into pkm_comment (id, page, block, span, author, body, status, created_at)
values (sqlc.arg(id), sqlc.arg(page), sqlc.arg(block), sqlc.narg(span), sqlc.arg(author), sqlc.arg(body), 'open', sqlc.arg(created_at))
on conflict (id) do update set body = excluded.body, page = excluded.page where pkm_comment.status = 'open';

-- name: AddSuggestion :exec
insert into pkm_comment (id, page, block, author, body, status, suggested, rationale, created_at)
values (sqlc.arg(id), sqlc.arg(page), sqlc.arg(block), sqlc.arg(author), sqlc.arg(body), 'suggested', sqlc.arg(suggested), sqlc.arg(rationale),
        sqlc.arg(created_at));

-- name: Suggest :exec
update pkm_comment set status = 'suggested', suggested = sqlc.arg(suggested), rationale = sqlc.arg(rationale) where id = sqlc.arg(id);

-- name: Resolve :exec
update pkm_comment set status = sqlc.arg(status), resolved_at = sqlc.arg(resolved_at) where id = sqlc.arg(id);

-- name: RemarkedBlocks :many
-- bound: a row per block with a remark not yet resolved.
select distinct block from pkm_comment where status in ('open', 'suggested');

-- name: MovePage :exec
update pkm_comment set page = sqlc.arg(to_page) where page = sqlc.arg(from_page);

-- name: ResolveOn :exec
-- A block rewritten as accepted answers every remark still open on it.
update pkm_comment set status = 'accepted', resolved_at = sqlc.arg(resolved_at) where block = sqlc.arg(block) and status in ('open', 'suggested');
