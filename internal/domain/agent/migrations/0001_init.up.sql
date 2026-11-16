CREATE TABLE IF NOT EXISTS agent_profile (
	id TEXT PRIMARY KEY,
	state_json TEXT NOT NULL,
	updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_skill (
	id TEXT PRIMARY KEY,
	built_in INTEGER NOT NULL DEFAULT 0,
	state_json TEXT NOT NULL,
	updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runtime (
	id TEXT PRIMARY KEY,
	state_json TEXT NOT NULL
);
