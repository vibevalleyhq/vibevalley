package observe

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// Ported from tests/app-requests.test.ts and the appRequestText test of
// tests/app-request-cancelled.test.ts.

func arKinds(types ...string) map[string]AppRequestKind {
	out := map[string]AppRequestKind{}
	for _, requestType := range types {
		out[requestType] = AppRequestKindOf(requestType)
	}
	return out
}

func TestAppRequestKindPerRuntime(t *testing.T) {
	got := map[string]map[string]AppRequestKind{
		"codex":  arKinds("item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput", "mcpServer/elicitation/request"),
		"claude": arKinds("can_use_tool", "elicitation"),
		"morph":  arKinds("approval"),
	}
	want := map[string]map[string]AppRequestKind{
		"claude": {"can_use_tool": "approval", "elicitation": "question"},
		"codex": {
			"item/commandExecution/requestApproval": "approval", "item/fileChange/requestApproval": "approval",
			"item/permissions/requestApproval": "approval", "item/tool/requestUserInput": "question", "mcpServer/elicitation/request": "question",
		},
		"morph": {"approval": "approval"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
}

// The TS test reads these off @agentclientprotocol/sdk 1.4.0's methods.client; Go has no SDK, so the names are spelled out.
func TestAppRequestKindACPClientMethods(t *testing.T) {
	got := arKinds("session/request_permission", "terminal/create", "terminal/output", "terminal/release", "terminal/wait_for_exit", "terminal/kill",
		"fs/read_text_file", "fs/write_text_file", "elicitation/create")
	want := map[string]AppRequestKind{
		"elicitation/create": "question", "fs/read_text_file": "service", "fs/write_text_file": "service",
		"session/request_permission": "approval", "terminal/create": "service", "terminal/kill": "service",
		"terminal/output": "service", "terminal/release": "service", "terminal/wait_for_exit": "service",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
}

func TestAppRequestKindRecordedACPVendorRuns(t *testing.T) {
	var sent []string
	for _, name := range []string{"kimi", "grok"} {
		text, err := os.ReadFile("../testdata/replay/fixtures/" + name + "-acp-v1.vendor.json")
		if err != nil {
			t.Fatal(err)
		}
		prompt := asRecord(asRecord(parseJSON(string(text)))["prompt"])
		if prompt == nil {
			t.Fatalf("%s: a recorded prompt", name)
		}
		for _, key := range []string{"permissionRequests", "terminalRequests"} {
			requests, _ := prompt[key].([]any)
			for _, request := range requests {
				method, _ := asRecord(request)["method"].(string)
				if _, ok := asRecord(request)["method"].(string); !ok {
					method = "undefined"
				}
				sent = append(sent, method)
			}
		}
	}
	want := map[string]AppRequestKind{"terminal/create": "service", "terminal/output": "service", "terminal/release": "service", "terminal/wait_for_exit": "service"}
	if got := arKinds(sent...); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
}

func TestAppRequestKindUnknownTypes(t *testing.T) {
	types := []string{"item/tool/call", "account/chatgptAuthTokens/refresh", "execCommandApproval", "applyPatchApproval", "hook_callback",
		"request_user_dialog", "fixture/reverse", "control_request", "", "toString", "__proto__"}
	for requestType, kind := range arKinds(types...) {
		if kind != "unknown" {
			t.Fatalf("%q: %s", requestType, kind)
		}
	}
}

func arBody(t *testing.T, value any) json.RawMessage {
	t.Helper()
	if value == nil {
		return nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestAppRequestTextReadsEachRuntimeField(t *testing.T) {
	type c struct {
		requestType string
		body        any
		want        string
		found       bool
	}
	for name, c := range map[string]c{
		"claudeApproval":   {"can_use_tool", map[string]any{"type": "control_request", "request": map[string]any{"subtype": "can_use_tool", "tool_name": "Bash", "input": map[string]any{}}}, "Bash", true},
		"codexElicitation": {"mcpServer/elicitation/request", map[string]any{"serverName": "docs", "threadId": "t", "message": "Sign in?"}, "Sign in?", true},
		"codexQuestions": {"item/tool/requestUserInput", map[string]any{"questions": []any{
			map[string]any{"id": "a", "header": "Plan", "question": "Ship now?"}, map[string]any{"id": "b", "header": "Scope", "question": "Tests too?"},
		}}, "Ship now?\nTests too?", true},
		"codexCommand":   {"item/commandExecution/requestApproval", map[string]any{"command": "rm -rf build"}, "rm -rf build", true},
		"acpPermission":  {"session/request_permission", map[string]any{"toolCall": map[string]any{"toolCallId": "c", "title": "Edit main.ts"}}, "Edit main.ts", true},
		"acpElicitation": {"elicitation/create", map[string]any{"message": "Pick one"}, "Pick one", true},
		"unknownType":    {"terminal/create", map[string]any{"command": "ls"}, "", false},
		"missingField":   {"item/tool/requestUserInput", map[string]any{"questions": []any{}}, "", false},
		"blank":          {"mcpServer/elicitation/request", map[string]any{"message": "  "}, "", false},
		"noBody":         {"elicitation", nil, "", false},
		"claudeElicitation": {"elicitation", map[string]any{"type": "control_request", "request_id": "a19c0ccb-9037-4733-9496-375c4762cfa2", "request": map[string]any{
			"subtype": "elicitation", "mcp_server_name": "ask", "message": "Which color do you like?", "mode": "form",
		}}, "Which color do you like?", true},
	} {
		got, found := AppRequestText(c.requestType, arBody(t, c.body))
		if got != c.want || found != c.found {
			t.Fatalf("%s: %q %v, want %q %v", name, got, found, c.want, c.found)
		}
	}
}
