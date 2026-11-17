//go:build !thin_desktop

package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/viant/sqlite-vec/engine"
	"github.com/viant/sqlite-vec/vec"
	_ "modernc.org/sqlite"
)

var registerVecOnce sync.Once

// RegisterVec registers sqlite-vec scalar vector functions once per process.
func RegisterVec() {
	registerVecOnce.Do(func() {
		_ = engine.RegisterVectorFunctions(nil)
	})
}

// OpenPool opens a SQLite connection pool configured for WAL concurrency and sqlite-vec.
func OpenPool(ctx context.Context, dsn string) (*Pool, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	dsn = strings.TrimSpace(dsn)
	if dsn == "" {
		return nil, errors.New("db: sqlite dsn is required")
	}

	RegisterVec()

	isMem := IsMemoryDSN(dsn)
	if !isMem && !strings.HasPrefix(dsn, "file:") {
		if dir := filepath.Dir(dsn); dir != "" && dir != "." {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return nil, fmt.Errorf("db: mkdir %q: %w", dir, err)
			}
		}
	}

	writeDB, err := engine.Open(dsn)
	if err != nil {
		return nil, fmt.Errorf("db: open sqlite writer: %w", err)
	}
	writeDB.SetMaxOpenConns(1)

	if err := vec.Register(writeDB); err != nil {
		_ = writeDB.Close()
		return nil, fmt.Errorf("db: register sqlite-vec writer: %w", err)
	}

	pragmas := []string{
		"PRAGMA busy_timeout=15000",
		"PRAGMA foreign_keys=ON",
		"PRAGMA synchronous=NORMAL",
	}
	if !isMem {
		pragmas = append(pragmas, "PRAGMA journal_mode=WAL")
	}
	for _, p := range pragmas {
		if _, err := writeDB.ExecContext(ctx, p); err != nil {
			_ = writeDB.Close()
			return nil, fmt.Errorf("db: %s: %w", p, err)
		}
	}

	var readDB *sql.DB
	sameDB := false
	if isMem {
		// In-memory SQLite databases are per-connection unless shared; reuse the writer pool.
		readDB = writeDB
		sameDB = true
	} else {
		sep := "?"
		if strings.Contains(dsn, "?") {
			sep = "&"
		}
		// Omit mode=ro because sqlite-vec may persist index state via ReadDB queries.
		readDSN := dsn + sep + "_pragma=busy_timeout(15000)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(1)"
		readDB, err = engine.Open(readDSN)
		if err != nil {
			_ = writeDB.Close()
			return nil, fmt.Errorf("db: open sqlite reader: %w", err)
		}
		readDB.SetMaxOpenConns(4)

		if err := vec.Register(readDB); err != nil {
			_ = readDB.Close()
			_ = writeDB.Close()
			return nil, fmt.Errorf("db: register sqlite-vec reader: %w", err)
		}
		if err := readDB.PingContext(ctx); err != nil {
			_ = readDB.Close()
			_ = writeDB.Close()
			return nil, fmt.Errorf("db: ping sqlite reader: %w", err)
		}
	}

	return &Pool{
		WriteDB: writeDB,
		ReadDB:  readDB,
		SameDB:  sameDB,
		IsMem:   isMem,
	}, nil
}
