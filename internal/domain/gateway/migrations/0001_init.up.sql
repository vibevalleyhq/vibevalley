CREATE TABLE IF NOT EXISTS gateway_kv (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_issue (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gateway_issue_status_idx ON gateway_issue(status);

CREATE TABLE IF NOT EXISTS gateway_channel (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gateway_channel_updated_at_idx ON gateway_channel(updated_at);

CREATE TABLE IF NOT EXISTS gateway_agent (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_template (
    id TEXT PRIMARY KEY,
    updated_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_runtime (
    id TEXT PRIMARY KEY,
    updated_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_cron (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL,
    next_run_at TEXT,
    updated_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gateway_cron_enabled_next_idx ON gateway_cron(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS gateway_artifact (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gateway_artifact_updated_at_idx ON gateway_artifact(updated_at);

CREATE TABLE IF NOT EXISTS gateway_library_item (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gateway_library_item_created_at_idx ON gateway_library_item(created_at);

CREATE TABLE IF NOT EXISTS gateway_media_input (
    id TEXT PRIMARY KEY,
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    blob_path TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_media_job (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gateway_media_job_kind_created_idx ON gateway_media_job(kind, created_at);

CREATE TABLE IF NOT EXISTS gateway_pkm_page (
    path TEXT PRIMARY KEY,
    updated_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_pkm_comment (
    id TEXT PRIMARY KEY,
    page_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gateway_pkm_comment_page_idx ON gateway_pkm_comment(page_path);

CREATE TABLE IF NOT EXISTS gateway_pkm_clip (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_session (
    id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gateway_session_issue_idx ON gateway_session(issue_id);

CREATE TABLE IF NOT EXISTS gateway_session_event (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS gateway_request_key (
    scope_key TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    response_json TEXT NOT NULL
);
