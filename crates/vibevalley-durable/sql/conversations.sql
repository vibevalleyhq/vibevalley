-- name: GetConversation :one
SELECT * FROM durable_conversation WHERE id=?1;
-- name: ConversationsByOwner :many
SELECT * FROM durable_conversation WHERE owner_task_id=?1 ORDER BY created_at_ms,id;
-- name: EntriesFrom :many
SELECT * FROM durable_entry WHERE conversation_id=?1 AND seq >= sqlc.arg(seq) ORDER BY seq;
-- name: EntriesWithin :many
SELECT * FROM durable_entry WHERE conversation_id=?1 AND seq >= sqlc.arg(first_seq) AND seq <= sqlc.arg(last_seq) ORDER BY seq;
-- name: GetSubmission :one
SELECT * FROM durable_submission WHERE id=?1;
-- name: SubmissionByRequest :one
SELECT * FROM durable_submission WHERE conversation_id=?1 AND request_id=?2;
-- name: Submissions :many
SELECT * FROM durable_submission WHERE conversation_id=?1 ORDER BY created_at_ms,id;
-- name: InsertConversation :exec
INSERT INTO durable_conversation(id,provider_affinity,owner_task_id,created_at_ms,updated_at_ms) VALUES (?1,?2,?3,?4,?4);
-- name: ForkConversation :exec
INSERT INTO durable_conversation(id,owner_task_id,parent_id,fork_entry_seq,head_seq,next_seq,provider_affinity,created_at_ms,updated_at_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8);
-- name: AdvanceSequence :one
UPDATE durable_conversation SET next_seq=next_seq+1, updated_at_ms=?1 WHERE id=?2 RETURNING next_seq;
-- name: InsertEntry :exec
INSERT INTO durable_entry(conversation_id,seq,kind,payload_json,created_at_ms) VALUES (?1,?2,?3,?4,?5);
-- name: SetHead :exec
UPDATE durable_conversation SET head_seq=?1 WHERE id=?2;
-- name: ResetHead :exec
UPDATE durable_conversation SET head_seq=next_seq WHERE id=?1;
-- name: InsertSubmission :exec
INSERT INTO durable_submission(id,conversation_id,request_id,kind,status,payload_json,notify_task_id,created_at_ms,updated_at_ms) VALUES (?1,?2,?3,?4,'queued',?5,?6,?7,?7);
-- name: SetSubmissionStatus :exec
UPDATE durable_submission SET status=?1,updated_at_ms=?2 WHERE id=?3;
-- name: SettleSubmission :exec
UPDATE durable_submission SET status=?1,result_json=?2,updated_at_ms=?3 WHERE id=?4;
