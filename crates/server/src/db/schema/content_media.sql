CREATE TABLE IF NOT EXISTS media_input (
  id TEXT PRIMARY KEY, metadata TEXT NOT NULL, size INTEGER NOT NULL,
  phase TEXT NOT NULL, hash TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS media_input_pin (
  input_id TEXT NOT NULL REFERENCES media_input(id) ON DELETE CASCADE,
  holder TEXT NOT NULL, PRIMARY KEY (input_id, holder)
);
CREATE TABLE IF NOT EXISTS media_job (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, phase TEXT NOT NULL, data TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS media_job_recent ON media_job(created_at DESC, id);
