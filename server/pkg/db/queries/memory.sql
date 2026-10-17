-- What agents remember (memory/memory.go).

-- name: MemoriesOf :many
select * from memory where agent = ? order by created_at desc, id desc;

-- name: AddNote :execresult
insert into memory (agent, kind, body, project, session, created_at) values (?, 'note', ?, ?, ?, ?);

-- name: Recalled :exec
update memory set recalled = recalled + 1, recalled_at = ? where id = ?;

-- name: KeepJob :exec
-- One job memory for each session: written again as the session goes on.
insert into memory (agent, kind, body, project, session, created_at) values (?, 'issue', ?, ?, ?, ?)
on conflict (agent, session) where kind = 'issue'
do update set body = excluded.body, project = excluded.project, created_at = excluded.created_at;

-- name: ForgetBeyond :exec
-- An agent keeps the ones it recalled or wrote last.
delete from memory where memory.agent = sqlc.arg(agent) and memory.id not in (
  select kept.id from memory kept where kept.agent = sqlc.arg(agent) order by coalesce(kept.recalled_at, kept.created_at) desc limit sqlc.arg(keep));

-- name: Forget :exec
delete from memory where agent = ? and id = ?;
