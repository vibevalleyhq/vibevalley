-- Each batch a document took (doc/doc.go): its seq, and its results for a batch that comes again.

-- name: DocChangeByBatch :one
select * from doc_change where batch_id = ?;

-- name: AddDocChange :exec
insert into doc_change (doc_id, seq, batch_id, actor, block_ids, results, created_at) values (?, ?, ?, ?, ?, ?, ?);
