CREATE TABLE IF NOT EXISTS issue (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    repo_id TEXT NOT NULL DEFAULT '',
    assignee_id TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',
    conversation_id TEXT NOT NULL DEFAULT '',
    state_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS issue_status_idx ON issue(status);
CREATE INDEX IF NOT EXISTS issue_conv_idx ON issue(conversation_id);
CREATE INDEX IF NOT EXISTS issue_session_idx ON issue(session_id);

CREATE TABLE IF NOT EXISTS issue_cron (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    pending_approval INTEGER NOT NULL DEFAULT 0,
    next_run_at_ms INTEGER NOT NULL DEFAULT 0,
    last_run_at_ms INTEGER NOT NULL DEFAULT 0,
    state_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS issue_cron_due_idx
    ON issue_cron(enabled, pending_approval, next_run_at_ms);
