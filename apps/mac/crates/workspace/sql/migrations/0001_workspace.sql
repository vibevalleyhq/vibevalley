CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    last_opened_ms INTEGER NOT NULL
);
CREATE TABLE layouts (
    project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    json TEXT NOT NULL
);
CREATE TABLE terminals (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    ord INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    title TEXT,
    scrollback TEXT NOT NULL,
    PRIMARY KEY (project_id, id)
);
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

PRAGMA user_version = 1;
