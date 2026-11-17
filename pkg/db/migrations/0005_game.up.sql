CREATE TABLE IF NOT EXISTS game_ledger (
	seq INTEGER PRIMARY KEY,
	kind TEXT NOT NULL,
	payload_json TEXT NOT NULL,
	created_at_ms INTEGER NOT NULL
);
