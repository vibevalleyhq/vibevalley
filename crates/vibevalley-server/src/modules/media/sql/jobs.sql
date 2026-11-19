CREATE TABLE IF NOT EXISTS media_job (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, phase TEXT NOT NULL, data TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS media_job_recent ON media_job(created_at DESC, id);
