-- The notes' blocks for full-text search (pkm/pkm.ts).

-- name: ClearPageTerms :exec
delete from pkm_term where page = sqlc.arg(page)::text;

-- name: ClearAllTerms :exec
delete from pkm_term;

-- name: AddTerms :exec
-- rows: JSON [{"block", "page", "terms"}], a page's blocks in one statement.
insert into pkm_term (block, page, terms)
select value ->> 'block', value ->> 'page', value ->> 'terms' from jsonb_array_elements(sqlc.arg(rows)::text::jsonb) as value;

-- name: MatchTerms :many
-- bound: the best 500 blocks that share a word, best first. term_query quotes each word, so none reads as an operator;
-- each matches the words it begins.
select block::text as block, page::text as page, ts_rank(term_vector(terms), term_query(sqlc.arg(words)::text[], true))::float8 as score
from pkm_term
where term_vector(terms) @@ term_query(sqlc.arg(words)::text[], true)
order by score desc
limit 500;
