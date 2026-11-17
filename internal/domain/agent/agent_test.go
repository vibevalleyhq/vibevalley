package agent_test

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"slices"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/vibevalleyhq/vibevalley/internal/domain/agent"
	"github.com/vibevalleyhq/vibevalley/pkg/db"
	"github.com/vibevalleyhq/vibevalley/pkg/migrate"
)

func TestAgentRegistryProfilesSkillsPresetsAndPersistence(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "agent.db")

	reg, err := agent.OpenSQLiteRegistry(ctx, dbPath)
	if err != nil {
		t.Fatal(err)
	}

	// Default orchestrator & built-in skills + 10 presets must be seeded.
	orch, err := reg.GetProfile(ctx, "orchestrator")
	if err != nil || orch.Role != agent.RoleOrchestrator || orch.Runtime != "vibevalley" {
		t.Fatalf("unexpected orchestrator profile: %+v err=%v", orch, err)
	}
	if err := reg.DeleteProfile(ctx, "orchestrator"); !errors.Is(err, agent.ErrProtectedOrchestrator) {
		t.Fatalf("expected ErrProtectedOrchestrator, got %v", err)
	}

	presets := agent.ListPresets()
	if len(presets) != 10 {
		t.Fatalf("expected 10 runtime presets, got %d", len(presets))
	}

	// Built-in skills are read-only.
	if _, err := reg.SaveSkill(ctx, agent.Skill{ID: "slides", Name: "Hack", Content: "x"}); !errors.Is(err, agent.ErrBuiltInReadOnly) {
		t.Fatalf("expected ErrBuiltInReadOnly on overwrite, got %v", err)
	}
	if err := reg.DeleteSkill(ctx, "reviewer"); !errors.Is(err, agent.ErrBuiltInReadOnly) {
		t.Fatalf("expected ErrBuiltInReadOnly on delete, got %v", err)
	}

	// Save custom skill and attach to worker profile.
	if _, err := reg.SaveSkill(ctx, agent.Skill{ID: "go-tests", Name: "Go Tests", Content: "Always run -race"}); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.SaveProfile(ctx, agent.Profile{
		ID:              "backend-zhou",
		Name:            "Backend Zhou",
		Role:            agent.RoleWorker,
		Tags:            []string{"go", "sqlite", "server"},
		Runtime:         "pi",
		Skills:          []string{"reviewer", "go-tests"},
		DisallowedTools: []string{"rm"},
		UseWorktree:     true,
	}); err != nil {
		t.Fatal(err)
	}

	// MountFilesForProfile materializes both built-in and custom skills.
	mounts, err := reg.MountFilesForProfile(ctx, "backend-zhou")
	if err != nil || len(mounts) != 2 || !mounts[0].ReadOnly {
		t.Fatalf("unexpected mount files: %+v err=%v", mounts, err)
	}

	// Deleting custom skill strips its ID from backend-zhou atomically.
	if err := reg.DeleteSkill(ctx, "go-tests"); err != nil {
		t.Fatal(err)
	}
	profAfterDel, err := reg.GetProfile(ctx, "backend-zhou")
	if err != nil || !slices.Equal(profAfterDel.Skills, []string{"reviewer"}) {
		t.Fatalf("expected go-tests stripped from profile skills, got %+v err=%v", profAfterDel, err)
	}

	// Check ResolveOptions against refused options (e.g. kimi refuses disallowedTools & systemPrompt).
	_, _ = reg.SetRuntimeInfo(ctx, agent.RuntimeInfo{
		ID:        "kimi",
		Installed: true,
		Settings:  agent.RuntimeSettings{Enabled: true},
		Support:   agent.SupportOf("kimi"),
		Models:    []agent.ModelInfo{{ID: "k2", Name: "K2", IsDefault: true, EffortLevels: []string{"low", "high"}}},
	})
	_, _ = reg.SaveProfile(ctx, agent.Profile{
		ID:              "kimi-worker",
		Name:            "Kimi Worker",
		Role:            agent.RoleWorker,
		Runtime:         "kimi",
		Model:           "missing-model",
		Effort:          "ultra",
		Persona:         "custom system",
		PersonaMode:     agent.PersonaReplace,
		DisallowedTools: []string{"bash"},
	})
	resolved, err := reg.ResolveOptions(ctx, "kimi-worker")
	if err != nil {
		t.Fatal(err)
	}
	if resolved.MissingModel != "missing-model" || len(resolved.Problems) < 3 {
		t.Fatalf("expected model fallback + refused option problems, got %+v", resolved)
	}

	// Tag-based ChooseWorker selection.
	chosen, ok := reg.ChooseWorker(ctx, "fix sqlite race in server", "", "")
	if !ok || chosen.ID != "backend-zhou" {
		t.Fatalf("expected backend-zhou chosen by tags, got %+v ok=%v", chosen, ok)
	}

	// Reopen SQLite and verify durability.
	_ = reg.Close()
	reg2, err := agent.OpenSQLiteRegistry(ctx, dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer reg2.Close()

	reopened, err := reg2.GetProfile(ctx, "backend-zhou")
	if err != nil || reopened.Name != "Backend Zhou" || !slices.Equal(reopened.Skills, []string{"reviewer"}) {
		t.Fatalf("reopened profile mismatch: %+v err=%v", reopened, err)
	}
}

func TestAgentMigrationsUpStatusDownAllUp(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "agent-mig.db")
	sqlDB, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	defer sqlDB.Close()

	scopeFS, err := db.ScopeFS("agent")
	if err != nil {
		t.Fatalf("ScopeFS(agent): %v", err)
	}
	runner, err := migrate.New(sqlDB, "agent", scopeFS)
	if err != nil {
		t.Fatalf("migrate.New: %v", err)
	}

	applied, err := runner.Up(ctx)
	if err != nil || applied != 1 {
		t.Fatalf("Up: applied=%d err=%v", applied, err)
	}
	statuses, err := runner.Status(ctx)
	if err != nil || len(statuses) != 1 || !statuses[0].Applied || statuses[0].Scope != "agent" || statuses[0].Version != 1 {
		t.Fatalf("Status after Up: %+v err=%v", statuses, err)
	}
	for _, tbl := range []string{"agent_profile", "agent_skill", "agent_runtime"} {
		var name string
		if err := sqlDB.QueryRowContext(ctx, `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, tbl).Scan(&name); err != nil {
			t.Fatalf("expected table %s after Up: %v", tbl, err)
		}
	}

	reverted, err := runner.DownAll(ctx)
	if err != nil || reverted != 1 {
		t.Fatalf("DownAll: reverted=%d err=%v", reverted, err)
	}
	statusesAfterDown, err := runner.Status(ctx)
	if err != nil || len(statusesAfterDown) != 1 || statusesAfterDown[0].Applied {
		t.Fatalf("Status after DownAll: %+v err=%v", statusesAfterDown, err)
	}
	var remaining int
	if err := sqlDB.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'agent_%'`).Scan(&remaining); err != nil {
		t.Fatalf("count remaining agent_* tables: %v", err)
	}
	if remaining != 0 {
		t.Fatalf("expected 0 agent_* tables after DownAll, found %d", remaining)
	}

	reapplied, err := runner.Up(ctx)
	if err != nil || reapplied != 1 {
		t.Fatalf("re-Up: applied=%d err=%v", reapplied, err)
	}
	_ = sqlDB.Close()

	reg, err := agent.OpenSQLiteRegistry(ctx, dbPath)
	if err != nil {
		t.Fatalf("OpenSQLiteRegistry after re-Up: %v", err)
	}
	defer reg.Close()
	if _, err := reg.SaveProfile(ctx, agent.Profile{ID: "worker-1", Name: "Worker 1", Role: agent.RoleWorker}); err != nil {
		t.Fatalf("SaveProfile after re-Up: %v", err)
	}
	got, err := reg.GetProfile(ctx, "worker-1")
	if err != nil || got.Name != "Worker 1" {
		t.Fatalf("GetProfile after re-Up: %+v err=%v", got, err)
	}
}

func TestOpenSQLiteRegistryFromDBNonOwning(t *testing.T) {
	ctx := context.Background()
	pool, err := db.OpenPool(ctx, filepath.Join(t.TempDir(), "shared.db"))
	if err != nil {
		t.Fatalf("OpenPool: %v", err)
	}
	defer pool.Close()

	runner, err := migrate.New(pool.WriteDB, db.PlatformScope, db.MigrationsFS)
	if err != nil {
		t.Fatalf("migrate.New: %v", err)
	}
	if _, err := runner.Up(ctx); err != nil {
		t.Fatalf("Up: %v", err)
	}

	reg, err := agent.OpenSQLiteRegistryFromDB(ctx, pool.WriteDB)
	if err != nil {
		t.Fatalf("OpenSQLiteRegistryFromDB: %v", err)
	}
	if _, err := reg.SaveProfile(ctx, agent.Profile{ID: "shared-worker", Name: "Shared Worker", Role: agent.RoleWorker}); err != nil {
		t.Fatalf("SaveProfile: %v", err)
	}
	if err := reg.Close(); err != nil {
		t.Fatalf("reg.Close: %v", err)
	}
	if err := pool.WriteDB.PingContext(ctx); err != nil {
		t.Fatalf("shared WriteDB closed by Registry.Close: %v", err)
	}

	reg2, err := agent.OpenSQLiteRegistryFromDB(ctx, pool.WriteDB)
	if err != nil {
		t.Fatalf("reattach OpenSQLiteRegistryFromDB: %v", err)
	}
	defer reg2.Close()
	got, err := reg2.GetProfile(ctx, "shared-worker")
	if err != nil || got.Name != "Shared Worker" {
		t.Fatalf("reattached GetProfile: %+v err=%v", got, err)
	}
}
