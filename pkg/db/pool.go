package db

import (
	"database/sql"
	"errors"
	"strings"
)

// Pool holds the single-writer and concurrent-reader SQLite pools for a database DSN.
type Pool struct {
	WriteDB *sql.DB
	ReadDB  *sql.DB
	SameDB  bool
	IsMem   bool
}

// Close closes ReadDB (when distinct from WriteDB) and WriteDB, joining any errors.
func (p *Pool) Close() error {
	if p == nil {
		return nil
	}
	var errs []error
	if !p.SameDB && p.ReadDB != nil {
		if err := p.ReadDB.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	if p.WriteDB != nil {
		if err := p.WriteDB.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// IsMemoryDSN reports whether dsn addresses an in-memory SQLite database.
func IsMemoryDSN(dsn string) bool {
	trimmed := strings.TrimSpace(dsn)
	return trimmed == ":memory:" || strings.Contains(trimmed, "mode=memory") || strings.Contains(trimmed, ":memory:")
}
