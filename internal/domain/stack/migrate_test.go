package stack_test

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"github.com/vibevalleyhq/vibevalley/internal/domain/stack"
	pkgdb "github.com/vibevalleyhq/vibevalley/pkg/db"
)

func TestStackMigrateUpStatusDownUpWALDirectory(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	dir := t.TempDir()
	dbPath := filepath.Join(dir, "platform.db")

	if gotScopes := stack.MigrationScopes(); !slices.Equal(gotScopes, []string{pkgdb.PlatformScope}) {
		t.Fatalf("MigrationScopes() = %v, want [%q]", gotScopes, pkgdb.PlatformScope)
	}

	// Initial MigrateUp applies all 11 versions under the unified "platform" scope.
	upRes, err := stack.MigrateUp(ctx, dbPath)
	if err != nil {
		t.Fatalf("MigrateUp(1): %v", err)
	}
	if len(upRes) != 1 {
		t.Fatalf("expected 1 unified scope result, got %d: %+v", len(upRes), upRes)
	}
	if upRes[0].Scope != pkgdb.PlatformScope || upRes[0].DBPath != dbPath ||
		upRes[0].BeforeVersion != 0 || upRes[0].AfterVersion != 11 ||
		upRes[0].Applied != 11 || upRes[0].Pending != 0 {
		t.Fatalf("unexpected initial MigrateUp result: %+v", upRes[0])
	}
	if _, err := os.Stat(dbPath); err != nil {
		t.Fatalf("expected unified SQLite file at %s: %v", dbPath, err)
	}
	assertZeroSidecarDBFiles(t, dir, "platform")

	// Second MigrateUp is idempotent.
	upAgain, err := stack.MigrateUp(ctx, dbPath)
	if err != nil {
		t.Fatalf("MigrateUp(2): %v", err)
	}
	if len(upAgain) != 1 || upAgain[0].BeforeVersion != 11 || upAgain[0].AfterVersion != 11 ||
		upAgain[0].Applied != 0 || upAgain[0].Pending != 0 {
		t.Fatalf("expected idempotent MigrateUp result, got %+v", upAgain)
	}

	// MigrateStatus shows all 11 platform migrations applied in order.
	statuses, err := stack.MigrateStatus(ctx, dbPath)
	if err != nil {
		t.Fatalf("MigrateStatus after Up: %v", err)
	}
	wantModules := pkgdb.OrderedModules()
	if len(statuses) != len(wantModules) {
		t.Fatalf("expected %d status rows, got %d", len(wantModules), len(statuses))
	}
	for i, st := range statuses {
		if st.Scope != pkgdb.PlatformScope || !st.Applied || st.Version != int64(i+1) || st.Name != wantModules[i] {
			t.Fatalf("status[%d] = %+v, want scope=%q version=%d name=%q applied=true", i, st, pkgdb.PlatformScope, i+1, wantModules[i])
		}
	}

	// MigrateDown(steps=1, all=false) reverts only the latest migration (11 -> 10).
	downStepRes, err := stack.MigrateDown(ctx, dbPath, 1, false)
	if err != nil {
		t.Fatalf("MigrateDown(steps=1): %v", err)
	}
	if len(downStepRes) != 1 || downStepRes[0].Scope != pkgdb.PlatformScope ||
		downStepRes[0].BeforeVersion != 11 || downStepRes[0].AfterVersion != 10 ||
		downStepRes[0].Reverted != 1 || downStepRes[0].Pending != 1 {
		t.Fatalf("unexpected MigrateDown(steps=1) result: %+v", downStepRes)
	}

	statusesAfterStep, err := stack.MigrateStatus(ctx, dbPath)
	if err != nil {
		t.Fatalf("MigrateStatus after Down(steps=1): %v", err)
	}
	if len(statusesAfterStep) != len(wantModules) {
		t.Fatalf("expected %d status rows after step down, got %d", len(wantModules), len(statusesAfterStep))
	}
	for i, st := range statusesAfterStep {
		wantApplied := i < len(wantModules)-1
		if st.Applied != wantApplied {
			t.Fatalf("status[%d] (%s) applied=%t, want %t", i, st.Name, st.Applied, wantApplied)
		}
	}

	// Re-apply step 11, then revert all 11 via MigrateDown(all=true).
	reStepUp, err := stack.MigrateUp(ctx, dbPath)
	if err != nil {
		t.Fatalf("MigrateUp(re-apply 1): %v", err)
	}
	if len(reStepUp) != 1 || reStepUp[0].BeforeVersion != 10 || reStepUp[0].AfterVersion != 11 ||
		reStepUp[0].Applied != 1 || reStepUp[0].Pending != 0 {
		t.Fatalf("unexpected MigrateUp(re-apply 1) result: %+v", reStepUp)
	}

	downAllRes, err := stack.MigrateDown(ctx, dbPath, 0, true)
	if err != nil {
		t.Fatalf("MigrateDown(all=true): %v", err)
	}
	if len(downAllRes) != 1 || downAllRes[0].Scope != pkgdb.PlatformScope ||
		downAllRes[0].BeforeVersion != 11 || downAllRes[0].AfterVersion != 0 ||
		downAllRes[0].Reverted != 11 || downAllRes[0].Pending != 11 {
		t.Fatalf("unexpected MigrateDown(all=true) result: %+v", downAllRes)
	}
	assertNoUserTablesOrTriggers(t, ctx, dbPath)

	statusesAfterDownAll, err := stack.MigrateStatus(ctx, dbPath)
	if err != nil {
		t.Fatalf("MigrateStatus after Down(all=true): %v", err)
	}
	for _, st := range statusesAfterDownAll {
		if st.Applied {
			t.Fatalf("expected unapplied status after Down(all=true), got %+v", st)
		}
	}

	// Re-apply all 11 and boot stack.New against the pre-migrated unified DB.
	reUpRes, err := stack.MigrateUp(ctx, dbPath)
	if err != nil {
		t.Fatalf("MigrateUp(re-apply 2): %v", err)
	}
	if len(reUpRes) != 1 || reUpRes[0].Applied != 11 || reUpRes[0].AfterVersion != 11 || reUpRes[0].Pending != 0 {
		t.Fatalf("unexpected re-Up result: %+v", reUpRes)
	}

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
	assertZeroSidecarDBFiles(t, dir, "platform")
}

func TestStackMigrateMemorySharedDBAndValidation(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	if _, err := stack.MigrateDown(ctx, ":memory:", -1, false); err == nil {
		t.Fatal("expected error for negative steps when all=false")
	}
	if _, err := stack.MigrateUpDB(ctx, nil, "nil"); err == nil {
		t.Fatal("expected error for nil sql.DB in MigrateUpDB")
	}
	if _, err := stack.MigrateDownDB(ctx, nil, "nil", 1, false); err == nil {
		t.Fatal("expected error for nil sql.DB in MigrateDownDB")
	}
	if _, err := stack.MigrateStatusDB(ctx, nil); err == nil {
		t.Fatal("expected error for nil sql.DB in MigrateStatusDB")
	}

	memUp, err := stack.MigrateUp(ctx, ":memory:")
	if err != nil {
		t.Fatalf("MigrateUp(:memory:): %v", err)
	}
	if len(memUp) != 1 || memUp[0].Scope != pkgdb.PlatformScope || memUp[0].Applied != 11 || memUp[0].AfterVersion != 11 {
		t.Fatalf("unexpected :memory: MigrateUp result: %+v", memUp)
	}

	dir := t.TempDir()
	sharedPath := filepath.Join(dir, "shared.db")
	pool, err := pkgdb.OpenPool(ctx, sharedPath)
	if err != nil {
		t.Fatalf("OpenPool shared db: %v", err)
	}
	defer func() { _ = pool.Close() }()

	sharedUp, err := stack.MigrateUpDB(ctx, pool.WriteDB, sharedPath)
	if err != nil || len(sharedUp) != 1 || sharedUp[0].Applied != 11 || sharedUp[0].AfterVersion != 11 {
		t.Fatalf("MigrateUpDB: res=%+v err=%v", sharedUp, err)
	}
	statuses, err := stack.MigrateStatusDB(ctx, pool.WriteDB)
	if err != nil || len(statuses) != 11 {
		t.Fatalf("MigrateStatusDB: len=%d err=%v", len(statuses), err)
	}
	for _, st := range statuses {
		if st.Scope != pkgdb.PlatformScope || !st.Applied {
			t.Fatalf("expected all 11 platform migrations applied in shared DB, got %+v", st)
		}
	}
	sharedStepDown, err := stack.MigrateDownDB(ctx, pool.WriteDB, sharedPath, 1, false)
	if err != nil || len(sharedStepDown) != 1 || sharedStepDown[0].Reverted != 1 || sharedStepDown[0].AfterVersion != 10 {
		t.Fatalf("MigrateDownDB(steps=1): res=%+v err=%v", sharedStepDown, err)
	}
	sharedDownAll, err := stack.MigrateDownDB(ctx, pool.WriteDB, sharedPath, 0, true)
	if err != nil || len(sharedDownAll) != 1 || sharedDownAll[0].Reverted != 10 || sharedDownAll[0].AfterVersion != 0 {
		t.Fatalf("MigrateDownDB(all=true): res=%+v err=%v", sharedDownAll, err)
	}
	reUp, err := stack.MigrateUpDB(ctx, pool.WriteDB, sharedPath)
	if err != nil || len(reUp) != 1 || reUp[0].Applied != 11 || reUp[0].AfterVersion != 11 {
		t.Fatalf("MigrateUpDB re-apply: res=%+v err=%v", reUp, err)
	}
	assertZeroSidecarDBFiles(t, dir, "shared")
}

func assertZeroSidecarDBFiles(t *testing.T, dir, baseStem string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir %s: %v", dir, err)
	}
	prefix := baseStem + "."
	allowed := map[string]bool{
		baseStem + ".db":     true,
		baseStem + ".db-wal": true,
		baseStem + ".db-shm": true,
	}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, prefix) && !allowed[name] {
			t.Fatalf("unexpected sidecar database file %q in %s", name, dir)
		}
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
