package claude

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// Ports tests/claude-list-models.test.ts and the claude cases of tests/list-models.test.ts.

var listInstallation = oar.AvailableInstallation{Via: "executable", Command: "claude", Version: "2.1.237"}

func requestIDOf(t *testing.T, text string) string {
	id, ok := jsonx.ParseRecord([]byte(strings.TrimSpace(text)))["request_id"].(string)
	if !ok {
		t.Error("control_request without request_id")
	}
	return id
}

func TestListerAnswersFromTheMatchingControlResponseOnly(t *testing.T) {
	fake := newFakeProcess(func(text string, self *fakeProcess) {
		requestID := requestIDOf(t, text)
		self.emitJSON(map[string]any{"type": "system", "subtype": "init"})
		self.emitJSON(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": "someone-else", "response": map[string]any{"models": []any{map[string]any{"value": "wrong"}}}}})
		self.emitJSON(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": requestID,
			"response": map[string]any{"models": []any{map[string]any{"value": "sonnet", "resolvedModel": "claude-sonnet-5", "supportedEffortLevels": []any{"low"}}}}}})
	})
	spawner := useFakeSpawner(t, fake)
	result, err := ListModels(testContext(t), listInstallation, oar.ListModelsOptions{})
	if err != nil {
		t.Fatal(err)
	}
	assertJSON(t, result, `{"kind":"ok","models":[{"id":"sonnet","resolvedId":"claude-sonnet-5","effortLevels":["low"]}]}`)
	request := fake.writtenRecords()[0]
	if request["type"] != "control_request" || jsonx.AsRecord(request["request"])["subtype"] != "list_models" {
		t.Fatalf("request = %v", request)
	}
	if !fake.killed() {
		t.Fatal("not killed")
	}
	call := spawner.call(0)
	if !reflect.DeepEqual(call.args, []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"}) {
		t.Fatalf("args = %v", call.args)
	}
	if _, set := envOf(call.options.Env, "CLAUDECODE"); set {
		t.Fatal("CLAUDECODE reached the lister")
	}
	cwd, _ := os.Getwd()
	if call.options.Dir != cwd || !call.options.KillTree {
		t.Fatalf("options = %+v", call.options)
	}
}

// Project settings can change what claude lists, so claude starts where a session would.
func TestListerStartsClaudeInTheRequestedDirectory(t *testing.T) {
	spawner := useFakeSpawner(t, newFakeProcess(func(text string, self *fakeProcess) {
		self.emitJSON(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": requestIDOf(t, text), "response": map[string]any{"models": []any{}}}})
	}))
	result, err := ListModels(testContext(t), listInstallation, oar.ListModelsOptions{Cwd: "workspace"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Kind != "ok" || len(result.Models) != 0 {
		t.Fatalf("result = %+v", result)
	}
	want, _ := filepath.Abs("workspace")
	if spawner.call(0).options.Dir != want {
		t.Fatalf("dir = %s", spawner.call(0).options.Dir)
	}
}

func TestListerMapsALoginErrorToUnauthenticated(t *testing.T) {
	useFakeSpawner(t, newFakeProcess(func(text string, self *fakeProcess) {
		self.emitJSON(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "error", "request_id": requestIDOf(t, text), "error": "Not logged in. Please run /login"}})
	}))
	result, err := ListModels(testContext(t), listInstallation, oar.ListModelsOptions{})
	if err != nil {
		t.Fatal(err)
	}
	assertJSON(t, result, `{"kind":"unauthenticated","detail":"Not logged in. Please run /login"}`)
}

func TestListerFailsWhenTheProcessExitsBeforeAnswering(t *testing.T) {
	useFakeSpawner(t, newFakeProcess(func(_ string, self *fakeProcess) {
		self.emit("garbage\n")
		self.end(intPtr(1))
	}))
	_, err := ListModels(testContext(t), listInstallation, oar.ListModelsOptions{})
	if err == nil || !regexp.MustCompile(`exited before answering`).MatchString(err.Error()) {
		t.Fatalf("err = %v", err)
	}
}

func TestListerKillsTheProcessOnTimeout(t *testing.T) {
	fake := newFakeProcess(nil)
	useFakeSpawner(t, fake)
	_, err := ListModels(testContext(t), listInstallation, oar.ListModelsOptions{Timeout: 20 * time.Millisecond})
	if err == nil || !regexp.MustCompile(`exited before answering`).MatchString(err.Error()) {
		t.Fatalf("err = %v", err)
	}
	if !fake.killed() {
		t.Fatal("not killed")
	}
}

// tests/list-models.test.ts

func TestProjectionKeepsAliasVsResolutionFastSupportAndDisabledReasons(t *testing.T) {
	models := ProjectClaudeModels(map[string]any{"models": []any{
		map[string]any{"value": "sonnet", "resolvedModel": "claude-sonnet-5", "displayName": "Sonnet", "supportsEffort": true, "supportedEffortLevels": []any{"low", "high"}},
		map[string]any{"value": "haiku", "resolvedModel": "claude-haiku-4-5-20251001", "supportedEffortLevels": nil},
		map[string]any{"value": "cc-update-required-1", "displayName": "Fable 5.1", "description": "Update to 2.1.255+ to use Fable 5.1", "disabled": true},
		map[string]any{"value": "opus", "supportsFastMode": true},
		map[string]any{"value": "", "displayName": "dropped"},
	}})
	assertJSON(t, models, `[
		{"id":"sonnet","resolvedId":"claude-sonnet-5","displayName":"Sonnet","effortLevels":["low","high"]},
		{"id":"haiku","resolvedId":"claude-haiku-4-5-20251001"},
		{"id":"cc-update-required-1","displayName":"Fable 5.1","disabled":{"reason":"Update to 2.1.255+ to use Fable 5.1"}},
		{"id":"opus","serviceTiers":["fast"]}]`)
}

// #347: claude's "Default (recommended)" entry is not what an unset session
// runs when settings pick a model, so claude marks no default.
func TestProjectionMarksNoDefault(t *testing.T) {
	assertJSON(t, ProjectClaudeModels(map[string]any{"models": []any{
		map[string]any{"value": "default", "resolvedModel": "claude-opus-5-5", "displayName": "Default (recommended)"},
		map[string]any{"value": "opus", "resolvedModel": "claude-opus-5-5", "displayName": "Opus 5.5"},
	}}), `[{"id":"default","resolvedId":"claude-opus-5-5","displayName":"Default (recommended)"},{"id":"opus","resolvedId":"claude-opus-5-5","displayName":"Opus 5.5"}]`)
}

func TestListerRefusesBundledInstallations(t *testing.T) {
	result, err := ListModels(testContext(t), oar.AvailableInstallation{Via: "bundled", Version: "1"}, oar.ListModelsOptions{})
	if err != nil || result.Kind != "unsupported" {
		t.Fatalf("result = %+v %v", result, err)
	}
}

func TestRuntimeExposesListModels(t *testing.T) {
	if Runtime().ListModels == nil {
		t.Fatal("claude has no listModels")
	}
}
