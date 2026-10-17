-- The full-text index over memory's terms. External content: the text is memory's, and the migration's triggers keep the
-- index in step with it, so nothing writes here.

-- name: MatchMemories :many
-- How well each of an agent's memories matches an FTS5 query. bm25 is lower for a better match. The column form of MATCH:
-- sqlc does not know the table form.
select m.id, cast(bm25(memory_term) as real) as score
from memory_term join memory m on m.rowid = memory_term.rowid
where memory_term.terms match sqlc.arg(query) and m.agent = cast(sqlc.arg(agent) as text) and m.replaced_by is null;
