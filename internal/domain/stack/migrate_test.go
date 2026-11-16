package stack_test

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/viant/sqlite-vec/engine"
	"github.com/viant/sqlite-vec/vec"
	_ "modernc.org/sqlite"

	"github.com/vibevalleyhq/vibevalley/internal/domain/stack"
)

func TestStackMigrateUpStatusDownUpWALDirectory(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	dir := t.TempDir()
	dbPath := filepath.Join(dir, "platform.db")

	// Initial MigrateUp applies version 1 across all 10 scopes.
	upRes, err := stack.MigrateUp(ctx, dbPath)
	if err != nil {
		t.Fatalf("MigrateUp(1): %v", err)
	}
	if len(upRes) != 10 {
		t.Fatalf("expected 10 scope results, got %d", len(upRes))
	}

	seenScopes := make(map[string]stack.ScopeMigrationResult, len(upRes))
	for _, r := range upRes {
		seenScopes[r.Scope] = r
		if r.BeforeVersion != 0 || r.AfterVersion != 1 || r.Applied != 1 || r.Pending != 0 {
			t.Fatalf("unexpected initial MigrateUp result for %s: %+v", r.Scope, r)
		}
		if _, err := os.Stat(r.DBPath); err != nil {
			t.Fatalf("expected SQLite file for scope %s at %s: %v", r.Scope, r.DBPath, err)
		}
	}
	if seenScopes["durable"].DBPath != dbPath {
		t.Fatalf("durable DBPath = %q, want %q", seenScopes["durable"].DBPath, dbPath)
	}
	if seenScopes["vault"].DBPath != filepath.Join(dir, "platform.vault.db") {
		t.Fatalf("vault DBPath = %q, want sidecar", seenScopes["vault"].DBPath)
	}

	// Second MigrateUp is idempotent.
	upAgain, err := stack.MigrateUp(ctx, dbPath)
	if err != nil {
		t.Fatalf("MigrateUp(2): %v", err)
	}
	for _, r := range upAgain {
		if r.BeforeVersion != 1 || r.AfterVersion != 1 || r.Applied != 0 || r.Pending != 0 {
			t.Fatalf("expected idempotent MigrateUp for %s: %+v", r.Scope, r)
		}
	}

	// MigrateStatus shows all 10 scopes applied at version 1.
	statuses, err := stack.MigrateStatus(ctx, dbPath)
	if err != nil {
		t.Fatalf("MigrateStatus after Up: %v", err)
	}
	if len(statuses) != 10 {
		t.Fatalf("expected 10 status rows, got %d", len(statuses))
	}
	for _, st := range statuses {
		if !st.Applied || st.Version != 1 {
			t.Fatalf("expected applied v1 status, got %+v", st)
		}
	}

	// MigrateDown(steps=1, all=false) reverts all 10 scopes back to version 0.
	downStepRes, err := stack.MigrateDown(ctx, dbPath, 1, false)
	if err != nil {
		t.Fatalf("MigrateDown(steps=1): %v", err)
	}
	for _, r := range downStepRes {
		if r.BeforeVersion != 1 || r.AfterVersion != 0 || r.Reverted != 1 || r.Pending != 1 {
			t.Fatalf("unexpected MigrateDown(steps=1) result for %s: %+v", r.Scope, r)
		}
		assertNoUserTablesOrTriggers(t, ctx, r.DBPath)
	}

	statusesAfterDown, err := stack.MigrateStatus(ctx, dbPath)
	if err != nil {
		t.Fatalf("MigrateStatus after Down(steps=1): %v", err)
	}
	for _, st := range statusesAfterDown {
		if st.Applied {
			t.Fatalf("expected unapplied status after Down(steps=1), got %+v", st)
		}
	}

	// Re-apply via MigrateUp, then revert via MigrateDown(all=true), then re-apply and boot stack.New.
	if _, err := stack.MigrateUp(ctx, dbPath); err != nil {
		t.Fatalf("MigrateUp(re-apply 1): %v", err)
	}
	downAllRes, err := stack.MigrateDown(ctx, dbPath, 0, true)
	if err != nil {
		t.Fatalf("MigrateDown(all=true): %v", err)
	}
	for _, r := range downAllRes {
		if r.BeforeVersion != 1 || r.AfterVersion != 0 || r.Reverted != 1 || r.Pending != 1 {
			t.Fatalf("unexpected MigrateDown(all=true) result for %s: %+v", r.Scope, r)
		}
		assertNoUserTablesOrTriggers(t, ctx, r.DBPath)
	}

	reUpRes, err := stack.MigrateUp(ctx, dbPath)
	if err != nil {
		t.Fatalf("MigrateUp(re-apply 2): %v", err)
	}
	for _, r := range reUpRes {
		if r.Applied != 1 || r.AfterVersion != 1 {
			t.Fatalf("unexpected re-Up result for %s: %+v", r.Scope, r)
		}
	}

	// Booting stack.New against the pre-migrated WAL directory succeeds cleanly.
	s, err := stack.New(ctx, stack.Config{
		DBPath:   dbPath,
		WorkRoot: filepath.Join(dir, "work"),
	})
	if err != nil {
		t.Fatalf("stack.New on pre-migrated DB: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("stack.Close: %v", err)
	}
}

func TestStackMigrateMemorySharedDBAndValidation(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	if _, err := stack.MigrateDown(ctx, ":memory:", -1, false); err == nil {
		t.Fatal("expected error for negative steps when all=false")
	}

	memUp, err := stack.MigrateUp(ctx, ":memory:")
	if err != nil {
		t.Fatalf("MigrateUp(:memory:): %v", err)
	}
	if len(memUp) != 10 {
		t.Fatalf("expected 10 memory scope results, got %d", len(memUp))
	}

	sharedPath := filepath.Join(t.TempDir(), "shared.db")
	_ = engine.RegisterVectorFunctions(nil)
	db, err := engine.Open(sharedPath)
	if err != nil {
		t.Fatalf("open shared db: %v", err)
	}
	defer func() { _ = db.Close() }()
	if err := vec.Register(db); err != nil {
		t.Fatalf("vec.Register shared db: %v", err)
	}

	sharedUp, err := stack.MigrateUpDB(ctx, db, sharedPath)
	if err != nil || len(sharedUp) != 10 {
		t.Fatalf("MigrateUpDB: len=%d err=%v", len(sharedUp), err)
	}
	statuses, err := stack.MigrateStatusDB(ctx, db)
	if err != nil || len(statuses) != 10 {
		t.Fatalf("MigrateStatusDB: len=%d err=%v", len(statuses), err)
	}
	for _, st := range statuses {
		if !st.Applied {
			t.Fatalf("expected all 10 scopes applied in shared DB, got %+v", st)
		}
	}
	sharedDown, err := stack.MigrateDownDB(ctx, db, sharedPath, 0, true)
	if err != nil || len(sharedDown) != 10 {
		t.Fatalf("MigrateDownDB: len=%d err=%v", len(sharedDown), err)
	}
	if _, err := stack.MigrateUpDB(ctx, db, sharedPath); err != nil {
		t.Fatalf("MigrateUpDB re-apply: %v", err)
	}
}

func assertNoUserTablesOrTriggers(t *testing.T, ctx context.Context, dbPath string) {
	t.Helper()
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("sql.Open %s: %v", dbPath, err)
	}
	defer func() { _ = db.Close() }()

	rows, err := db.QueryContext(ctx, `SELECT name, type FROM sqlite_master WHERE type IN ('table', 'trigger')`)
	if err != nil {
		t.Fatalf("query sqlite_master on %s: %v", dbPath, err)
	}
	defer func() { _ = rows.Close() }()

	for rows.Next() {
		var name, typ string
		if err := rows.Scan(&name, &typ); err != nil {
			t.Fatalf("scan sqlite_master: %v", err)
		}
		if name == "schema_migrations" || strings.HasPrefix(name, "sqlite_") {
			continue
		}
		t.Fatalf("expected zero non-tracking user objects in %s after down, found %s %q", dbPath, typ, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate sqlite_master: %v", err)
	}
}
