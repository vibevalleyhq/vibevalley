package agent_test

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"testing"

	"github.com/vibevalleyhq/vibevalley/internal/domain/agent"
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
