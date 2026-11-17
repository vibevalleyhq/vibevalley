//go:build thin_desktop

package db

import (
	"context"
	"errors"
)

// RegisterVec is a no-op in thin_desktop builds where the SQLite driver is excluded.
func RegisterVec() {}

// OpenPool returns an error in thin_desktop builds where the embedded SQLite pool is disabled.
func OpenPool(ctx context.Context, _ string) (*Pool, error) {
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
	}
	return nil, errors.New("db: sqlite pool is disabled in thin_desktop builds")
}
