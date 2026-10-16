package antigravity

// Helpers from smith/internal/acp/support_test.go (tests/fixtures/acp-session-support.ts).

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

const fixturesDir = "../../testdata/fixtures"

var fixture = mustAbs(filepath.Join(fixturesDir, "fake-acp-agent.mjs"))

func mustAbs(path string) string {
	absolute, err := filepath.Abs(path)
	if err != nil {
		panic(err)
	}
	return absolute
}

func nodePath(t testing.TB) string {
	t.Helper()
	path, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not on PATH")
	}
	return path
}

func nodeInstallation(t testing.TB) oar.AvailableInstallation {
	return oar.AvailableInstallation{Via: "executable", Command: nodePath(t)}
}

func testContext(t testing.TB) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func describe(record oar.RawEvent) string {
	switch record.Kind {
	case oar.KindRequest:
		prefix := "request"
		if record.Direction == oar.ToApp {
			prefix = "toApp"
		}
		if record.Request.Kind == oar.RequestNative {
			return prefix + " " + record.Request.Type
		}
		return prefix + " " + string(record.Request.Kind)
	case oar.KindResponse:
		return "response " + string(record.Response.Kind)
	case oar.KindFrame:
		var events []string
		for _, view := range record.Frame.Events {
			switch e := view.(type) {
			case oar.TextDelta:
				events = append(events, "text:"+e.Text)
			case oar.TurnEnded:
				events = append(events, "turn_ended:"+e.Outcome.Kind)
			case oar.ToolCallStarted:
				events = append(events, "tool_call_started:"+e.Tool)
			case oar.Model:
				events = append(events, "model:"+e.Model)
			case oar.Effort:
				events = append(events, "effort:"+e.Effort)
			case oar.UnknownEvent:
				events = append(events, "?")
			default:
				events = append(events, view.EventKind())
			}
		}
		if len(events) == 0 {
			return "event " + record.Frame.Type
		}
		return "event " + record.Frame.Type + " → " + strings.Join(events, ", ")
	}
	return "?"
}

func describeAll(records []oar.RawEvent) []string {
	out := []string{}
	for _, record := range records {
		out = append(out, describe(record))
	}
	return out
}

func promptAndWait(t testing.TB, session oar.Session, input string) observe.PromptRun {
	t.Helper()
	run, err := observe.PromptAndWait(testContext(t), session, input, observe.PromptRunOptions{})
	if err != nil {
		t.Fatalf("promptAndWait %q: %v", input, err)
	}
	return run
}

func jsonEqual(t testing.TB, got, want any, context ...any) {
	t.Helper()
	if !reflect.DeepEqual(normalize(t, got), normalize(t, want)) {
		gotJSON, _ := json.Marshal(got)
		wantJSON, _ := json.Marshal(want)
		t.Fatalf("%s\n got: %s\nwant: %s", fmt.Sprint(context...), gotJSON, wantJSON)
	}
}

func normalize(t testing.TB, value any) any {
	t.Helper()
	var encoded []byte
	switch v := value.(type) {
	case json.RawMessage:
		encoded = v
	case string:
		// A JSON object or array literal stands for its value (TS inline snapshots).
		if json.Valid([]byte(v)) && (strings.HasPrefix(v, "{") || strings.HasPrefix(v, "[")) {
			encoded = []byte(v)
		} else {
			encoded, _ = json.Marshal(v)
		}
	default:
		var err error
		if encoded, err = json.Marshal(value); err != nil {
			t.Fatal(err)
		}
	}
	var out any
	if err := json.Unmarshal(encoded, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func contains(list []string, item string) bool {
	for _, entry := range list {
		if entry == item {
			return true
		}
	}
	return false
}

func eventually(predicate func() bool, within time.Duration) bool {
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if predicate() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return predicate()
}
