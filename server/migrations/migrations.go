// Package migrations: the schema, run in name order, each once (PRAGMA user_version counts them). The server runs them at start
// (internal/base/db.go), cmd/migrate by hand; sqlc reads them as the schema of the queries in pkg/db/queries.
package migrations

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"os"
	"slices"
)

//go:embed *.sql
var embedded embed.FS

// The migrations Up runs, in name order: the files here. A test of the upgrade path puts its own.
var FS fs.FS = embedded

// In the order they run.
func Names() []string {
	entries, _ := fs.ReadDir(FS, ".")
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

// Up backs up and migrates SQLite's actual main database on one connection.
// An empty main filename denotes a memory or temporary database and has no adjacent backup.
func Up(db *sql.DB) ([]string, error) {
	ctx := context.Background()
	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	path, err := mainFile(ctx, conn)
	if err != nil {
		return nil, err
	}
	names := Names()
	var done int
	if err := conn.QueryRowContext(ctx, "pragma main.user_version").Scan(&done); err != nil {
		return nil, err
	}
	if done > len(names) {
		label := path
		if label == "" {
			label = ":memory:"
		}
		return nil, fmt.Errorf("%s is from a schema this server does not know (version %d, it knows %d): start with another home or VIBEVALLEY_DB", label, done, len(names))
	}
	if done > 0 && done < len(names) && path != "" {
		copied := fmt.Sprintf("%s.v%d", path, done)
		if _, err := os.Stat(copied); err != nil {
			if _, err := conn.ExecContext(ctx, "vacuum main into ?", copied); err != nil {
				return nil, fmt.Errorf("copy before migrating: %w", err)
			}
		}
	}
	// Foreign-key pragmas and migrations use this same connection; each migration is checked before commit.
	if _, err := conn.ExecContext(ctx, "pragma foreign_keys = off"); err != nil {
		return nil, err
	}
	defer conn.ExecContext(ctx, "pragma foreign_keys = on")
	var ran []string
	for i, name := range names[done:] {
		body, err := fs.ReadFile(FS, name)
		if err != nil {
			return ran, err
		}
		tx, err := conn.BeginTx(ctx, nil)
		if err != nil {
			return ran, err
		}
		if _, err := tx.Exec(string(body)); err != nil {
			tx.Rollback()
			return ran, fmt.Errorf("migration %s: %w", name, err)
		}
		if broken, err := foreignKeysBroken(tx); err != nil || broken != "" {
			tx.Rollback()
			return ran, fmt.Errorf("migration %s leaves a foreign key broken: %s %v", name, broken, err)
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

// SQLite resolves URI escapes, relative paths and in-memory names for the opened connection.
func mainFile(ctx context.Context, conn *sql.Conn) (string, error) {
	rows, err := conn.QueryContext(ctx, "pragma database_list")
	if err != nil {
		return "", err
	}
	defer rows.Close()
	for rows.Next() {
		var seq int
		var name, path string
		if err := rows.Scan(&seq, &name, &path); err != nil {
			return "", err
		}
		if name == "main" {
			return path, nil
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	return "", fmt.Errorf("SQLite connection has no main database")
}

// foreignKeysBroken names the first row whose reference points nowhere, "" when there is none.
func foreignKeysBroken(tx *sql.Tx) (string, error) {
	rows, err := tx.Query("pragma foreign_key_check")
	if err != nil {
		return "", err
	}
	defer rows.Close()
	if rows.Next() {
		var table, parent string
		var rowid, fk sql.NullInt64
		if err := rows.Scan(&table, &rowid, &parent, &fk); err != nil {
			return "", err
		}
		return fmt.Sprintf("%s row %d → %s", table, rowid.Int64, parent), nil
	}
	return "", rows.Err()
}
