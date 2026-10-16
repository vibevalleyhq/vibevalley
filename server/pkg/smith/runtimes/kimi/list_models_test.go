package kimi

// Ported from tests/kimi/kimi-list-models.test.ts. The TS mocks
// startAcpProcess; here a scripted agent answers (scripted_test.go).

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"vibevalley/pkg/smith/oar"
)

// Shape from kimi-code packages/acp-server/src/config-options.ts (f9ca33376).
const newSessionResponse = `{
	"sessionId": "sess-1",
	"configOptions": [
		{"type": "select", "id": "model", "name": "Model", "category": "model", "currentValue": "kimi-for-coding",
		 "options": [
			{"value": "kimi-for-coding", "name": "Kimi For Coding"},
			{"value": "kimi-k2-turbo-preview", "name": "Kimi K2 Turbo"},
			{"value": " ", "name": "blank id is dropped"}]},
		{"type": "select", "id": "thinking", "name": "Thinking", "category": "thought_level", "currentValue": "high",
		 "options": [
			{"value": "off", "name": "Thinking off"},
			{"value": "low", "name": "Thinking low"},
			{"value": "high", "name": "Thinking high"}]},
		{"type": "select", "id": "mode", "name": "Mode", "category": "mode", "currentValue": "default", "options": []}
	],
	"modes": {"currentModeId": "default", "availableModes": []}
}`

// options is the fixture's config options: model, thinking, mode.
func options(t *testing.T) []map[string]any {
	var out []map[string]any
	for _, option := range decode(t, newSessionResponse).(map[string]any)["configOptions"].([]any) {
		out = append(out, option.(map[string]any))
	}
	return out
}

func edited(option map[string]any, key string, value any) map[string]any {
	out := map[string]any{}
	for k, v := range option {
		out[k] = v
	}
	if value == nil {
		delete(out, key)
	} else {
		out[key] = value
	}
	return out
}

const listed = `[
	{"id": "kimi-for-coding", "displayName": "Kimi For Coding", "effortLevels": ["low", "high"], "defaultEffort": "high", "default": true},
	{"id": "kimi-k2-turbo-preview", "displayName": "Kimi K2 Turbo"}]`

func TestProjectionListsTheModelOptionAndAttachesThinkingLevelsToTheCurrentModelOnly(t *testing.T) {
	jsonEqual(t, ProjectModels(decode(t, newSessionResponse)), listed)
}

func TestProjectionTreatsThinkingOffAsNoDefaultAndOmitsLevelsWithoutAThinkingOption(t *testing.T) {
	all := options(t)
	model, thinking := all[0], all[1]
	jsonEqual(t, ProjectModels(map[string]any{"configOptions": []any{model, edited(thinking, "currentValue", "off")}}), `[
		{"id": "kimi-for-coding", "displayName": "Kimi For Coding", "effortLevels": ["low", "high"], "default": true},
		{"id": "kimi-k2-turbo-preview", "displayName": "Kimi K2 Turbo"}]`)
	jsonEqual(t, ProjectModels(map[string]any{"configOptions": []any{model}}), `[
		{"id": "kimi-for-coding", "displayName": "Kimi For Coding", "default": true},
		{"id": "kimi-k2-turbo-preview", "displayName": "Kimi K2 Turbo"}]`)
	if models := ProjectModels(map[string]any{"configOptions": []any{}}); models != nil {
		t.Fatal(models)
	}
	if models := ProjectModels(nil); models != nil {
		t.Fatal(models)
	}
}

// The menu is the option the session applies SessionOptions.Effort through:
// found by ACP's `thought_level` category, not by the `thinking` id, so a
// listed level is always one a session accepts.
func TestProjectionReadsTheEffortMenuOffTheThoughtLevelCategoryWhateverTheOptionsID(t *testing.T) {
	all := options(t)
	model, thinking, mode := all[0], all[1], all[2]
	jsonEqual(t, ProjectModels(map[string]any{"configOptions": []any{model, edited(thinking, "id", "reasoning"), mode}})[0],
		`{"id": "kimi-for-coding", "displayName": "Kimi For Coding", "effortLevels": ["low", "high"], "defaultEffort": "high", "default": true}`)
	jsonEqual(t, ProjectModels(map[string]any{"configOptions": []any{model, edited(thinking, "category", nil), mode}})[0],
		`{"id": "kimi-for-coding", "displayName": "Kimi For Coding", "default": true}`)
}

func TestListerInitializesAuthenticatesWithLoginOpensAndClosesASession(t *testing.T) {
	agent := newScriptedAgent(t, map[string]any{
		"initialize":    result(map[string]any{"authMethods": []any{map[string]any{"id": "login"}}}),
		"authenticate":  result(map[string]any{}),
		"session/new":   result(decode(t, newSessionResponse)),
		"session/close": result(map[string]any{}),
	})
	got, err := ListModels(context.Background(), agent.installation(), oar.ListModelsOptions{})
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, got, `{"kind": "ok", "models": `+listed+`}`)
	equalMethods(t, agent.methods(), "initialize", "authenticate", "session/new", "session/close")
	jsonEqual(t, agent.params(1), map[string]any{"methodId": "login"})
	jsonEqual(t, agent.params(3), map[string]any{"sessionId": "sess-1"})
	if !agent.killed() {
		t.Fatal("the agent outlived the listing")
	}
	jsonEqual(t, agent.starts()[0]["start"], []string{"acp"})
}

func TestListerOpensItsThrowawaySessionInTheRequestedDirectory(t *testing.T) {
	agent := newScriptedAgent(t, map[string]any{"initialize": result(map[string]any{}), "session/new": result(decode(t, newSessionResponse)), "session/close": result(map[string]any{})})
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
	cwd := filepath.Join(host, relative)
	if started := agent.starts()[0]["cwd"]; started != cwd {
		if resolved, _ := filepath.EvalSymlinks(cwd); started != resolved {
			t.Fatalf("cwd %v", started)
		}
	}
	jsonEqual(t, agent.params(1), map[string]any{"cwd": cwd, "mcpServers": []any{}})
}

func TestListerStillReturnsTheListWhenSessionCloseFails(t *testing.T) {
	agent := newScriptedAgent(t, map[string]any{
		"initialize":    result(map[string]any{"authMethods": []any{}}),
		"session/new":   result(decode(t, newSessionResponse)),
		"session/close": rpcError(-32601, "Method not found"),
	})
	got, err := ListModels(context.Background(), agent.installation(), oar.ListModelsOptions{})
	if err != nil || got.Kind != "ok" {
		t.Fatalf("%+v %v", got, err)
	}
	equalMethods(t, agent.methods(), "initialize", "session/new", "session/close")
}

func TestListerMapsASessionNewAuthFailureToUnauthenticated(t *testing.T) {
	agent := newScriptedAgent(t, map[string]any{
		"initialize":   result(map[string]any{"authMethods": []any{map[string]any{"id": "login"}}}),
		"authenticate": rpcError(-32000, "Authentication required"),
		"session/new":  rpcError(-32000, "Authentication required"),
	})
	got, err := ListModels(context.Background(), agent.installation(), oar.ListModelsOptions{})
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, got, map[string]any{"kind": "unauthenticated", "detail": "Authentication required"})
	if !agent.killed() {
		t.Fatal("the agent outlived the listing")
	}
}

func TestListerMapsMethodNotFoundAndAMissingModelOptionToUnsupported(t *testing.T) {
	agent := newScriptedAgent(t, map[string]any{"initialize": result(map[string]any{"authMethods": []any{}})})
	if got, err := ListModels(context.Background(), agent.installation(), oar.ListModelsOptions{}); err != nil || got.Kind != "unsupported" {
		t.Fatalf("%+v %v", got, err)
	}
	agent = newScriptedAgent(t, map[string]any{
		"initialize":  result(map[string]any{"authMethods": []any{}}),
		"session/new": result(map[string]any{"sessionId": "sess-2", "configOptions": []any{}, "modes": map[string]any{}}),
	})
	got, err := ListModels(context.Background(), agent.installation(), oar.ListModelsOptions{})
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, got, map[string]any{"kind": "unsupported", "reason": "this kimi build returns no model config option on session/new"})
}

// TS throws a plain Error from every request; here the agent answers with
// an error that is neither method-not-found nor an auth failure.
func TestListerWrapsUnexpectedFailures(t *testing.T) {
	agent := newScriptedAgent(t, map[string]any{"initialize": rpcError(-32603, "boom")})
	_, err := ListModels(context.Background(), agent.installation(), oar.ListModelsOptions{})
	if err == nil || !strings.Contains(err.Error(), "Failed to list Kimi models") {
		t.Fatalf("%v", err)
	}
	if !agent.killed() {
		t.Fatal("the agent outlived the listing")
	}
}

func equalMethods(t *testing.T, got []string, want ...string) {
	t.Helper()
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("methods %q, want %q", got, want)
	}
}
