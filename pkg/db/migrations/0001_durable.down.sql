DROP INDEX IF EXISTS durable_signal_task_pending_idx;
DROP INDEX IF EXISTS durable_signal_task_key;
DROP TABLE IF EXISTS durable_signal;

DROP INDEX IF EXISTS durable_task_conv_idx;
DROP INDEX IF EXISTS durable_task_status_idx;
DROP INDEX IF EXISTS durable_task_owner_idx;
DROP INDEX IF EXISTS durable_task_owner_dedup;
DROP TABLE IF EXISTS durable_task;

DROP TABLE IF EXISTS durable_submission;
DROP TABLE IF EXISTS durable_document;
DROP TABLE IF EXISTS durable_entry;

DROP INDEX IF EXISTS durable_conversation_owner_idx;
DROP TABLE IF EXISTS durable_conversation;
