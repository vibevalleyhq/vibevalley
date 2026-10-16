//go:build wip_b

package claude

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"testing"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Ports tests/claude/claude-structured-output.test.ts.

var structuredInstallation = oar.AvailableInstallation{Via: "executable", Command: "claude"}

var b_outputSchema = json.RawMessage(`{"type":"object","properties":{"answer":{"type":"integer"}},"required":["answer"],"additionalProperties":false}`)

// b_resultFrame is a recorded result (real Claude 2.1.296 + aimock, 2026-10-11).
func b_resultFrame(t *testing.T, mode string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(replayFixtures, "claude-structured-output-"+mode+".raw.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	return string(compact(json.RawMessage(data)))
}

func b_outcomeOf(frame string, aborted bool) *oar.TurnOutcome {
	state := initialClaudeProjection()
	if aborted {
		state = claudeAbortRequested(state)
	}
	message, _ := parseNative([]byte(frame))
	_, commands := foldClaudeStdout(state, message)
	for _, command := range commands {
		for _, event := range command.Body.Events {
			if ended, ok := event.(oar.TurnEnded); ok && command.Kind == "frame" {
				return &ended.Outcome
			}
		}
	}
	return nil
}

func TestSchemaIsANativeLaunchArgumentIncludingResume(t *testing.T) {
	for _, resume := range []string{"", "existing-session"} {
		child := newFakeProcess(nil)
		spawner := useFakeSpawner(t, child)
		if _, err := launchClaude("claude", "session", oar.SessionOptions{Cwd: "/work", OutputSchema: b_outputSchema, Resume: resume, LaunchArgs: []string{"--verbose"}, DisallowedTools: []string{"Bash"}}); err != nil {
			t.Fatal(err)
		}
		args := spawner.call(0).args
		if !containsInOrder(args, "--json-schema", string(b_outputSchema)) || !containsInOrder(args, "--disallowed-tools", "Bash") {
			t.Fatalf("args = %v", args)
		}
		child.Kill()
	}
}

func TestNativeStructuredValuesPassThroughWithoutTruthinessOrTextParsing(t *testing.T) {
	for _, value := range []string{`null`, `false`, `0`, `""`, `{"nested":[1,"two"]}`} {
		outcome := b_outcomeOf(`{"type":"result","is_error":false,"result":"unrelated text","structured_output":`+value+`}`, false)
		assertJSON(t, outcome, `{"kind":"completed","structuredOutput":`+value+`}`)
	}
}

func TestNoStructuredFieldIsInferredFromTextOrCarriedOnFailedOrAbortedOutcomes(t *testing.T) {
	frame := `{"type":"result","result":"{\"answer\":4}","structured_output":{"answer":4}}`
	assertJSON(t, b_outcomeOf(`{"type":"result","result":"{\"answer\":4}"}`, false), `{"kind":"completed"}`)
	assertJSON(t, b_outcomeOf(frame, true), `{"kind":"aborted"}`)
	failed := b_outcomeOf(`{"type":"result","result":"{\"answer\":4}","structured_output":{"answer":4},"is_error":true,"subtype":"error"}`, false)
	if failed.StructuredOutput != nil {
		t.Fatal("a failed outcome carries structured output")
	}
	// #339: the class says the schema was not met; the reason keeps the subtype and claude's own errors text.
	invalid := b_outcomeOf(b_resultFrame(t, "invalid"), false)
	if invalid.Kind != "failed" || invalid.Failure != oar.FailureOutputSchema {
		t.Fatalf("invalid = %+v", invalid)
	}
	if !regexp.MustCompile(`^error_max_structured_output_retries: Failed to provide valid structured output after 5 attempts`).MatchString(invalid.Reason) {
		t.Fatalf("reason = %q", invalid.Reason)
	}
}

// b_liveView folds a session's records as an observer sees them.
type b_liveView struct {
	mu     sync.Mutex
	view   observe.SessionView
	folded int
}

func b_watch(session oar.Session) *b_liveView {
	live := &b_liveView{view: observe.InitialSessionView()}
	session.RawEvents(func(record oar.RawEvent) {
		live.mu.Lock()
		defer live.mu.Unlock()
		live.view = observe.ReduceSessionView(live.view, record, session.ID())
		live.folded++
	}, nil)
	return live
}

// caughtUp is the live view once it has folded n records.
func (l *b_liveView) caughtUp(t *testing.T, n int) observe.SessionView {
	t.Helper()
	eventually(t, "the live view", func() bool {
		l.mu.Lock()
		defer l.mu.Unlock()
		return l.folded >= n
	})
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.view
}

func b_turnOutcomeOfView(view observe.SessionView) any {
	var parsed struct {
		Messages []map[string]any `json:"messages"`
	}
	_ = json.Unmarshal([]byte(jsonText(view)), &parsed)
	for _, message := range parsed.Messages {
		if message["kind"] == "turn" {
			return message["outcome"]
		}
	}
	return nil
}

func b_startPrompt(t *testing.T, session oar.Session, input string) chan observe.PromptRun {
	t.Helper()
	run := make(chan observe.PromptRun, 1)
	before := len(session.Records())
	go func() {
		result, _ := observe.PromptAndWait(testContext(t), session, input, observe.PromptRunOptions{})
		run <- result
	}()
	eventually(t, "the prompt's response", func() bool {
		records := session.Records()
		return len(records) > before && records[len(records)-1].Kind == oar.KindResponse
	})
	return run
}

func TestRecordedResultReachesLiveWaitStatusAndJSONReplayUnchanged(t *testing.T) {
	for _, mode := range []string{"valid", "invalid"} {
		t.Run(mode, func(t *testing.T) {
			ctx := testContext(t)
			child := newFakeProcess(nil)
			useFakeSpawner(t, child)
			session, err := Session(ctx, structuredInstallation, oar.SessionOptions{Cwd: "/work", OutputSchema: b_outputSchema})
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = session.Dispose(ctx) }()
			live := b_watch(session)
			run := b_startPrompt(t, session, "answer")
			child.emit(b_resultFrame(t, mode) + "\n")
			expected := b_outcomeOf(b_resultFrame(t, mode), false)
			result := <-run
			if result.Kind != "ended" || result.Text != "" {
				t.Fatalf("run = %+v", result)
			}
			assertJSON(t, result.Outcome, jsonText(expected))
			status := session.Status().Value
			if status.Kind != "idle" {
				t.Fatalf("status = %+v", status)
			}
			assertJSON(t, status.LastTurnOutcome, jsonText(expected))
			records := session.Records()
			view := live.caughtUp(t, len(records))
			assertJSON(t, b_turnOutcomeOfView(view), jsonText(expected))
			var replayed []oar.RawEvent
			if err := json.Unmarshal([]byte(jsonText(records)), &replayed); err != nil {
				t.Fatal(err)
			}
			if jsonText(observe.ViewOf(replayed, session.ID())) != jsonText(view) {
				t.Fatal("the replayed view differs from the live one")
			}
			assertJSON(t, observe.TurnEndAfter(replayed, -1, session.ID(), ""), jsonText(expected))
			last := b_lastFrame(replayed)
			if last == nil || !b_sameJSON(jsonx.ParseRecord(last.Frame.Native), jsonx.ParseRecord([]byte(b_resultFrame(t, mode)))) {
				t.Fatal("the result frame's native changed")
			}
		})
	}
}

func TestChildResultCannotAnswerTheRootWaitAndTheNextTurnCannotInheritAStructuredResult(t *testing.T) {
	ctx := testContext(t)
	child := newFakeProcess(nil)
	useFakeSpawner(t, child)
	session, err := Session(ctx, structuredInstallation, oar.SessionOptions{Cwd: "/work"})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = session.Dispose(ctx) }()
	run := b_startPrompt(t, session, "root")
	childResult := jsonx.ParseRecord([]byte(b_resultFrame(t, "valid")))
	childResult["parent_tool_use_id"] = "child"
	before := len(session.Records())
	child.emitJSON(childResult)
	eventually(t, "the child result", func() bool { return len(session.Records()) > before })
	if outcome := observe.TurnEndAfter(session.Records(), -1, session.ID(), ""); outcome != nil {
		t.Fatalf("child ended the root turn: %+v", outcome)
	}
	child.emit(b_resultFrame(t, "valid") + "\n")
	first := <-run
	assertJSON(t, first.Outcome, `{"kind":"completed","structuredOutput":{"answer":4}}`)
	next := b_startPrompt(t, session, "plain")
	child.emit("{\"type\":\"result\",\"is_error\":false}\n")
	assertJSON(t, (<-next).Outcome, `{"kind":"completed"}`)
	assertJSON(t, session.Status().Value, `{"kind":"idle","lastTurnOutcome":{"kind":"completed"}}`)
}
