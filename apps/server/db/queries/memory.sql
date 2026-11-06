-- What agents remember (memory/memories.ts).

-- name: MemoriesOf :many
-- bound: one agent's current memories; superseded ones are left out.
-- An agent's own, the superseded ones left out.
select id, kind, body, repo, session, author, created_at, recalled, recalled_at
from memory where agent = sqlc.arg(agent) and replaced_by is null order by created_at desc, id desc;

-- name: AddNote :exec
insert into memory (id, scope, agent, kind, body, terms, terms_of, repo, session, author, created_at, updated_at)
values (sqlc.arg(id), 'agent', sqlc.arg(agent), 'note', sqlc.arg(body), sqlc.arg(terms), sqlc.arg(terms_of), sqlc.narg(repo),
        sqlc.narg(session), sqlc.arg(author), sqlc.arg(created_at), sqlc.arg(created_at));

-- name: Recalled :exec
update memory set recalled = recalled + 1, recalled_at = sqlc.arg(recalled_at) where id = sqlc.arg(id);

-- name: KeepIssueMemory :exec
-- One issue memory for each session: written again as the session goes on.
insert into memory (id, scope, agent, kind, body, terms, terms_of, repo, session, author, created_at, updated_at)
values (sqlc.arg(id), 'agent', sqlc.arg(agent), 'issue', sqlc.arg(body), sqlc.arg(terms), sqlc.arg(terms_of), sqlc.arg(repo),
        sqlc.arg(session), 'system', sqlc.arg(created_at), sqlc.arg(created_at))
on conflict (agent, session) where kind = 'issue'
do update set body = excluded.body, terms = excluded.terms, terms_of = excluded.terms_of, repo = excluded.repo,
              created_at = excluded.created_at, updated_at = excluded.updated_at;

-- name: Forget :exec
delete from memory where agent = sqlc.arg(agent) and id = sqlc.arg(id);

-- name: ClearManagedNotes :exec
delete from memory where agent = sqlc.arg(agent) and kind = 'note' and author <> 'owner';

-- name: StaleTerms :many
-- What an older cut left; memory.recutTerms cuts it again.
select id, body from memory where terms_of < sqlc.arg(version) order by created_at, id limit sqlc.arg(n)::int;

-- name: SetTerms :exec
update memory set terms = sqlc.arg(terms), terms_of = sqlc.arg(version) where id = sqlc.arg(id);

-- name: MatchMemories :many
-- bound: one agent's current memories that share a word.
-- How well each of an agent's memories shares any of words, higher for a better match (FTS5's bm25, which is lower for a
-- better one). The words go in as phrases, quoted, so none reads as an operator.
select memory.id, (-bm25(memory_term))::real as score
from memory_term join memory on memory.rowid = memory_term.rowid
where memory_term match (select group_concat('"' || replace(value, '"', '""') || '"', ' OR ') from json_each(sqlc.arg(words)::text[]))
  and memory.agent = sqlc.arg(agent) and memory.replaced_by is null;
