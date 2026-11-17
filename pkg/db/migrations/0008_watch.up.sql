CREATE TABLE IF NOT EXISTS watch_cursor (
    id TEXT PRIMARY KEY,
    last_global_seq INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS watch_seat (
    channel_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    conversation_id TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',
    thread_owner INTEGER NOT NULL DEFAULT 0,
    home_channel_id TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    seated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (channel_id, agent_id)
);

CREATE TABLE IF NOT EXISTS watch_agent_home (
    agent_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watch_brake_state (
    id TEXT PRIMARY KEY,
    state_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watch_inbox (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    issue_id TEXT NOT NULL DEFAULT '',
    resolved INTEGER NOT NULL DEFAULT 0,
    channel_id TEXT NOT NULL DEFAULT '',
    event_seq INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS watch_inbox_chan_seq_idx
    ON watch_inbox(channel_id, event_seq);
