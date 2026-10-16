package codex

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// fakeProcess is the Go port of tests/fixtures/fake-line-process.ts: a
// scripted app-server. Lines and the exit are delivered on the fake's own
// goroutine, in order, the exit after every line emitted before it, as
// executable.LineProcess delivers them. Kill ends the process
// asynchronously, never on the calling goroutine.
type fakeProcess struct {
	mu           sync.Mutex
	cond         *sync.Cond
	written      []string
	onWrite      func(text string, fake *fakeProcess)
	lineHandlers []func(string)
	exitHandlers []func(*int)
	queue        []fakeItem
	pending      string
	ended        bool
	delivered    bool
	wasKilled    bool
	killHook     func()
	exitCode     *int
	signal       string
	stderr       string
	exited       chan struct{}
}

type fakeItem struct {
	line string
	exit bool
	code *int
}

func newFakeProcess(onWrite func(text string, fake *fakeProcess)) *fakeProcess {
	fake := &fakeProcess{onWrite: onWrite, exited: make(chan struct{})}
	fake.cond = sync.NewCond(&fake.mu)
	go fake.deliver()
	return fake
}

func (f *fakeProcess) deliver() {
	for {
		f.mu.Lock()
		for len(f.queue) == 0 {
			f.cond.Wait()
		}
		item := f.queue[0]
		f.queue = f.queue[1:]
		lines := append([]func(string){}, f.lineHandlers...)
		exits := append([]func(*int){}, f.exitHandlers...)
		f.mu.Unlock()
		if item.exit {
			for _, handler := range exits {
				handler(item.code)
			}
			f.mu.Lock()
			f.delivered = true
			f.mu.Unlock()
			close(f.exited)
			return
		}
		for _, handler := range lines {
			handler(item.line)
		}
	}
}

// emit writes a raw chunk to stdout; line handlers see complete lines.
func (f *fakeProcess) emit(chunk string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.ended {
		return
	}
	f.pending += chunk
	lines := strings.Split(f.pending, "\n")
	f.pending = lines[len(lines)-1]
	for _, line := range lines[:len(lines)-1] {
		f.queue = append(f.queue, fakeItem{line: line})
	}
	f.cond.Signal()
}

// emitJSON emits one message as a line.
func (f *fakeProcess) emitJSON(message any) { f.emit(jsonText(message) + "\n") }

func (f *fakeProcess) emitStderr(chunk string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stderr += chunk
}

// end ends the process with the code (nil: no code) and signal; idempotent.
func (f *fakeProcess) end(code *int, signal string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.ended {
		return
	}
	f.ended = true
	f.exitCode = code
	f.signal = signal
	f.queue = append(f.queue, fakeItem{exit: true, code: code})
	f.cond.Signal()
}

func (f *fakeProcess) Write(text string) {
	f.mu.Lock()
	f.written = append(f.written, text)
	hook := f.onWrite
	f.mu.Unlock()
	if hook != nil {
		hook(text, f)
	}
}

func (f *fakeProcess) OnLine(handler func(string)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lineHandlers = append(f.lineHandlers, handler)
}

func (f *fakeProcess) OnExit(handler func(*int)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.delivered {
		code := f.exitCode
		go handler(code)
		return
	}
	f.exitHandlers = append(f.exitHandlers, handler)
}

func (f *fakeProcess) Kill() {
	f.mu.Lock()
	f.wasKilled = true
	hook := f.killHook
	f.mu.Unlock()
	if hook != nil {
		hook()
		return
	}
	f.end(nil, "")
}

func (f *fakeProcess) Exited() <-chan struct{} { return f.exited }

func (f *fakeProcess) Diagnostics() executable.Diagnostics {
	f.mu.Lock()
	defer f.mu.Unlock()
	return executable.Diagnostics{ExitCode: f.exitCode, Signal: f.signal, Stderr: f.stderr}
}

// Resources: a scripted process has no memory of its own to report.
func (f *fakeProcess) Resources() *executable.Resources { return nil }

func (f *fakeProcess) killed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.wasKilled
}

// writtenRecords is every stdin write parsed.
func (f *fakeProcess) writtenRecords() []jsonx.Record {
	f.mu.Lock()
	written := append([]string(nil), f.written...)
	f.mu.Unlock()
	var records []jsonx.Record
	for _, text := range written {
		if record := jsonx.ParseRecord([]byte(strings.TrimSpace(text))); record != nil {
			records = append(records, record)
		}
	}
	return records
}

// requests is every request (a written message with an id) the fake was sent.
func (f *fakeProcess) requests() []jsonx.Record {
	var requests []jsonx.Record
	for _, record := range f.writtenRecords() {
		if _, ok := record["id"]; ok {
			requests = append(requests, record)
		}
	}
	return requests
}

// rpcServer is a fake answering each request with serve's reply ({result} or
// {error}, or nil for no answer) and then its notifications.
func rpcServer(serve func(method string, params jsonx.Record, fake *fakeProcess) jsonx.Record) *fakeProcess {
	return newFakeProcess(func(text string, fake *fakeProcess) {
		message := jsonx.ParseRecord([]byte(text))
		id, ok := message["id"].(float64)
		method, isString := message["method"].(string)
		if !ok || !isString {
			return
		}
		params := jsonx.AsRecord(message["params"])
		if params == nil {
			params = jsonx.Record{}
		}
		reply := serve(method, params, fake)
		if reply == nil {
			return
		}
		answer := jsonx.Record{"id": id}
		for key, value := range reply {
			answer[key] = value
		}
		fake.emitJSON(answer)
	})
}

// spawnCall is one recorded spawnLineProcess call.
type spawnCall struct {
	command string
	args    []string
	options executable.LineOptions
}

// fakeSpawner replaces spawnLineProcess for the test (TS: vi.mock), handing
// out processes from next.
type fakeSpawner struct {
	mu    sync.Mutex
	calls []spawnCall
	next  func(index int) *fakeProcess
}

func useSpawner(t *testing.T, next func(index int) *fakeProcess) *fakeSpawner {
	t.Helper()
	spawner := &fakeSpawner{next: next}
	previous := spawnLineProcess
	spawnLineProcess = func(command string, args []string, options executable.LineOptions) (appServerProcess, error) {
		spawner.mu.Lock()
		index := len(spawner.calls)
		spawner.calls = append(spawner.calls, spawnCall{command: command, args: append([]string(nil), args...), options: options})
		spawner.mu.Unlock()
		return spawner.next(index), nil
	}
	t.Cleanup(func() { spawnLineProcess = previous })
	return spawner
}

// useFakes hands out the given fakes in order (the last again when they run out).
func useFakes(t *testing.T, fakes ...*fakeProcess) *fakeSpawner {
	t.Helper()
	return useSpawner(t, func(index int) *fakeProcess { return fakes[min(index, len(fakes)-1)] })
}

func (s *fakeSpawner) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.calls)
}

func (s *fakeSpawner) call(index int) spawnCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls[index]
}

var testInstallation = oar.AvailableInstallation{Via: "executable", Command: "codex", Version: "0.153.4"}

func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	return ctx
}

// eventually polls cond until it holds or the deadline passes.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func intPtr(value int) *int { return &value }

// lineSync waits until the session has handled every line emitted so far: a
// non-JSON marker line (which the client ignores) is emitted, and a line
// handler registered after the client's sees it only after the client
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

// notify emits a notification and waits until the session handled it (TS: synchronous fake delivery).
func (s *lineSync) notify(t *testing.T, method string, params jsonx.Record) {
	t.Helper()
	s.fake.emitJSON(jsonx.Record{"method": method, "params": params})
	s.wait(t)
}

// openSession opens a session on the spawner's fakes, disposing it at cleanup.
func openSession(t *testing.T, options oar.SessionOptions) (oar.Session, error) {
	t.Helper()
	if options.Cwd == "" {
		options.Cwd = "/work"
	}
	session, err := Session(testContext(t), testInstallation, options)
	if err == nil {
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			_ = session.Dispose(ctx)
		})
	}
	return session, err
}

func mustOpen(t *testing.T, options oar.SessionOptions) oar.Session {
	t.Helper()
	session, err := openSession(t, options)
	if err != nil {
		t.Fatal(err)
	}
	return session
}

func jsonOf(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func normalized(t *testing.T, text string) string {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		t.Fatalf("bad JSON %s: %v", text, err)
	}
	return jsonOf(t, value)
}

// sameJSON asserts got serializes to JSON equal to want (TS toEqual).
func sameJSON(t *testing.T, got any, want string) {
	t.Helper()
	if left, right := normalized(t, jsonOf(t, got)), normalized(t, want); left != right {
		t.Fatalf("got  %s\nwant %s", left, right)
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
	return jsonText(got) == jsonText(want)
}

// raw is a test value as raw JSON.
func raw(t *testing.T, value any) json.RawMessage {
	t.Helper()
	return json.RawMessage(jsonOf(t, value))
}

// frameEvents is every frame event of the commands, in order.
func frameEvents(commands []projectionCommand) []oar.EventBody {
	events := []oar.EventBody{}
	for _, command := range commands {
		if command.Kind == "frame" {
			events = append(events, command.Body.Events...)
		}
	}
	return events
}

// fold folds one notification given as a Go value.
func fold(t *testing.T, state codexProjectionState, method string, params any) (codexProjectionState, []projectionCommand) {
	t.Helper()
	return foldCodexNotification(state, method, raw(t, params))
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

func recordEvents(records []oar.RawEvent) []oar.EventBody {
	events := []oar.EventBody{}
	for _, record := range records {
		if record.Kind == oar.KindFrame {
			events = append(events, record.Frame.Events...)
		}
	}
	return events
}
