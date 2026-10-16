package acp_test

// Ported from tests/acp/acp-session-effort.test.ts.

import (
	"os"
	"strings"
	"testing"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

func TestOpeningAnswersReportTheAgentsEffort(t *testing.T) {
	session := start(t, nil)
	opening := describeAll(session.Records())
	if opening[2] != "event session/new → model:fixture-model-x, effort:medium" {
		t.Fatal(opening[2])
	}
	if effort := session.Effort().Value; effort == nil || *effort != "medium" {
		t.Fatal(effort)
	}
}

func TestRequestedEffortIsSetThroughTheThoughtLevelOption(t *testing.T) {
	session := startSession(t, baseProfile(), startOptions{effort: "high"})
	opening := describeAll(session.Records())
	// kimi-style: the agent pushes the update before it answers; both are its word.
	for _, line := range []string{"event config_option_update → model:fixture-model-x, effort:high", "event session/set_config_option → model:fixture-model-x, effort:high"} {
		if !contains(opening, line) {
			t.Fatalf("%q not in %q", line, opening)
		}
	}
	if effort := session.Effort().Value; effort == nil || *effort != "high" {
		t.Fatal(effort)
	}
	for _, frame := range frames(session) {
		if frame.Type == "session/set_config_option" {
			options := jsonx.AsRecordList(jsonx.ParseRecord(frame.Native)["configOptions"])
			if len(options) < 2 || options[0]["id"] != "model" || options[1]["id"] != "fixture_effort" || options[1]["currentValue"] != "high" {
				t.Fatalf("answer %s", frame.Native)
			}
			return
		}
	}
	t.Fatal("no set_config_option answer")
}

func TestResumedSessionTakesTheRequestedEffort(t *testing.T) {
	session := startSession(t, baseProfile(), startOptions{resume: "fake-session", effort: "low"})
	if session.ID() != "fake-session" {
		t.Fatal(session.ID())
	}
	if effort := session.Effort().Value; effort == nil || *effort != "low" {
		t.Fatal(effort)
	}
}

func TestOpenIsRefusedWhenEffortCannotApply(t *testing.T) {
	for _, tc := range []struct{ name, mode, effort, message string }{
		{"the agent refuses the level", "session", "bogus", "session/set_config_option fixture_effort=bogus was refused: Invalid params (unknown fixture_effort value)"},
		{"the agent applies another level", "session", "sticky", "session/set_config_option left fixture_effort at medium although effort sticky was requested"},
		{"the agent offers no thought_level option", "no-thought-level", "high", "session/new advertises no thought_level config option, so effort high cannot be applied"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cwd, _ := os.Getwd()
			_, err := acp.Session(profileWith(func(profile *acp.Profile) { profile.Args = acp.StaticArgs(fixture, tc.mode) }))(testContext(t), installation(t), oar.SessionOptions{Cwd: cwd, Effort: tc.effort})
			if err == nil || !strings.Contains(err.Error(), tc.message) {
				t.Fatalf("got %v", err)
			}
		})
	}
}

func TestThoughtLevelOptionIsFoundByCategory(t *testing.T) {
	configOptions := []any{
		map[string]any{"id": "model", "category": "model", "currentValue": "k3"},
		map[string]any{"id": "thinking", "category": "thought_level", "currentValue": "high"},
		map[string]any{"id": "mode", "category": "mode", "currentValue": "yolo"},
	}
	if id := acp.ThoughtLevelOption(jsonx.Record{"configOptions": configOptions})["id"]; id != "thinking" {
		t.Fatal(id)
	}
	if effort, ok := acp.ReportedEffort(jsonx.Record{"configOptions": configOptions}); !ok || effort != "high" {
		t.Fatal(effort)
	}
	if _, ok := acp.ReportedEffort(jsonx.Record{"configOptions": []any{map[string]any{"id": "thinking", "currentValue": "high"}}}); ok {
		t.Fatal("no category, no effort")
	}
	if _, ok := acp.ReportedEffort(nil); ok {
		t.Fatal("nil frame")
	}
}
