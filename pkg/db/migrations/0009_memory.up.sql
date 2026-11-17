CREATE TABLE IF NOT EXISTS memory_heads (
    scope_id TEXT PRIMARY KEY,
    active_version INTEGER NOT NULL DEFAULT 0,
    next_version INTEGER NOT NULL DEFAULT 1,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_versions (
    scope_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    parent_version INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (scope_id, version)
);

CREATE TABLE IF NOT EXISTS memory_version_files (
    scope_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    rel_path TEXT NOT NULL,
    file_version INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    content BLOB NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (scope_id, version, rel_path)
);

CREATE TABLE IF NOT EXISTS memory_conflicts (
    conflict_id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    base_version INTEGER NOT NULL,
    server_version INTEGER NOT NULL,
    conflict_rel_path TEXT NOT NULL,
    uploaded_sha256 TEXT NOT NULL,
    content BLOB NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    resolved INTEGER NOT NULL DEFAULT 0,
    resolution TEXT NOT NULL DEFAULT '',
    created_at_ms INTEGER NOT NULL,
    resolved_at_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS memory_conflicts_scope_idx ON memory_conflicts(scope_id, resolved, created_at_ms);

CREATE TABLE IF NOT EXISTS memory_dreams (
    proposal_id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL,
    base_version INTEGER NOT NULL,
    candidate_version INTEGER NOT NULL,
    deduplicated_count INTEGER NOT NULL DEFAULT 0,
    summary TEXT NOT NULL,
    status TEXT NOT NULL,
    runner_session_id TEXT NOT NULL DEFAULT '',
    previous_active_version INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    resolved_at_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS memory_dreams_scope_idx ON memory_dreams(scope_id, created_at_ms);

CREATE TABLE IF NOT EXISTS memory_inbox (
    id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    issue_id TEXT NOT NULL DEFAULT '',
    proposal_id TEXT NOT NULL DEFAULT '',
    conflict_id TEXT NOT NULL DEFAULT '',
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_inbox_scope_idx ON memory_inbox(scope_id, resolved, created_at_ms);
