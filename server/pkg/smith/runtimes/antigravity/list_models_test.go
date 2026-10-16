package antigravity

// Ported from tests/antigravity/antigravity-list-models.test.ts. The TS
// mocks startAcpProcess; here a scripted agent answers (scripted_test.go).

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"vibevalley/pkg/smith/oar"
)

// Trimmed from a live agy_acp_server 1.2.1 `session/new` answer: effort is
// part of the model id and there is no thought_level option.
var newSessionResponse = json.RawMessage(`{
	"sessionId": "sess-1",
	"configOptions": [
		{"type": "select", "id": "model", "name": "Model", "category": "model", "currentValue": "gemini-3.8-flash-high",
		 "options": [
			{"value": "gemini-3.8-flash-high", "name": "Gemini 3.8 Flash (High)"},
			{"value": "gemini-3.8-flash-low", "name": "Gemini 3.8 Flash (Low)"},
			{"value": "gemini-pro-agent", "name": "Gemini 3.1 Pro (High)"}]},
		{"type": "select", "id": "mode", "name": "Mode", "currentValue": "default",
		 "options": [{"value": "default", "name": "Default"}, {"value": "yolo", "name": "YOLO"}]}
	]
}`)

func decoded(t *testing.T, raw json.RawMessage) any {
	t.Helper()
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestProjectionListsTheModelOptionWithNoEffortLevels(t *testing.T) {
	jsonEqual(t, ProjectModels(decoded(t, newSessionResponse)), json.RawMessage(`[
		{"id": "gemini-3.8-flash-high", "displayName": "Gemini 3.8 Flash (High)", "default": true},
		{"id": "gemini-3.8-flash-low", "displayName": "Gemini 3.8 Flash (Low)"},
		{"id": "gemini-pro-agent", "displayName": "Gemini 3.1 Pro (High)"}]`))
	if models := ProjectModels(map[string]any{"configOptions": []any{}}); models != nil {
		t.Fatalf("%v", models)
	}
	if models := ProjectModels(nil); models != nil {
		t.Fatalf("%v", models)
	}
}

func TestListerInitializesAndOpensASessionThenKillsTheProcessWithoutClose(t *testing.T) {
	agent := newScriptedAgent(t, map[string]any{
		"initialize":  result(map[string]any{"authMethods": []any{}}),
		"session/new": result(decoded(t, newSessionResponse)),
	})
	listed, err := ListModels(context.Background(), agent.installation(), oar.ListModelsOptions{})
	if err != nil || listed.Kind != "ok" {
		t.Fatalf("%+v %v", listed, err)
	}
	equalMethods(t, agent.methods(), "initialize", "session/new")
	if !agent.killed() {
		t.Fatal("the agent outlived the listing")
	}
	cwd, _ := os.Getwd()
	jsonEqual(t, agent.params(1), map[string]any{"cwd": cwd, "mcpServers": []any{}})
}

func TestListerOpensItsThrowawaySessionInTheRequestedDirectory(t *testing.T) {
	agent := newScriptedAgent(t, map[string]any{"initialize": result(map[string]any{}), "session/new": result(decoded(t, newSessionResponse))})
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
	starts := agent.starts()
	if resolved, _ := filepath.EvalSymlinks(workspace); starts[len(starts)-1]["cwd"] != resolved && starts[len(starts)-1]["cwd"] != workspace {
		t.Fatalf("cwd %v", starts[len(starts)-1]["cwd"])
	}
	jsonEqual(t, agent.params(1), map[string]any{"cwd": filepath.Join(host, relative), "mcpServers": []any{}})
}

func TestListerMapsAuthFailuresAMissingModelOptionAndOtherFailures(t *testing.T) {
	agent := newScriptedAgent(t, map[string]any{"initialize": result(map[string]any{}), "session/new": rpcError(-32000, "Authentication required")})
	listed, err := ListModels(context.Background(), agent.installation(), oar.ListModelsOptions{})
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, listed, map[string]any{"kind": "unauthenticated", "detail": "Authentication required"})

	agent = newScriptedAgent(t, map[string]any{"initialize": result(map[string]any{}), "session/new": result(map[string]any{"sessionId": "sess-2"})})
	if listed, err := ListModels(context.Background(), agent.installation(), oar.ListModelsOptions{}); err != nil || listed.Kind != "unsupported" {
		t.Fatalf("%+v %v", listed, err)
	}
	if listed, err := ListModels(context.Background(), oar.AvailableInstallation{Via: "bundled"}, oar.ListModelsOptions{}); err != nil || listed.Kind != "unsupported" {
		t.Fatalf("%+v %v", listed, err)
	}

	// TS throws a plain Error from every request; an agent answers with an error that is no auth failure.
	agent = newScriptedAgent(t, map[string]any{"initialize": rpcError(-32603, "boom")})
	_, err = ListModels(context.Background(), agent.installation(), oar.ListModelsOptions{})
	if err == nil || !strings.Contains(err.Error(), "Failed to list Antigravity models") {
		t.Fatalf("%v", err)
	}
}

func equalMethods(t *testing.T, got []string, want ...string) {
	t.Helper()
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("methods %q, want %q", got, want)
	}
}
