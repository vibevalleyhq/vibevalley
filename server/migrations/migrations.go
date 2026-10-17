// Package migrations: the schema, run in name order, each once (PRAGMA user_version counts them). The server runs them at start
// (internal/base/db.go), cmd/migrate by hand; sqlc reads them as the schema of the queries in pkg/db/queries.
package migrations

import (
	"database/sql"
	"embed"
	"fmt"
	"os"
	"slices"
)

//go:embed *.sql
var FS embed.FS

// In the order they run.
func Names() []string {
	entries, _ := FS.ReadDir(".")
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	slices.Sort(names)
	return names
}

// How many have run on db.
func Version(db *sql.DB) (int, error) {
	var done int
	err := db.QueryRow("pragma user_version").Scan(&done)
	return done, err
}

// Runs the ones db has not had, each in its own transaction, and says which ran. path is db's file (":memory:" for none): a
// database about to change is copied beside it first, as it was (vibevalley.db.v5 at version 5).
func Up(db *sql.DB, path string) ([]string, error) {
	names := Names()
	done, err := Version(db)
	if err != nil {
		return nil, err
	}
	if done > len(names) {
		return nil, fmt.Errorf("%s is from a schema this server does not know (version %d, it knows %d): start with another home or VIBEVALLEY_DB", path, done, len(names))
	}
	if done > 0 && done < len(names) && path != ":memory:" {
		copied := fmt.Sprintf("%s.v%d", path, done)
		if _, err := os.Stat(copied); err != nil {
			if _, err := db.Exec("vacuum into ?", copied); err != nil {
				return nil, fmt.Errorf("copy before migrating: %w", err)
			}
		}
	}
	var ran []string
	for i, name := range names[done:] {
		body, err := FS.ReadFile(name)
		if err != nil {
			return ran, err
		}
		tx, err := db.Begin()
		if err != nil {
			return ran, err
		}
		if _, err := tx.Exec(string(body)); err != nil {
			tx.Rollback()
			return ran, fmt.Errorf("migration %s: %w", name, err)
		}
		if _, err := tx.Exec(fmt.Sprintf("pragma user_version = %d", done+i+1)); err != nil {
			tx.Rollback()
			return ran, err
		}
		if err := tx.Commit(); err != nil {
			return ran, err
		}
		ran = append(ran, name)
	}
	return ran, nil
}
