-- Each batch a document took (doc/doc.ts): its seq, and its results for a batch that comes again.

-- name: DocChangeByBatch :one
select * from doc_change where batch_id = sqlc.arg(batch_id);

-- name: AddDocChange :exec
insert into doc_change (doc_id, seq, batch_id, actor, block_ids, results, created_at)
values (sqlc.arg(doc_id), sqlc.arg(seq), sqlc.arg(batch_id), sqlc.arg(actor), sqlc.arg(block_ids), sqlc.arg(results), sqlc.arg(created_at));
