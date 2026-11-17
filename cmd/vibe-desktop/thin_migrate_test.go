//go:build thin_desktop

package main

import (
	"bytes"
	"context"
	"path/filepath"
	"strings"
	"testing"
)

func TestVibeDesktopThinMigrateReturnsClearError(t *testing.T) {
	t.Parallel()
	tmp := t.TempDir()
	dbPath := filepath.Join(tmp, "thin.db")
	getenv := mapGetenv(map[string]string{"VIBEVALLEY_HOME": filepath.Join(tmp, "home")})

	for _, args := range [][]string{
		{"migrate", "up", "--db", dbPath},
		{"migrate", "down", "--db", dbPath, "--all"},
		{"migrate", "status", "--db", dbPath},
	} {
		var out, errBuf bytes.Buffer
		err := run(context.Background(), args, getenv, &out, &errBuf, DesktopDeps{})
		if err == nil || !strings.Contains(err.Error(), "thin_desktop") {
			t.Fatalf("args %v: expected thin_desktop unsupported error, got %v", args, err)
		}
	}
}
