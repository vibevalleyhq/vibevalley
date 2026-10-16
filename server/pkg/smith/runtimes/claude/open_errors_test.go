//go:build wip_a

package claude

import (
	"fmt"
	"strings"
	"testing"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// Ports tests/claude/claude-open-errors.test.ts.
//
// Not ported: the assertions on the error's structured cause ({method,
// native} with the native error redacted). Go open errors carry their
// diagnostics as text only (smith/GAPS.md, "Errors are strings"); what
// remains is that the open fails, no secret reaches the error, and claude is
// stopped.

const openErrorSecret = "claude-open-error-env-sentinel"

func TestOpenPreservesNoSecretOfANativeErrorResponse(t *testing.T) {
	for _, method := range []string{"get_settings", "initialize"} {
		t.Run(method, func(t *testing.T) {
			fake := newFakeProcess(func(text string, child *fakeProcess) {
				request := jsonx.ParseRecord([]byte(text))
				child.emitJSON(map[string]any{"type": "control_response", "response": map[string]any{
					"request_id": request["request_id"], "subtype": "error", "error": "refused " + openErrorSecret, "errors": []any{map[string]any{"detail": openErrorSecret}},
				}})
			})
			useFakeSpawner(t, fake)
			options := oar.SessionOptions{Cwd: ".", MCPServers: []oar.McpServer{{Name: "echo", Command: "echo", Env: map[string]string{"TOKEN": openErrorSecret}}}}
			if method == "get_settings" {
				options.Effort = "low"
			} else {
				options.ServiceTier = "fast"
			}
			_, err := Session(testContext(t), oar.AvailableInstallation{Via: "executable", Command: "claude"}, options)
			if err == nil {
				t.Fatal("the open succeeded")
			}
			if strings.Contains(fmt.Sprintf("%+v %#v", err, err), openErrorSecret) {
				t.Fatalf("the error carries the secret: %v", err)
			}
			if !fake.killed() {
				t.Fatal("claude was not stopped")
			}
		})
	}
}

func TestASuccessfulGetSettingsMismatchNeverExposesTheMergedSettings(t *testing.T) {
	fake := newFakeProcess(func(text string, child *fakeProcess) {
		request := jsonx.ParseRecord([]byte(text))
		child.emitJSON(map[string]any{"type": "control_response", "response": map[string]any{
			"request_id": request["request_id"], "subtype": "success", "response": map[string]any{
				"effective": map[string]any{"env": map[string]any{"SECRET": openErrorSecret}}, "sources": []any{map[string]any{"secret": openErrorSecret}}, "applied": map[string]any{"effort": "high"},
			},
		}})
	})
	useFakeSpawner(t, fake)
	_, err := Session(testContext(t), oar.AvailableInstallation{Via: "executable", Command: "claude"}, oar.SessionOptions{Cwd: ".", Effort: "low"})
	if err == nil {
		t.Fatal("the open succeeded")
	}
	if strings.Contains(fmt.Sprintf("%+v %#v", err, err), openErrorSecret) {
		t.Fatalf("the error carries the settings: %v", err)
	}
	if !fake.killed() {
		t.Fatal("claude was not stopped")
	}
}
