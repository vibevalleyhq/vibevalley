-- The files the notes' changes wrote, for pkm.undo (pkm/pkm.ts).

-- name: AddChange :exec
insert into pkm_change (at, what, page, before_file, after_file, before_text, after_text)
values (sqlc.arg(at), sqlc.arg(what), sqlc.arg(page), sqlc.narg(before_file), sqlc.arg(after_file), sqlc.narg(before_text), sqlc.arg(after_text));

-- name: LastChange :one
select * from pkm_change order by seq desc limit 1;

-- name: DropChange :exec
delete from pkm_change where seq = sqlc.arg(seq);

-- name: TrimChanges :exec
-- Only the newest keep changes can be undone.
delete from pkm_change where seq <= (select max(seq) from pkm_change) - sqlc.arg(keep)::int;
