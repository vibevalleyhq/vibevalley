//go:build wip_a

package claude

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Helpers for the session tests ported from tests/claude (fork A).

// lineSync waits until the session has handled every line emitted so far:
// a non-JSON marker line (which the session ignores) is emitted, and a line
// handler registered after the session's sees it only after the session
// handled everything before it.
type lineSync struct {
	mu   sync.Mutex
	seen map[string]bool
	n    int
	fake *fakeProcess
}

func attachSync(fake *fakeProcess) *lineSync {
	sync := &lineSync{seen: map[string]bool{}, fake: fake}
	fake.OnLine(func(line string) {
		if strings.HasPrefix(line, "#sync-") {
			sync.mu.Lock()
			sync.seen[line] = true
			sync.mu.Unlock()
		}
	})
	return sync
}

func (s *lineSync) wait(t *testing.T) {
	t.Helper()
	s.mu.Lock()
	s.n++
	marker := fmt.Sprintf("#sync-%d", s.n)
	s.mu.Unlock()
	s.fake.emit(marker + "\n")
	deadline := time.Now().Add(5 * time.Second)
	for {
		s.mu.Lock()
		done := s.seen[marker]
		s.mu.Unlock()
		if done {
			return
		}
		select {
		case <-s.fake.Exited():
			return
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("lines not handled: %s", marker)
		}
		time.Sleep(time.Millisecond)
	}
}

// emit emits frames and waits until the session handled them (TS: synchronous fake delivery).
func (s *lineSync) emit(t *testing.T, frames ...any) {
	t.Helper()
	for _, frame := range frames {
		s.fake.emitJSON(frame)
	}
	s.wait(t)
}

// openScripted opens a session on fake (with its write hook) and attaches a lineSync.
func openScripted(t *testing.T, fake *fakeProcess, options oar.SessionOptions) (oar.Session, *lineSync) {
	t.Helper()
	useFakeSpawner(t, fake)
	if options.Cwd == "" {
		options.Cwd = "/work"
	}
	session, err := Session(testContext(t), oar.AvailableInstallation{Via: "executable", Command: "claude", Version: "2.1.292"}, options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_ = session.Dispose(ctx)
	})
	return session, attachSync(fake)
}

// recordEvents is every frame event of the records, in order.
func recordEvents(records []oar.RawEvent) []oar.EventBody {
	events := []oar.EventBody{}
	for _, record := range records {
		if record.Kind == oar.KindFrame {
			events = append(events, record.Frame.Events...)
		}
	}
	return events
}

func eventsOfKind(events []oar.EventBody, kind string) []oar.EventBody {
	out := []oar.EventBody{}
	for _, event := range events {
		if event.EventKind() == kind {
			out = append(out, event)
		}
	}
	return out
}

// commandEvents is the frame events of fold commands.
func commandEvents(commands []projectionCommand) []oar.EventBody {
	events := []oar.EventBody{}
	for _, command := range commands {
		if command.Kind == "frame" {
			events = append(events, command.Body.Events...)
		}
	}
	return events
}

func jsonOf(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

// sameJSON asserts two values serialize to semantically equal JSON (TS toEqual).
func sameJSON(t *testing.T, got, want any) {
	t.Helper()
	var left, right any
	_ = json.Unmarshal([]byte(jsonOf(t, got)), &left)
	_ = json.Unmarshal([]byte(jsonOf(t, want)), &right)
	if jsonOf(t, left) != jsonOf(t, right) {
		t.Fatalf("got  %s\nwant %s", jsonOf(t, got), jsonOf(t, want))
	}
}

// matchJSON asserts every field of want is in got (TS toMatchObject, recursively).
func matchJSON(t *testing.T, got any, want string) {
	t.Helper()
	var left, right any
	_ = json.Unmarshal([]byte(jsonOf(t, got)), &left)
	if err := json.Unmarshal([]byte(want), &right); err != nil {
		t.Fatalf("bad expectation %s", want)
	}
	if !subset(left, right) {
		t.Fatalf("got  %s\ndoes not match %s", jsonOf(t, got), want)
	}
}

func subset(got, want any) bool {
	switch typed := want.(type) {
	case map[string]any:
		object, ok := got.(map[string]any)
		if !ok {
			return false
		}
		for key, value := range typed {
			field, present := object[key]
			if !present || !subset(field, value) {
				return false
			}
		}
		return true
	case []any:
		list, ok := got.([]any)
		if !ok || len(list) != len(typed) {
			return false
		}
		for index := range typed {
			if !subset(list[index], typed[index]) {
				return false
			}
		}
		return true
	}
	encodedGot, _ := json.Marshal(got)
	encodedWant, _ := json.Marshal(want)
	return string(encodedGot) == string(encodedWant)
}

// liveView folds the session's records as they are delivered (TS: a rawEvents observer).
type liveView struct {
	mu      sync.Mutex
	view    observe.SessionView
	lastSeq int64
}

func watchView(session oar.Session) *liveView {
	live := &liveView{view: observe.InitialSessionView(), lastSeq: -1}
	session.RawEvents(func(record oar.RawEvent) {
		live.mu.Lock()
		live.view = observe.ReduceSessionView(live.view, record, "")
		live.lastSeq = record.Seq
		live.mu.Unlock()
	}, nil)
	return live
}

// current waits until every retained record was folded, then returns the view.
func (l *liveView) current(t *testing.T, session oar.Session) observe.SessionView {
	t.Helper()
	records := session.Records()
	want := int64(-1)
	if len(records) > 0 {
		want = records[len(records)-1].Seq
	}
	var view observe.SessionView
	eventually(t, "live view", func() bool {
		l.mu.Lock()
		defer l.mu.Unlock()
		view = l.view
		return l.lastSeq >= want
	})
	return view
}

func pendingInputIDs(view observe.SessionView) []string {
	ids := []string{}
	for _, input := range view.PendingInputs {
		ids = append(ids, input.InputID)
	}
	return ids
}

func viewTurns(view observe.SessionView) []observe.ViewMessage {
	var turns []observe.ViewMessage
	for _, message := range view.Messages {
		if message.Kind == "turn" {
			turns = append(turns, message)
		}
	}
	return turns
}

func viewInput(view observe.SessionView, inputID string) (observe.ViewMessage, int) {
	for index, message := range view.Messages {
		if message.Kind == "input" && message.Input != nil && message.Input.InputID == inputID {
			return message, index
		}
	}
	return observe.ViewMessage{}, -1
}

func messageIndex(view observe.SessionView, id string) int {
	for index, message := range view.Messages {
		if message.ID == id {
			return index
		}
	}
	return -1
}

func lastPromptRequest(records []oar.RawEvent) (oar.RawEvent, bool) {
	for index := len(records) - 1; index >= 0; index-- {
		record := records[index]
		if record.Kind == oar.KindRequest && record.Request.Kind == oar.RequestPrompt {
			return record, true
		}
	}
	return oar.RawEvent{}, false
}

// lastKind is the kind of the latest record ("" when none).
func lastKind(session oar.Session) oar.RecordKind {
	records := session.Records()
	if len(records) == 0 {
		return ""
	}
	return records[len(records)-1].Kind
}

// frameNatives is every frame's native, decoded.
func frameNatives(records []oar.RawEvent) []any {
	natives := []any{}
	for _, record := range records {
		if record.Kind == oar.KindFrame {
			natives = append(natives, jsonx.ParseRecord(record.Frame.Native))
		}
	}
	return natives
}

func recordsAsAny(records []jsonx.Record) []any {
	out := []any{}
	for _, record := range records {
		out = append(out, record)
	}
	return out
}

func replayFixture(t *testing.T, name, side string) []jsonx.Record {
	t.Helper()
	return readRecords(t, filepath.Join(replayFixtures, "claude-"+name+"."+side+".jsonl"))
}

// promptRun runs observe.PromptAndWait on a goroutine (TS: an unawaited promise).
type promptRun struct {
	done   chan struct{}
	result observe.PromptRun
	err    error
}

func startPromptAndWait(t *testing.T, session oar.Session, input string, options observe.PromptRunOptions) *promptRun {
	t.Helper()
	run := &promptRun{done: make(chan struct{})}
	ctx := testContext(t)
	go func() {
		defer close(run.done)
		run.result, run.err = observe.PromptAndWait(ctx, session, input, options)
	}()
	return run
}

func (r *promptRun) wait(t *testing.T) observe.PromptRun {
	t.Helper()
	select {
	case <-r.done:
	case <-time.After(15 * time.Second):
		t.Fatal("promptAndWait never settled")
	}
	if r.err != nil {
		t.Fatal(r.err)
	}
	return r.result
}

// outcomeWait runs an awaiting function on a goroutine.
type outcomeWait struct {
	done    chan struct{}
	outcome *oar.TurnOutcome
	err     error
}

func startAwaitTurnEnd(t *testing.T, session oar.Session, seq int64, inputID string) *outcomeWait {
	t.Helper()
	wait := &outcomeWait{done: make(chan struct{})}
	ctx := testContext(t)
	go func() {
		defer close(wait.done)
		outcome, err := observe.AwaitTurnEnd(ctx, session, seq, inputID)
		wait.outcome, wait.err = &outcome, err
	}()
	return wait
}

func startAwaitIdle(t *testing.T, session oar.Session) *outcomeWait {
	t.Helper()
	wait := &outcomeWait{done: make(chan struct{})}
	ctx := testContext(t)
	go func() {
		defer close(wait.done)
		wait.outcome, wait.err = observe.AwaitIdle(ctx, session)
	}()
	return wait
}

func (w *outcomeWait) settled() bool {
	select {
	case <-w.done:
		return true
	default:
		return false
	}
}

func (w *outcomeWait) wait(t *testing.T) oar.TurnOutcome {
	t.Helper()
	select {
	case <-w.done:
	case <-time.After(15 * time.Second):
		t.Fatal("wait never settled")
	}
	if w.err != nil {
		t.Fatal(w.err)
	}
	if w.outcome == nil {
		t.Fatal("no outcome")
	}
	return *w.outcome
}

func turnEnd(t *testing.T, session oar.Session, seq int64, inputID string) oar.TurnOutcome {
	t.Helper()
	outcome, err := observe.AwaitTurnEnd(testContext(t), session, seq, inputID)
	if err != nil {
		t.Fatal(err)
	}
	return outcome
}

func prompt(t *testing.T, session oar.Session, input, inputID string) oar.ControlOutcome {
	t.Helper()
	outcome, err := session.Prompt(testContext(t), input, oar.InputOptions{InputID: inputID})
	if err != nil {
		t.Fatal(err)
	}
	return outcome
}

// ─── process trees (tests/fixtures/process-tree.ts) ─────────────────────────

const fakeAgentScript = "../../testdata/fixtures/fake-agent-process.mjs"

type agentTree struct {
	Agent      int `json:"agent"`
	Grandchild int `json:"grandchild"`
}

type treeProbe struct {
	dir     string
	env     map[string]*string
	pidFile string
}

func alive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

// gone polls until pid no longer runs; false when it outlives within.
func gone(pid int, within time.Duration) bool {
	deadline := time.Now().Add(within)
	for alive(pid) {
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
	return true
}

// withTreeProbe gives a scratch directory whose env makes a fake agent grow
// its tree; afterwards whatever the agent reported is SIGKILLed.
func withTreeProbe(t *testing.T, ignoreSigterm, detachTool bool) *treeProbe {
	t.Helper()
	dir := t.TempDir()
	probe := &treeProbe{dir: dir, pidFile: filepath.Join(dir, "pids.json"), env: map[string]*string{"OAR_FIXTURE_PIDS": oar.String(filepath.Join(dir, "pids.json"))}}
	if ignoreSigterm {
		probe.env["OAR_FIXTURE_IGNORE_SIGTERM"] = oar.String("1")
	}
	if detachTool {
		probe.env["OAR_FIXTURE_DETACH_TOOL"] = oar.String("1")
	}
	t.Cleanup(func() {
		if data, err := os.ReadFile(probe.pidFile); err == nil {
			var tree agentTree
			if json.Unmarshal(data, &tree) == nil {
				for _, pid := range []int{tree.Agent, tree.Grandchild} {
					if pid > 0 {
						_ = syscall.Kill(pid, syscall.SIGKILL)
					}
				}
			}
		}
	})
	return probe
}

func (p *treeProbe) tree(t *testing.T) agentTree {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if data, err := os.ReadFile(p.pidFile); err == nil {
			var tree agentTree
			if err := json.Unmarshal(data, &tree); err != nil {
				t.Fatal(err)
			}
			return tree
		}
		if time.Now().After(deadline) {
			t.Fatalf("the fake agent never reported its pids in %s", p.pidFile)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// fakeAgentBinary is a POSIX launcher that execs node on the fake agent, keeping its pid.
func fakeAgentBinary(t *testing.T, dir string) string {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not on PATH")
	}
	script, err := filepath.Abs(fakeAgentScript)
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(dir, "fake-agent")
	if err := os.WriteFile(binary, []byte(fmt.Sprintf("#!/bin/sh\nexec %q %q \"$@\"\n", node, script)), 0o755); err != nil {
		t.Fatal(err)
	}
	return binary
}

// useProcess replaces spawnLineProcess with one handing out process (any claudeProcess).
func useProcess(t *testing.T, process claudeProcess) {
	t.Helper()
	previous := spawnLineProcess
	spawnLineProcess = func(string, []string, executable.LineOptions) (claudeProcess, error) { return process, nil }
	t.Cleanup(func() { spawnLineProcess = previous })
}
