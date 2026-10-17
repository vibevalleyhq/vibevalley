-- What agents remember (memory/memory.go): the four kinds in .agents/notes/proposed/architecture/2026-10-18-memory-in-sqlite.md.

-- name: MemoriesOf :many
-- An agent's own, the superseded ones left out.
select * from memory where agent = cast(sqlc.arg(agent) as text) and replaced_by is null order by created_at desc, id desc;

-- name: AddNote :execresult
insert into memory (id, scope, agent, kind, body, terms, terms_of, project, session, author, created_at, updated_at)
values (sqlc.arg(id), 'agent', cast(sqlc.arg(agent) as text), 'note', sqlc.arg(body), sqlc.arg(terms), sqlc.arg(terms_of), sqlc.arg(project),
        sqlc.arg(session), sqlc.arg(author), sqlc.arg(created_at), sqlc.arg(created_at));

-- name: Recalled :exec
update memory set recalled = recalled + 1, recalled_at = ? where id = ?;

-- name: KeepJob :exec
-- One job memory for each session: written again as the session goes on.
insert into memory (id, scope, agent, kind, body, terms, terms_of, project, session, author, created_at, updated_at)
values (sqlc.arg(id), 'agent', cast(sqlc.arg(agent) as text), 'issue', sqlc.arg(body), sqlc.arg(terms), sqlc.arg(terms_of), sqlc.arg(project),
        sqlc.arg(session), 'farm', sqlc.arg(created_at), sqlc.arg(created_at))
on conflict (agent, session) where kind = 'issue'
do update set body = excluded.body, terms = excluded.terms, terms_of = excluded.terms_of, project = excluded.project,
              created_at = excluded.created_at, updated_at = excluded.updated_at;

-- name: Forget :exec
delete from memory where agent = cast(sqlc.arg(agent) as text) and id = sqlc.arg(id);

-- name: StaleTerms :many
-- What an older cut (or none: a migration moved it) left; memory.recutTerms cuts it again.
select id, body from memory where terms_of < sqlc.arg(version) order by rowid limit sqlc.arg(n);

-- name: SetTerms :exec
update memory set terms = sqlc.arg(terms), terms_of = sqlc.arg(version) where id = sqlc.arg(id);
