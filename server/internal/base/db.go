package base

// The farm's database: SQLite (modernc, pure Go) in $VIBEVALLEY_HOME/farm.db. One connection, so one writer and seq
// order is commit order (the group chat relies on it). The migrations in server/migrations run at start, in name order,
// each once (PRAGMA user_version counts them).

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	_ "modernc.org/sqlite"

	"vibevalley/migrations"
)

// OpenDB opens and migrates the database at path; ":memory:" for tests.
func OpenDB(path string) (*sql.DB, error) {
	dsn := path
	if path != ":memory:" {
		dsn = "file:" + filepath.ToSlash(path)
	}
	db, err := sql.Open("sqlite", dsn+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err := migrate(db, path); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func migrate(db *sql.DB, path string) error {
	entries, err := migrations.FS.ReadDir(".")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	slices.Sort(names)
	var done int
	if err := db.QueryRow("pragma user_version").Scan(&done); err != nil {
		return err
	}
	// A database migrations are about to change is copied beside it first, as it was (farm.db.v5 at version 5).
	if done > 0 && done < len(names) && path != ":memory:" {
		copied := fmt.Sprintf("%s.v%d", path, done)
		if _, err := os.Stat(copied); err != nil {
			if _, err := db.Exec("vacuum into ?", copied); err != nil {
				return fmt.Errorf("copy before migrating: %w", err)
			}
		}
	}
	for i, name := range names[min(done, len(names)):] {
		body, err := migrations.FS.ReadFile(name)
		if err != nil {
			return err
		}
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(string(body)); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %s: %w", name, err)
		}
		if _, err := tx.Exec(fmt.Sprintf("pragma user_version = %d", done+i+1)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// Placeholders is "?, ?, ?" for n values.
func Placeholders(n int) string { return strings.TrimSuffix(strings.Repeat("?, ", n), ", ") }
