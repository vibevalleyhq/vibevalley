package base

// One connection, so one writer and seq order is commit order (the group chat relies on it). The schema is the migrations package's.

import (
	"database/sql"
	"net/url"
	"path/filepath"

	_ "modernc.org/sqlite"

	"vibevalley/migrations"
)

// Opened and brought up to the newest schema.
func OpenDB(path string) (*sql.DB, error) {
	db, err := OpenDBAsIs(path)
	if err != nil {
		return nil, err
	}
	if _, err := migrations.Up(db, path); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// Opened without migrating (cmd/migrate's status).
func OpenDBAsIs(path string) (*sql.DB, error) {
	dsn := path
	if path != ":memory:" {
		absolute, err := filepath.Abs(path)
		if err != nil {
			return nil, err
		}
		dsn = (&url.URL{Scheme: "file", Path: filepath.ToSlash(absolute)}).String()
	}
	db, err := sql.Open("sqlite", dsn+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	return db, nil
}
