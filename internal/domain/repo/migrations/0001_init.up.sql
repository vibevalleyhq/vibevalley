CREATE TABLE IF NOT EXISTS repo_repository (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	state_json TEXT NOT NULL,
	created_at_ms INTEGER NOT NULL,
	updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS repo_worktree (
	repo_id TEXT NOT NULL,
	issue_id TEXT NOT NULL,
	status TEXT NOT NULL,
	state_json TEXT NOT NULL,
	created_at_ms INTEGER NOT NULL,
	updated_at_ms INTEGER NOT NULL,
	PRIMARY KEY (repo_id, issue_id)
);
