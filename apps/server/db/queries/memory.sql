-- What agents remember (memory/memories.ts).

-- name: MemoriesOf :many
-- An agent's own, the superseded ones left out.
select id, kind, body, project, session, author, created_at, recalled, recalled_at
from memory where agent = sqlc.arg(agent) and replaced_by is null order by created_at desc, id desc;

-- name: AddNote :exec
insert into memory (id, scope, agent, kind, body, terms, terms_of, project, session, author, created_at, updated_at)
values (sqlc.arg(id), 'agent', sqlc.arg(agent), 'note', sqlc.arg(body), sqlc.arg(terms), sqlc.arg(terms_of), sqlc.narg(project),
        sqlc.narg(session), sqlc.arg(author), sqlc.arg(created_at), sqlc.arg(created_at));

-- name: Recalled :exec
update memory set recalled = recalled + 1, recalled_at = sqlc.arg(recalled_at) where id = sqlc.arg(id);

-- name: KeepJob :exec
-- One job memory for each session: written again as the session goes on.
insert into memory (id, scope, agent, kind, body, terms, terms_of, project, session, author, created_at, updated_at)
values (sqlc.arg(id), 'agent', sqlc.arg(agent), 'issue', sqlc.arg(body), sqlc.arg(terms), sqlc.arg(terms_of), sqlc.arg(project),
        sqlc.arg(session), 'system', sqlc.arg(created_at), sqlc.arg(created_at))
on conflict (agent, session) where kind = 'issue'
do update set body = excluded.body, terms = excluded.terms, terms_of = excluded.terms_of, project = excluded.project,
              created_at = excluded.created_at, updated_at = excluded.updated_at;

-- name: Forget :exec
delete from memory where agent = sqlc.arg(agent) and id = sqlc.arg(id);

-- name: StaleTerms :many
-- What an older cut left; memory.recutTerms cuts it again.
select id, body from memory where terms_of < sqlc.arg(version) order by created_at, id limit sqlc.arg(n)::int;

-- name: SetTerms :exec
update memory set terms = sqlc.arg(terms), terms_of = sqlc.arg(version) where id = sqlc.arg(id);

-- name: MatchMemories :many
-- How well each of an agent's memories shares any of words, higher for a better match. The words go in as lexemes as
-- they are, quoted, so none reads as an operator.
select id, ts_rank(terms_vector, query)::float8 as score
from memory, (select array_to_string(array(select quote_literal(w) from unnest(sqlc.arg(words)::text[]) as w), ' | ')::tsquery as query) as q
where terms_vector @@ query and agent = sqlc.arg(agent) and replaced_by is null;
