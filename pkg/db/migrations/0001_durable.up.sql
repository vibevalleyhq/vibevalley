CREATE TABLE IF NOT EXISTS durable_conversation (
	id TEXT PRIMARY KEY,
	owner_task_id TEXT NOT NULL DEFAULT '',
	parent_id TEXT NOT NULL DEFAULT '',
	fork_entry_seq INTEGER NOT NULL DEFAULT 0,
	head_seq INTEGER NOT NULL DEFAULT 1,
	next_seq INTEGER NOT NULL DEFAULT 1,
	provider_affinity TEXT NOT NULL DEFAULT '',
	metadata_json TEXT NOT NULL DEFAULT '{}',
	created_at_ms INTEGER NOT NULL,
	updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS durable_conversation_owner_idx ON durable_conversation(owner_task_id);

CREATE TABLE IF NOT EXISTS durable_entry (
	conversation_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	kind TEXT NOT NULL,
	payload_json TEXT NOT NULL,
	created_at_ms INTEGER NOT NULL,
	PRIMARY KEY (conversation_id, seq)
);

CREATE TABLE IF NOT EXISTS durable_document (
	scope_kind TEXT NOT NULL,
	scope_id TEXT NOT NULL,
	doc_kind TEXT NOT NULL,
	rev INTEGER NOT NULL,
	state_json TEXT NOT NULL,
	updated_at_ms INTEGER NOT NULL,
	PRIMARY KEY (scope_kind, scope_id, doc_kind)
);

CREATE TABLE IF NOT EXISTS durable_submission (
	id TEXT PRIMARY KEY,
	conversation_id TEXT NOT NULL,
	request_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	status TEXT NOT NULL,
	payload_json TEXT NOT NULL,
	notify_task_id TEXT NOT NULL DEFAULT '',
	result_json TEXT NOT NULL DEFAULT '{}',
	created_at_ms INTEGER NOT NULL,
	updated_at_ms INTEGER NOT NULL,
	UNIQUE(conversation_id, request_id)
);

CREATE TABLE IF NOT EXISTS durable_task (
	id TEXT PRIMARY KEY,
	conversation_id TEXT NOT NULL DEFAULT '',
	owner_task_id TEXT NOT NULL DEFAULT '',
	dedup_key TEXT NOT NULL DEFAULT '',
	kind TEXT NOT NULL,
	is_model_task INTEGER NOT NULL DEFAULT 0,
	status TEXT NOT NULL,
	terminal_reason TEXT NOT NULL DEFAULT '',
	restart_count INTEGER NOT NULL DEFAULT 0,
	restart_limit INTEGER NOT NULL DEFAULT 5,
	phase_name TEXT NOT NULL DEFAULT '',
	checkpoint_json TEXT NOT NULL DEFAULT '{}',
	wake_until_ms INTEGER NOT NULL DEFAULT 0,
	wait_mode TEXT NOT NULL DEFAULT '',
	wait_task_ids_json TEXT NOT NULL DEFAULT '[]',
	wait_signal_name TEXT NOT NULL DEFAULT '',
	memo_json TEXT NOT NULL DEFAULT '{}',
	result_json TEXT NOT NULL DEFAULT '{}',
	error_text TEXT NOT NULL DEFAULT '',
	created_at_ms INTEGER NOT NULL,
	updated_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS durable_task_owner_dedup ON durable_task(owner_task_id, dedup_key) WHERE dedup_key <> '';
CREATE INDEX IF NOT EXISTS durable_task_owner_idx ON durable_task(owner_task_id);
CREATE INDEX IF NOT EXISTS durable_task_status_idx ON durable_task(status);
CREATE INDEX IF NOT EXISTS durable_task_conv_idx ON durable_task(conversation_id);

CREATE TABLE IF NOT EXISTS durable_signal (
	id TEXT PRIMARY KEY,
	insert_seq INTEGER NOT NULL,
	task_id TEXT NOT NULL,
	signal_name TEXT NOT NULL,
	signal_key TEXT NOT NULL DEFAULT '',
	payload_json TEXT NOT NULL DEFAULT '{}',
	consumed INTEGER NOT NULL DEFAULT 0,
	consumed_at_ms INTEGER NOT NULL DEFAULT 0,
	created_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS durable_signal_task_key ON durable_signal(task_id, signal_name, signal_key) WHERE signal_key <> '';
CREATE INDEX IF NOT EXISTS durable_signal_task_pending_idx ON durable_signal(task_id, signal_name, consumed);
