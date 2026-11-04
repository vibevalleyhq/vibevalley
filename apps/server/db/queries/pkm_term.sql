-- The notes' blocks for full-text search (pkm/pkm.ts).

-- name: ClearPageTerms :exec
delete from pkm_term where page = sqlc.arg(page)::text;

-- name: ClearAllTerms :exec
delete from pkm_term;

-- name: AddTerms :exec
-- rows: JSON [{"block", "page", "terms"}], a page's blocks in one statement.
insert into pkm_term (block, page, terms)
select value ->> 'block', value ->> 'page', value ->> 'terms' from json_each(sqlc.arg(rows)::text);

-- name: MatchTerms :many
-- bound: the best 500 blocks that share a word, best first (bm25 is lower for a better match). The words go in as
-- phrases, quoted, so none reads as an operator; each matches the words it begins.
select block::text as block, page::text as page, (-bm25(pkm_term))::real as score
from pkm_term
where pkm_term match (select group_concat('"' || replace(value, '"', '""') || '"*', ' OR ') from json_each(sqlc.arg(words)::text[]))
order by score desc
limit 500;
