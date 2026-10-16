//go:build wip_b

package claude

import (
	"reflect"
	"strings"
	"testing"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// Ports tests/claude/claude-session-effort.test.ts.

var effortInstallation = oar.AvailableInstallation{Via: "executable", Command: "claude", Version: "2.1.284"}

// b_scriptedEffortClaude answers the get_settings read-back the way 2.1.284
// does: SessionStart hook frames first, then the control_response whose
// applied block is what it will send, next to the merged settings (an env
// block standing in for a user's secrets). failure != "" answers an error.
func b_scriptedEffortClaude(t *testing.T, applied map[string]any, failure string) (*fakeProcess, *fakeSpawner) {
	fake := newFakeProcess(func(text string, process *fakeProcess) {
		message := b_requestOf(text)
		request := jsonx.AsRecord(message["request"])
		if message["type"] == "control_request" && request["subtype"] == "initialize" {
			process.emitJSON(b_controlSuccess(message["request_id"], map[string]any{}))
			return
		}
		if message["type"] == "control_request" && request["subtype"] == "get_usage" {
			process.emitJSON(b_controlSuccess(message["request_id"], map[string]any{"session": map[string]any{"model_usage": map[string]any{}}}))
			return
		}
		if message["type"] != "control_request" || request["subtype"] != "get_settings" {
			return
		}
		process.emitJSON(map[string]any{"type": "system", "subtype": "hook_started", "hook_name": "SessionStart:startup"})
		process.emitJSON(map[string]any{"type": "system", "subtype": "hook_response", "hook_name": "SessionStart:startup", "output": ""})
		var response map[string]any
		if failure != "" {
			response = map[string]any{"subtype": "error", "request_id": message["request_id"], "error": failure}
		} else {
			secrets := map[string]any{"env": map[string]any{"SECRET_TOKEN": "do-not-record"}}
			response = map[string]any{"subtype": "success", "request_id": message["request_id"], "response": map[string]any{
				"effective": secrets,
				"sources":   []any{map[string]any{"source": "userSettings", "settings": secrets}},
				"applied":   applied,
			}}
		}
		process.emitJSON(map[string]any{"type": "control_response", "response": response})
	})
	return fake, useFakeSpawner(t, fake)
}

func TestEffortIsFlagOnANewSessionConfirmedByGetSettings(t *testing.T) {
	fresh, spawner := b_scriptedEffortClaude(t, map[string]any{"model": "claude-opus-5-5[1m]", "effort": "low"}, "")
	session, err := Session(testContext(t), effortInstallation, oar.SessionOptions{Cwd: "/work", Effort: "low"})
	if err != nil {
		t.Fatal(err)
	}
	args := spawner.call(0).args
	if !containsInOrder(args, "--effort", "low") || !containsInOrder(args, "--session-id", session.ID()) {
		t.Fatalf("args = %v", args)
	}
	var subtypes []any
	for _, text := range fresh.writes() {
		subtypes = append(subtypes, b_subtypeOf(text))
	}
	if !reflect.DeepEqual(subtypes, []any{"get_settings"}) {
		t.Fatalf("writes = %v", subtypes)
	}
	_ = session.Dispose(testContext(t))
}

func TestEffortIsFlagOnAResumeTooConfirmedTheSameWay(t *testing.T) {
	_, spawner := b_scriptedEffortClaude(t, map[string]any{"model": "claude-opus-5-5[1m]", "effort": "high"}, "")
	resumed, err := Session(testContext(t), effortInstallation, oar.SessionOptions{Cwd: "/work", Resume: "earlier-id", Effort: "high"})
	if err != nil {
		t.Fatal(err)
	}
	args := spawner.call(0).args
	if !containsInOrder(args, "--resume", "earlier-id") || !containsInOrder(args, "--effort", "high") {
		t.Fatalf("args = %v", args)
	}
	if resumed.ID() != "earlier-id" {
		t.Fatalf("id = %s", resumed.ID())
	}
	_ = resumed.Dispose(testContext(t))
}

// The read-back's answer dumps the merged settings of every source, env
// included: it is consumed, never recorded, while claude's other frames are.
func TestGetSettingsAnswerNeverEntersTheStreamTheHookFramesDo(t *testing.T) {
	b_scriptedEffortClaude(t, map[string]any{"model": "claude-opus-5-5[1m]", "effort": "low"}, "")
	session, err := Session(testContext(t), effortInstallation, oar.SessionOptions{Cwd: "/work", Effort: "low"})
	if err != nil {
		t.Fatal(err)
	}
	records := session.Records()
	var kinds []string
	for _, record := range records {
		if record.Kind == oar.KindFrame {
			kinds = append(kinds, record.Frame.Type)
		} else {
			kinds = append(kinds, string(record.Kind))
		}
	}
	if !reflect.DeepEqual(kinds, []string{"system/hook_started", "system/hook_response"}) {
		t.Fatalf("records = %v", kinds)
	}
	if strings.Contains(jsonText(records), "do-not-record") {
		t.Fatal("settings leaked into records")
	}
	if session.Effort().Value != nil {
		t.Fatal("claude reports no effort")
	}
	_ = session.Dispose(testContext(t))
}

func TestWithoutAnEffortNothingExtraIsAsked(t *testing.T) {
	fake := newFakeProcess(nil)
	spawner := useFakeSpawner(t, fake)
	session, err := Session(testContext(t), effortInstallation, oar.SessionOptions{Cwd: "/work"})
	if err != nil {
		t.Fatal(err)
	}
	for _, arg := range spawner.call(0).args {
		if arg == "--effort" {
			t.Fatal("--effort passed")
		}
	}
	if len(fake.writes()) != 0 {
		t.Fatalf("writes = %v", fake.writes())
	}
	_ = session.Dispose(testContext(t))
}

func TestOpenIsRefusedAndClaudeStoppedWhenEffortCannotBeConfirmed(t *testing.T) {
	for _, tc := range []struct {
		name    string
		effort  string
		applied map[string]any
		failure string
		message string
	}{
		{"an unknown level claude drops with a stderr warning", "bogus", map[string]any{"model": "claude-opus-5-5[1m]", "effort": "medium"}, "",
			"claude applies effort medium for claude-opus-5-5[1m] although bogus was requested"},
		{"a model that takes no effort", "low", map[string]any{"model": "claude-haiku-4-5-20251001", "effort": nil}, "",
			"claude sends no effort for claude-haiku-4-5-20251001 (the model takes none), so effort low would be dropped"},
		{"a failed read-back", "low", nil, "get_settings is not available on this connection",
			"claude could not report the effort it runs (get_settings: get_settings is not available on this connection), so effort low cannot be confirmed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake, _ := b_scriptedEffortClaude(t, tc.applied, tc.failure)
			_, err := Session(testContext(t), effortInstallation, oar.SessionOptions{Cwd: "/work", Effort: tc.effort})
			if err == nil || !strings.Contains(err.Error(), tc.message) {
				t.Fatalf("error = %v", err)
			}
			if !fake.killed() {
				t.Fatal("claude was not stopped")
			}
		})
	}
}

func TestClaudeExitingBeforeItAnswersRefusesTheOpen(t *testing.T) {
	fake := newFakeProcess(func(text string, process *fakeProcess) {
		if strings.Contains(text, "get_settings") {
			process.end(intPtr(1))
		}
	})
	useFakeSpawner(t, fake)
	_, err := Session(testContext(t), effortInstallation, oar.SessionOptions{Cwd: "/work", Effort: "low"})
	if err == nil || !strings.Contains(err.Error(), "claude exited (code 1) before answering get_settings, so effort low cannot be confirmed") {
		t.Fatalf("error = %v", err)
	}
}

func b_effortSuccess(applied map[string]any) jsonx.Record {
	return jsonx.ParseRecord([]byte(jsonText(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": "r", "response": map[string]any{"effective": map[string]any{}, "sources": []any{}, "applied": applied}}})))
}

func TestClaudeEffortRefusalReadsAppliedEffort(t *testing.T) {
	if got := claudeEffortRefusal("low", b_effortSuccess(map[string]any{"model": "claude-sonnet-5-5", "effort": "low"})); got != "" {
		t.Fatalf("refusal = %q", got)
	}
	got := map[string]string{
		"ignored":    claudeEffortRefusal("bogus", b_effortSuccess(map[string]any{"model": "claude-opus-5-5[1m]", "effort": "medium"})),
		"dropped":    claudeEffortRefusal("low", b_effortSuccess(map[string]any{"model": "claude-haiku-4-5-20251001", "effort": nil})),
		"unreported": claudeEffortRefusal("low", b_effortSuccess(map[string]any{"model": "claude-opus-5-5[1m]"})),
		"failed":     claudeEffortRefusal("low", jsonx.ParseRecord([]byte(`{"type":"control_response","response":{"subtype":"error","request_id":"r","error":"unsupported control request"}}`))),
	}
	want := map[string]string{
		"dropped":    "claude sends no effort for claude-haiku-4-5-20251001 (the model takes none), so effort low would be dropped",
		"failed":     "claude could not report the effort it runs (get_settings: unsupported control request), so effort low cannot be confirmed",
		"ignored":    "claude applies effort medium for claude-opus-5-5[1m] although bogus was requested",
		"unreported": "claude's get_settings answer names no applied effort, so effort low cannot be confirmed",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
}
