-- name: ListStaleTerms :many
select id, body from memory where terms_of < ?1;

-- name: SetTerms :exec
update memory set terms = ?1, terms_of = ?2 where id = ?3;

-- name: ListMemories :many
select id, kind, body, repo, session, author, created_at, recalled, recalled_at
from memory where agent = ?1 order by created_at desc, id desc;

-- name: WriteNote :exec
insert into memory (id, agent, kind, body, terms, terms_of, repo, session, author, created_at, updated_at)
values (?1, ?2, 'note', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9);

-- name: ClearAgentNotes :exec
delete from memory where agent = ?1 and kind = 'note' and author <> 'user';

-- name: Forget :exec
delete from memory where agent = ?1 and id = ?2;

-- name: CountRecall :exec
update memory set recalled = recalled + 1, recalled_at = ?1 where id = ?2;

-- name: KeepIssue :exec
insert into memory (id, agent, kind, body, terms, terms_of, repo, session, author, created_at, updated_at)
values (?1, ?2, 'issue', ?3, ?4, ?5, ?6, ?7, 'system', ?8, ?8)
on conflict (agent, session) where kind = 'issue'
do update set body = excluded.body, terms = excluded.terms, terms_of = excluded.terms_of,
   repo = excluded.repo, created_at = excluded.created_at, updated_at = excluded.updated_at;
