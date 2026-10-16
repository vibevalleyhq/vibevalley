package grok

// Ported from tests/grok/grok-list-models.test.ts. The TS mocks
// startAcpProcess; here a scripted agent answers (scripted_test.go).

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"vibevalley/pkg/smith/oar"
)

func TestListerInitializesAuthenticatesWithTheCachedTokenThenLists(t *testing.T) {
	agent := newScriptedAgent(t, map[string]any{
		"initialize":   result(map[string]any{"authMethods": []any{map[string]any{"id": "cached_token"}}}),
		"authenticate": result(map[string]any{}),
		"_x.ai/models/list": result(map[string]any{"result": map[string]any{
			"currentModelId":  "grok-4",
			"availableModels": []any{map[string]any{"modelId": "grok-4", "name": "Grok 4", "reasoning_efforts": []any{"low", "high"}}},
		}}),
	})
	listed, err := ListModels(context.Background(), agent.installation(), oar.ListModelsOptions{})
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, listed, map[string]any{"kind": "ok", "models": []any{map[string]any{"id": "grok-4", "displayName": "Grok 4", "effortLevels": []any{"low", "high"}, "default": true}}})
	equalMethods(t, agent.methods(), "initialize", "authenticate", "_x.ai/models/list")
	if !agent.killed() {
		t.Fatal("the agent outlived the listing")
	}
	jsonEqual(t, agent.starts()[0]["start"], agentArgs)
}

func TestListerStartsGrokInTheRequestedDirectoryAsASessionThereWould(t *testing.T) {
	agent := newScriptedAgent(t, map[string]any{"initialize": result(map[string]any{}), "_x.ai/models/list": result(map[string]any{"result": map[string]any{"availableModels": []any{}}})})
	// TS lists in a relative "workspace" with the spawn mocked; a real agent needs the directory to exist.
	workspace := t.TempDir()
	host, _ := os.Getwd()
	relative, err := filepath.Rel(host, workspace)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ListModels(context.Background(), agent.installation(), oar.ListModelsOptions{Cwd: relative}); err != nil {
		t.Fatal(err)
	}
	cwd := agent.starts()[0]["cwd"]
	if resolved, _ := filepath.EvalSymlinks(workspace); cwd != resolved && cwd != workspace {
		t.Fatalf("cwd %v", cwd)
	}
}

func TestListerMapsMethodNotFoundToUnsupported(t *testing.T) {
	agent := newScriptedAgent(t, map[string]any{"initialize": result(map[string]any{"authMethods": []any{}})})
	listed, err := ListModels(context.Background(), agent.installation(), oar.ListModelsOptions{})
	if err != nil || listed.Kind != "unsupported" {
		t.Fatalf("%+v %v", listed, err)
	}
}

func TestListerMapsAnAuthFailureToUnauthenticated(t *testing.T) {
	agent := newScriptedAgent(t, map[string]any{"initialize": result(map[string]any{"authMethods": []any{}}), "_x.ai/models/list": rpcError(-32000, "Authentication required")})
	listed, err := ListModels(context.Background(), agent.installation(), oar.ListModelsOptions{})
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, listed, map[string]any{"kind": "unauthenticated", "detail": "Authentication required"})
}

func TestListerSurfacesAHandlerLevelErrorAsAFailure(t *testing.T) {
	agent := newScriptedAgent(t, map[string]any{"initialize": result(map[string]any{"authMethods": []any{}}), "_x.ai/models/list": result(map[string]any{"error": map[string]any{"message": "catalog fetch failed"}})})
	_, err := ListModels(context.Background(), agent.installation(), oar.ListModelsOptions{})
	if err == nil || !strings.Contains(err.Error(), "Failed to list Grok models") {
		t.Fatalf("%v", err)
	}
	if !agent.killed() {
		t.Fatal("the agent outlived the listing")
	}
}

// grok 1.0.41 (live 2026-09-29) moved the effort menu under each entry's
// `_meta`, as `{id, value, label, description, default}` objects; before the
// lister read it there, every grok model listed without effort levels.
func grokEfforts(ids ...string) []any {
	out := []any{}
	for _, id := range ids {
		out = append(out, map[string]any{"id": id, "value": id, "label": id, "description": "", "default": id == "high"})
	}
	return out
}

func TestProjectionReadsTheEffortMenuGrok1041CarriesUnderMeta(t *testing.T) {
	frontier := grokEfforts("xhigh", "high", "medium", "low")
	older := grokEfforts("high", "medium", "low")
	state, err := ModelState(map[string]any{
		"currentModelId": "grok-4.7",
		"availableModels": []any{
			map[string]any{"modelId": "grok-4.7", "name": "Grok 4.7", "_meta": map[string]any{"totalContextTokens": 500000, "supportsReasoningEffort": true, "reasoningEffort": "high", "reasoningEfforts": frontier}},
			map[string]any{"modelId": "grok-4.5", "name": "Grok 4.5", "_meta": map[string]any{"supportsReasoningEffort": true, "reasoningEffort": "high", "reasoningEfforts": older}},
			map[string]any{"modelId": "grok-plain", "name": "Plain", "_meta": map[string]any{"supportsReasoningEffort": false, "reasoningEffort": "high", "reasoningEfforts": older}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, ProjectModels(state), []any{
		map[string]any{"id": "grok-4.7", "displayName": "Grok 4.7", "effortLevels": []any{"xhigh", "high", "medium", "low"}, "defaultEffort": "high", "default": true},
		map[string]any{"id": "grok-4.5", "displayName": "Grok 4.5", "effortLevels": []any{"high", "medium", "low"}, "defaultEffort": "high"},
		map[string]any{"id": "grok-plain", "displayName": "Plain"},
	})
}
