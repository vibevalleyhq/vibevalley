package acp_test

// Ported from tests/fixtures/acp-session-support.ts: the scripted ACP agent
// (fake-acp-agent.mjs) and the session helpers the ACP tests share.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/acp"
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

func installation(t testing.TB) oar.AvailableInstallation {
	return oar.AvailableInstallation{Via: "executable", Command: nodePath(t)}
}

func testContext(t testing.TB) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	return ctx
}

// baseProfile is acp-session-support.ts profile(): the fixture's session mode.
func baseProfile() acp.Profile {
	return acp.Profile{
		Args:             acp.StaticArgs(fixture, "session"),
		Capabilities:     acp.Capabilities{Attribution: "nested"},
		SelectAuthMethod: func(jsonxRecord map[string]any) string { return "cached" },
		AbortTimeout:     500 * time.Millisecond,
		ConfigureSession: func(configure acp.ConfigureContext) error {
			_, err := configure.Request("session/set_mode", map[string]any{"sessionId": configure.SessionID, "modeId": "yolo"})
			return err
		},
	}
}

func profileWith(edit func(*acp.Profile)) acp.Profile {
	profile := baseProfile()
	if edit != nil {
		edit(&profile)
	}
	return profile
}

type startOptions struct {
	resume, model, effort string
}

func startSession(t testing.TB, profile acp.Profile, options startOptions) oar.Session {
	t.Helper()
	cwd, _ := os.Getwd()
	session, err := acp.Session(profile)(testContext(t), installation(t), oar.SessionOptions{Cwd: cwd, Resume: options.resume, Model: options.model, Effort: options.effort})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = session.Dispose(context.Background()) })
	return session
}

func start(t testing.TB, edit func(*acp.Profile)) oar.Session {
	return startSession(t, profileWith(edit), startOptions{})
}

// describe is a compact skeleton of one record: kind, type/body kind, events.
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

// tail is the records after afterSeq, compacted.
func tail(session oar.Session, afterSeq int64) []string {
	var out []string
	for _, record := range session.Records() {
		if record.Seq > afterSeq {
			out = append(out, describe(record))
		}
	}
	return out
}

func promptAndWait(t testing.TB, session oar.Session, input string, options observe.PromptRunOptions) observe.PromptRun {
	t.Helper()
	run, err := observe.PromptAndWait(testContext(t), session, input, options)
	if err != nil {
		t.Fatalf("promptAndWait %q: %v", input, err)
	}
	return run
}

func awaitTurnEnd(t testing.TB, session oar.Session, afterSeq int64) oar.TurnOutcome {
	t.Helper()
	outcome, err := observe.AwaitTurnEnd(testContext(t), session, afterSeq, "")
	if err != nil {
		t.Fatalf("awaitTurnEnd: %v", err)
	}
	return outcome
}

// jsonEqual compares two values by their JSON readings (TS deepEqual).
func jsonEqual(t testing.TB, got, want any, context ...any) {
	t.Helper()
	gotValue, wantValue := normalize(t, got), normalize(t, want)
	if !reflect.DeepEqual(gotValue, wantValue) {
		t.Fatalf("%s\n got: %s\nwant: %s", fmt.Sprint(context...), mustJSON(got), mustJSON(want))
	}
}

func normalize(t testing.TB, value any) any {
	t.Helper()
	var encoded []byte
	switch v := value.(type) {
	case json.RawMessage:
		encoded = v
	case string:
		if json.Valid([]byte(v)) && (strings.HasPrefix(v, "{") || strings.HasPrefix(v, "[")) {
			encoded = []byte(v)
		} else {
			encoded, _ = json.Marshal(v)
		}
	default:
		var err error
		encoded, err = json.Marshal(value)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
	}
	var out any
	if err := json.Unmarshal(encoded, &out); err != nil {
		t.Fatalf("unmarshal %s: %v", encoded, err)
	}
	return out
}

func mustJSON(value any) string {
	if raw, ok := value.(json.RawMessage); ok {
		return string(raw)
	}
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func equalStrings(t testing.TB, got, want []string, context ...any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s\n got: %q\nwant: %q", fmt.Sprint(context...), got, want)
	}
}

func contains(list []string, item string) bool {
	for _, entry := range list {
		if entry == item {
			return true
		}
	}
	return false
}

func indexOf(list []string, item string) int {
	for index, entry := range list {
		if entry == item {
			return index
		}
	}
	return -1
}

// eventually polls predicate until it holds or within passes.
func eventually(predicate func() bool, within time.Duration) bool {
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if predicate() {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return predicate()
}

func frames(session oar.Session) []oar.FrameBody {
	var out []oar.FrameBody
	for _, record := range session.Records() {
		if record.Kind == oar.KindFrame {
			out = append(out, record.Frame)
		}
	}
	return out
}

func said(session oar.Session) []string {
	out := []string{}
	for _, frame := range frames(session) {
		for _, event := range frame.Events {
			if text, ok := event.(oar.TextDelta); ok {
				out = append(out, text.Text)
			}
		}
	}
	return out
}

func lastSeq(session oar.Session) int64 {
	records := session.Records()
	if len(records) == 0 {
		return -1
	}
	return records[len(records)-1].Seq
}
