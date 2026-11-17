CREATE TABLE IF NOT EXISTS channel (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    topic TEXT NOT NULL DEFAULT '',
    repo_id TEXT NOT NULL DEFAULT '',
    default_agent_id TEXT NOT NULL DEFAULT '',
    peer_id TEXT NOT NULL DEFAULT '',
    parent_channel_id TEXT NOT NULL DEFAULT '',
    parent_event_seq INTEGER NOT NULL DEFAULT 0,
    issue_id TEXT NOT NULL DEFAULT '',
    is_default INTEGER NOT NULL DEFAULT 0,
    notify_mode TEXT NOT NULL DEFAULT 'all',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS channel_issue_thread_idx
    ON channel(issue_id) WHERE type = 'thread' AND issue_id <> '';

CREATE TABLE IF NOT EXISTS channel_member (
    channel_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    added_at_ms INTEGER NOT NULL,
    PRIMARY KEY (channel_id, member_id)
);

CREATE TABLE IF NOT EXISTS channel_event (
    global_seq INTEGER PRIMARY KEY,
    channel_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    author_id TEXT NOT NULL,
    actor_kind TEXT NOT NULL,
    actor_role TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',
    issue_id TEXT NOT NULL DEFAULT '',
    mentions_json TEXT NOT NULL DEFAULT '[]',
    target_agent_id TEXT NOT NULL DEFAULT '',
    send_key TEXT NOT NULL DEFAULT '',
    question_json TEXT NOT NULL DEFAULT '',
    report_json TEXT NOT NULL DEFAULT '',
    reaction_json TEXT NOT NULL DEFAULT '',
    created_at_ms INTEGER NOT NULL,
    UNIQUE (channel_id, seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS channel_event_send_key_idx
    ON channel_event(channel_id, author_id, send_key) WHERE send_key <> '';

CREATE INDEX IF NOT EXISTS channel_event_chan_seq_idx
    ON channel_event(channel_id, seq);

CREATE TRIGGER IF NOT EXISTS channel_event_no_update
BEFORE UPDATE ON channel_event
BEGIN
    SELECT RAISE(ABORT, 'channel_event is append-only');
END;

CREATE TRIGGER IF NOT EXISTS channel_event_no_delete
BEFORE DELETE ON channel_event
BEGIN
    SELECT RAISE(ABORT, 'channel_event is append-only');
END;

CREATE TABLE IF NOT EXISTS channel_read_cursor (
    channel_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    read_seq INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (channel_id, actor_id)
);
