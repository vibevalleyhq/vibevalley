-- name: AddChange :exec
INSERT INTO pkm_change (at, what, page, before_file, after_file, before_text, after_text) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);

-- name: PreviousChange :one
SELECT seq, what, page, before_file, after_file, before_text FROM pkm_change ORDER BY seq DESC LIMIT 1;

-- name: DropChange :exec
DELETE FROM pkm_change WHERE seq = ?1;

-- name: TrimChanges :exec
DELETE FROM pkm_change WHERE seq <= (SELECT MAX(seq) FROM pkm_change) - CAST(sqlc.arg(keep) AS INTEGER);

-- name: OpenComments :many
SELECT * FROM pkm_comment WHERE status IN ('open','suggested') AND (CAST(sqlc.narg(page) AS TEXT) IS NULL OR page = sqlc.narg(page)) ORDER BY created_at, id;

-- name: FindComment :one
SELECT * FROM pkm_comment WHERE id = ?1;

-- name: LatestBlockComment :one
SELECT * FROM pkm_comment WHERE block = ?1 ORDER BY created_at DESC, id DESC LIMIT 1;

-- name: KeepRemark :exec
INSERT INTO pkm_comment (id,page,block,span,author,body,status,created_at)
VALUES (?1,?2,?3,?4,?5,?6,'open',?7)
ON CONFLICT(id) DO UPDATE SET body=excluded.body, page=excluded.page WHERE pkm_comment.status='open';

-- name: AddSuggestion :exec
INSERT INTO pkm_comment (id,page,block,author,body,status,suggested,rationale,created_at)
VALUES (?1,?2,?3,?4,?5,'suggested',?6,?7,?8);

-- name: Suggest :exec
UPDATE pkm_comment SET status='suggested', suggested=?2, rationale=?3 WHERE id=?1;

-- name: ResolveComment :exec
UPDATE pkm_comment SET status=?2, resolved_at=?3 WHERE id=?1;

-- name: RemarkedBlocks :many
SELECT DISTINCT block FROM pkm_comment WHERE status IN ('open','suggested');

-- name: MovePageComments :exec
UPDATE pkm_comment SET page=sqlc.arg(new_page) WHERE page=sqlc.arg(old_page);

-- name: AcceptBlockComments :exec
UPDATE pkm_comment SET status='accepted', resolved_at=?2 WHERE block=?1 AND status IN ('open','suggested');

-- name: ClearPageTerms :exec
DELETE FROM pkm_term WHERE page=?1;

-- name: ClearAllTerms :exec
DELETE FROM pkm_term;

-- name: AddTerm :exec
INSERT INTO pkm_term(block,page,terms) VALUES (?1,?2,?3)
ON CONFLICT(page, block) DO UPDATE SET terms = excluded.terms;

-- name: AllTerms :many
SELECT block,terms FROM pkm_term;
