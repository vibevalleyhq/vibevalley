package claude

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// fakeProcess is the Go port of tests/fixtures/fake-line-process.ts: a
// scripted claude process. Lines and the exit are delivered on the fake's
// own goroutine, in order, the exit after every line emitted before it, as
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
	exitCode     *int
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

// emitJSON emits one frame as a line.
func (f *fakeProcess) emitJSON(frame any) { f.emit(jsonText(frame) + "\n") }

// end ends the process with the code (nil: a signal); idempotent.
func (f *fakeProcess) end(code *int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.ended {
		return
	}
	f.ended = true
	f.exitCode = code
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
	f.mu.Unlock()
	f.end(nil)
}

func (f *fakeProcess) Exited() <-chan struct{} { return f.exited }

// Resources: a scripted process has no memory of its own to report.
func (f *fakeProcess) Resources() *executable.Resources { return nil }

func (f *fakeProcess) killed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.wasKilled
}

// writes is a snapshot of everything written to stdin.
func (f *fakeProcess) writes() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.written...)
}

// writtenRecords is every stdin write parsed.
func (f *fakeProcess) writtenRecords() []jsonx.Record {
	var records []jsonx.Record
	for _, text := range f.writes() {
		if record := jsonx.ParseRecord([]byte(strings.TrimSpace(text))); record != nil {
			records = append(records, record)
		}
	}
	return records
}

// spawnCall is one recorded spawnLineProcess call.
type spawnCall struct {
	command string
	args    []string
	options executable.LineOptions
}

// fakeSpawner replaces spawnLineProcess for the test (TS: vi.mock), handing
// out the given processes in order (the last one again when they run out).
type fakeSpawner struct {
	mu    sync.Mutex
	calls []spawnCall
	fakes []*fakeProcess
	next  int
}

func useFakeSpawner(t *testing.T, fakes ...*fakeProcess) *fakeSpawner {
	t.Helper()
	spawner := &fakeSpawner{fakes: fakes}
	previous := spawnLineProcess
	spawnLineProcess = func(command string, args []string, options executable.LineOptions) (claudeProcess, error) {
		spawner.mu.Lock()
		defer spawner.mu.Unlock()
		spawner.calls = append(spawner.calls, spawnCall{command: command, args: append([]string(nil), args...), options: options})
		fake := spawner.fakes[min(spawner.next, len(spawner.fakes)-1)]
		spawner.next++
		return fake, nil
	}
	t.Cleanup(func() { spawnLineProcess = previous })
	return spawner
}

func (s *fakeSpawner) call(index int) spawnCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls[index]
}

func (s *fakeSpawner) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.calls)
}

// envOf reads a variable from a recorded environment; ok false when unset.
func envOf(env []string, name string) (string, bool) {
	value := ""
	found := false
	for _, entry := range env {
		key, rest, _ := strings.Cut(entry, "=")
		if key == name {
			value, found = rest, true
		}
	}
	return value, found
}

var testInstallation = oar.AvailableInstallation{Via: "executable", Command: "claude", Version: "2.1.273"}

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
