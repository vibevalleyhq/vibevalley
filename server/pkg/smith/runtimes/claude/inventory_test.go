package claude

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// Ports the claude cases of tests/inventory.test.ts.

var inventoryInstallation = oar.AvailableInstallation{Via: "executable", Command: "fake"}

// controlServer answers each control request with serve(subtype), after an
// unrelated response that must not settle the current request.
func controlServer(serve func(method string) any) *fakeProcess {
	return newFakeProcess(func(text string, self *fakeProcess) {
		request := jsonx.ParseRecord([]byte(strings.TrimSpace(text)))
		response := serve(jsonString(jsonx.AsRecord(request["request"])["subtype"]))
		self.emitJSON(map[string]any{"type": "control_response", "response": map[string]any{"request_id": "other", "subtype": "success", "response": map[string]any{}}})
		self.emitJSON(map[string]any{"type": "control_response", "response": map[string]any{"request_id": request["request_id"], "subtype": "success", "response": response}})
	})
}

func jsonString(value any) string {
	text, _ := value.(string)
	return text
}

// settlement watches a read in the background.
type settlement[T any] struct {
	done   chan struct{}
	result T
	err    error
}

func observeSettlement[T any](read func() (T, error)) *settlement[T] {
	s := &settlement[T]{done: make(chan struct{})}
	go func() {
		s.result, s.err = read()
		close(s.done)
	}()
	return s
}

func (s *settlement[T]) settled() bool {
	select {
	case <-s.done:
		return true
	default:
		return false
	}
}

func (s *settlement[T]) wait(t *testing.T) T {
	t.Helper()
	select {
	case <-s.done:
	case <-time.After(10 * time.Second):
		t.Fatal("the read never settled")
	}
	if s.err != nil {
		t.Fatal(s.err)
	}
	return s.result
}

func TestSkillsAreContextEntriesNeverInitializeCommandAliases(t *testing.T) {
	fake := controlServer(func(method string) any {
		if method == "initialize" {
			return map[string]any{"commands": []any{map[string]any{"name": "not-a-skill"}}}
		}
		return map[string]any{"skills": map[string]any{"skillFrontmatter": []any{map[string]any{"name": "actual-skill", "source": "plugin", "tokens": 30}}}}
	})
	spawner := useFakeSpawner(t, fake)
	result, err := Skills(context.Background(), inventoryInstallation, oar.InventoryOptions{Cwd: "project-a"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Kind != "ok" || result.View != "context" || len(result.Items) != 1 || result.Items[0] != (oar.SkillEntry{Name: "actual-skill", Source: "plugin"}) {
		t.Fatalf("result = %+v", result)
	}
	want, _ := filepath.Abs("project-a")
	if spawner.call(0).options.Dir != want {
		t.Fatalf("dir = %s", spawner.call(0).options.Dir)
	}
	var types []any
	for _, record := range fake.writtenRecords() {
		types = append(types, record["type"])
	}
	if len(types) != 2 || types[0] != "control_request" || types[1] != "control_request" {
		t.Fatalf("writes = %v", types)
	}
	if !fake.killed() {
		t.Fatal("not killed")
	}
}

func TestCommandDiscoveryUsesOnePrivateInitializeAnswer(t *testing.T) {
	var mu sync.Mutex
	var methods []string
	fake := controlServer(func(method string) any {
		mu.Lock()
		methods = append(methods, method)
		mu.Unlock()
		return map[string]any{"commands": []any{
			map[string]any{"name": "review", "description": "Review", "argumentHint": "<path>", "aliases": []any{"audit"}, "builtin": true},
			map[string]any{"name": "project-command", "description": "Project", "argumentHint": "", "private": "secret command body"},
		}, "account": map[string]any{"email": "private@example.test"}, "organization": "secret org"}
	})
	spawner := useFakeSpawner(t, fake)
	result, err := Commands(context.Background(), inventoryInstallation, oar.InventoryOptions{Cwd: "project-command"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Kind != "ok" || result.View != "discovered" || result.Partial {
		t.Fatalf("result = %+v", result)
	}
	assertJSON(t, result.Items, `[{"aliases":["audit"],"argumentHint":"<path>","description":"Review","name":"review","source":"builtin"},{"description":"Project","name":"project-command"}]`)
	mu.Lock()
	defer mu.Unlock()
	if len(methods) != 1 || methods[0] != "initialize" || !spawner.call(0).options.KillTree {
		t.Fatalf("methods = %v", methods)
	}
	encoded := jsonText(result)
	if strings.Contains(encoded, "secret") || strings.Contains(encoded, "private@example.test") {
		t.Fatalf("leaked: %s", encoded)
	}
}

func TestInventoryWaitsForProcessExitAfterAnsweringOrRejecting(t *testing.T) {
	for _, tc := range []struct {
		payload map[string]any
		kind    string
	}{{map[string]any{"commands": []any{}}, "ok"}, {map[string]any{}, "unavailable"}} {
		stubborn := &stubbornProcess{fakeProcess: controlServer(func(string) any { return tc.payload })}
		useSpawn(t, func(string, []string, executable.LineOptions) (claudeProcess, error) { return stubborn, nil })
		reading := observeSettlement(func() (oar.InventoryResult[oar.CommandEntry], error) {
			return Commands(context.Background(), inventoryInstallation, oar.InventoryOptions{})
		})
		eventually(t, "the kill", func() bool { return stubborn.killCount() == 1 })
		time.Sleep(50 * time.Millisecond)
		if reading.settled() {
			t.Fatal("settled before the process exited")
		}
		stubborn.end(nil)
		if result := reading.wait(t); result.Kind != tc.kind {
			t.Fatalf("result = %+v", result)
		}
		if stubborn.killCount() != 1 {
			t.Fatalf("kills = %d", stubborn.killCount())
		}
	}
}

func TestMalformedCommandCatalogIsUnavailable(t *testing.T) {
	for _, payload := range []any{map[string]any{}, map[string]any{"commands": map[string]any{}}, map[string]any{"commands": []any{map[string]any{"name": "x", "aliases": []any{3}}}}} {
		fake := controlServer(func(string) any { return payload })
		useFakeSpawner(t, fake)
		result, err := Commands(context.Background(), inventoryInstallation, oar.InventoryOptions{})
		if err != nil || result.Kind != "unavailable" || result.Code != "query_failed" {
			t.Fatalf("%v: result = %+v %v", payload, result, err)
		}
		if !fake.killed() {
			t.Fatal("not killed")
		}
	}
}

func TestNativeEmptyCommandCatalogIsASuccessfulEmptyResult(t *testing.T) {
	useFakeSpawner(t, controlServer(func(string) any { return map[string]any{"commands": []any{}} }))
	result, err := Commands(context.Background(), inventoryInstallation, oar.InventoryOptions{})
	if err != nil || result.Kind != "ok" || len(result.Items) != 0 || result.Partial {
		t.Fatalf("result = %+v %v", result, err)
	}
	assertJSON(t, result.Items, `[]`)
}

func TestPendingMcpWaitsForStartupAndFailureStaysPartial(t *testing.T) {
	var mu sync.Mutex
	reads := 0
	fake := controlServer(func(method string) any {
		if method == "initialize" {
			return map[string]any{}
		}
		mu.Lock()
		defer mu.Unlock()
		reads++
		if reads == 1 {
			return map[string]any{"mcpServers": []any{map[string]any{"name": "a", "status": "pending"}}}
		}
		return map[string]any{"mcpServers": []any{
			map[string]any{"name": "a", "status": "connected", "tools": []any{map[string]any{"name": "read", "annotations": map[string]any{}}}},
			map[string]any{"name": "b", "status": "failed", "error": "token=secret"},
		}}
	})
	useFakeSpawner(t, fake)
	result, err := Tools(context.Background(), inventoryInstallation, oar.InventoryOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Kind != "ok" || result.View != "mcp-only" || !result.Partial {
		t.Fatalf("result = %+v", result)
	}
	assertJSON(t, result.Items, `[{"name":"read","mcpServerId":"a","source":"mcp"}]`)
	mu.Lock()
	defer mu.Unlock()
	if reads != 2 || !fake.killed() {
		t.Fatalf("reads = %d", reads)
	}
	servers := []jsonx.Record{{"name": "b", "status": "failed", "error": "token=secret"}}
	entries, err := projectClaudeServers(servers)
	if err != nil || strings.Contains(jsonText(entries), "secret") {
		t.Fatalf("entries = %s %v", jsonText(entries), err)
	}
}

func TestNativeUnsupportedIsDistinctFromQueryFailure(t *testing.T) {
	fake := newFakeProcess(func(text string, self *fakeProcess) {
		request := jsonx.ParseRecord([]byte(strings.TrimSpace(text)))
		response := map[string]any{"request_id": request["request_id"]}
		if jsonx.AsRecord(request["request"])["subtype"] == "initialize" {
			response["subtype"], response["response"] = "success", map[string]any{}
		} else {
			response["subtype"], response["error"] = "error", "Unsupported control request subtype"
		}
		self.emitJSON(map[string]any{"type": "control_response", "response": response})
	})
	useFakeSpawner(t, fake)
	result, err := MCPServers(context.Background(), inventoryInstallation, oar.InventoryOptions{})
	if err != nil || result.Kind != "unsupported" || result.Code != "native_query_unavailable" {
		t.Fatalf("result = %+v %v", result, err)
	}
	if !fake.killed() {
		t.Fatal("not killed")
	}
}

func TestTimeoutReleasesOwnedDiscoveryProcess(t *testing.T) {
	for name, read := range map[string]func() (string, string, error){
		"skills": func() (string, string, error) {
			result, err := Skills(context.Background(), inventoryInstallation, oar.InventoryOptions{Timeout: 30 * time.Millisecond})
			return result.Kind, result.Code, err
		},
		"commands": func() (string, string, error) {
			result, err := Commands(context.Background(), inventoryInstallation, oar.InventoryOptions{Timeout: 30 * time.Millisecond})
			return result.Kind, result.Code, err
		},
	} {
		fake := newFakeProcess(nil)
		useFakeSpawner(t, fake)
		kind, code, err := read()
		if err != nil || kind != "unavailable" || code != "timeout" || !fake.killed() {
			t.Fatalf("%s: %s %s %v killed=%v", name, kind, code, err, fake.killed())
		}
	}
}

func TestInventoryTimeoutWaitsForTeardownBeforeReturning(t *testing.T) {
	stubborn := &stubbornProcess{fakeProcess: newFakeProcess(nil)}
	var options executable.LineOptions
	useSpawn(t, func(_ string, _ []string, given executable.LineOptions) (claudeProcess, error) {
		options = given
		return stubborn, nil
	})
	reading := observeSettlement(func() (oar.InventoryResult[oar.CommandEntry], error) {
		return Commands(context.Background(), inventoryInstallation, oar.InventoryOptions{Timeout: 30 * time.Millisecond})
	})
	eventually(t, "the kill", func() bool { return stubborn.killCount() == 1 })
	time.Sleep(50 * time.Millisecond)
	if stubborn.killCount() != 1 || reading.settled() || !options.KillTree {
		t.Fatalf("kills = %d settled = %v killTree = %v", stubborn.killCount(), reading.settled(), options.KillTree)
	}
	stubborn.end(nil)
	if result := reading.wait(t); result.Kind != "unavailable" || result.Code != "timeout" {
		t.Fatalf("result = %+v", result)
	}
}

func TestMalformedNativeSkillListNeverBecomesAnEmptySuccess(t *testing.T) {
	useFakeSpawner(t, controlServer(func(string) any { return map[string]any{} }))
	result, err := Skills(context.Background(), inventoryInstallation, oar.InventoryOptions{})
	if err != nil || result.Kind != "unavailable" || result.Code != "query_failed" {
		t.Fatalf("result = %+v %v", result, err)
	}
}
