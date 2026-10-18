package bridge

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/oartest"
)

type heldSession struct {
	oar.Session
	entered, release, disposed chan struct{}
	once, disposeOnce          sync.Once
}

func (s *heldSession) RawEvents(observer oar.RawEventObserver, cursor *oar.Cursor) oar.Unsubscribe {
	return s.Session.RawEvents(func(record oar.RawEvent) {
		if record.Kind == oar.KindResponse && record.Response.Kind == oar.ResponseAccepted {
			s.once.Do(func() { close(s.entered); <-s.release })
		}
		observer(record)
	}, cursor)
}
func (s *heldSession) Dispose(ctx context.Context) error {
	err := s.Session.Dispose(ctx)
	s.disposeOnce.Do(func() { close(s.disposed) })
	return err
}

type rpcHarness struct {
	input    *io.PipeWriter
	messages chan map[string]any
	done     chan error
}

func newHarness(t *testing.T, runtime oar.Runtime) *rpcHarness {
	t.Helper()
	registry, err := oar.NewRuntimeRegistry(runtime)
	if err != nil {
		t.Fatal(err)
	}
	inputRead, input := io.Pipe()
	outputRead, output := io.Pipe()
	h := &rpcHarness{input: input, messages: make(chan map[string]any, 100), done: make(chan error, 1)}
	go func() { h.done <- Serve(context.Background(), registry, inputRead, output); output.Close() }()
	go func() {
		scan := bufio.NewScanner(outputRead)
		for scan.Scan() {
			var message map[string]any
			if json.Unmarshal(scan.Bytes(), &message) == nil {
				h.messages <- message
			}
		}
		close(h.messages)
	}()
	t.Cleanup(func() { input.Close(); outputRead.Close(); inputRead.Close() })
	return h
}
func (h *rpcHarness) send(t *testing.T, id int, method string, params any) {
	t.Helper()
	if err := json.NewEncoder(h.input).Encode(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		t.Fatal(err)
	}
}
func (h *rpcHarness) reply(t *testing.T, id int) (map[string]any, []map[string]any) {
	t.Helper()
	var events []map[string]any
	for {
		select {
		case msg := <-h.messages:
			if msg == nil {
				t.Fatal("RPC closed before reply")
			}
			if msg["id"] == float64(id) {
				return msg, events
			}
			events = append(events, msg)
		case <-time.After(3 * time.Second):
			t.Fatal("RPC reply timeout")
		}
	}
}
func TestRPCControlReplyFollowsRecordAndCloseOwnsDisposal(t *testing.T) {
	runtime := oartest.Runtime(oartest.Options{ID: "scripted", Turn: func(turn *oartest.Turn) error { turn.Say("hello"); return nil }})
	start := runtime.Session
	var child *heldSession
	runtime.Session = func(ctx context.Context, installation oar.AvailableInstallation, options oar.SessionOptions) (oar.Session, error) {
		real, err := start(ctx, installation, options)
		if err != nil {
			return nil, err
		}
		child = &heldSession{Session: real, entered: make(chan struct{}), release: make(chan struct{}), disposed: make(chan struct{})}
		return child, nil
	}
	h := newHarness(t, runtime)
	h.send(t, 1, "session.open", map[string]any{"runtime": "scripted", "installation": map[string]any{"via": "bundled"}, "options": map[string]any{"cwd": t.TempDir()}})
	opened, _ := h.reply(t, 1)
	handle := opened["result"].(map[string]any)["session"].(string)
	var release sync.Once
	defer release.Do(func() { close(child.release) })
	h.send(t, 2, "session.prompt", map[string]any{"session": handle, "input": "work"})
	select {
	case <-child.entered:
	case <-time.After(time.Second):
		t.Fatal("record not held")
	}
	// Notifications before the held response may arrive; a successful RPC reply must not.
	drain := time.NewTimer(30 * time.Millisecond)
waiting:
	for {
		select {
		case msg := <-h.messages:
			if msg["id"] == float64(2) {
				t.Fatal("reply overtook the response record")
			}
		case <-drain.C:
			break waiting
		}
	}
	release.Do(func() { close(child.release) })
	reply, events := h.reply(t, 2)
	if reply["error"] != nil {
		t.Fatal(reply)
	}
	result := reply["result"].(map[string]any)
	response := result["response"].(map[string]any)
	target := response["seq"].(float64)
	found := false
	for _, msg := range events {
		if msg["method"] == "session.record" {
			record := msg["params"].(map[string]any)["record"].(map[string]any)
			if record["seq"] == target {
				found = true
			}
		}
	}
	if !found {
		t.Fatalf("control response seq %v was not mirrored before reply", target)
	}
	h.send(t, 3, "session.close", map[string]any{"session": handle})
	closed, _ := h.reply(t, 3)
	if closed["error"] != nil {
		t.Fatal(closed)
	}
	select {
	case <-child.disposed:
	default:
		t.Fatal("close required a separate dispose RPC")
	}
	h.input.Close()
	select {
	case err := <-h.done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("bridge did not stop")
	}
}

type failedWriter struct{}

func (failedWriter) Write([]byte) (int, error) { return 0, errors.New("broken output") }
func TestServeReportsOutputFailure(t *testing.T) {
	registry, err := oar.NewRuntimeRegistry()
	if err != nil {
		t.Fatal(err)
	}
	inputRead, input := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- Serve(context.Background(), registry, inputRead, failedWriter{}) }()
	if err := json.NewEncoder(input).Encode(map[string]any{"id": 1, "method": "missing"}); err != nil {
		t.Fatal(err)
	}
	input.Close()
	select {
	case err := <-done:
		if err == nil || err.Error() != "broken output" {
			t.Fatalf("output error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("serve did not stop")
	}
}

func TestConnectionEOFReleasesAnOpenSession(t *testing.T) {
	runtime := oartest.Runtime(oartest.Options{ID: "scripted", Turn: func(turn *oartest.Turn) error { <-turn.Context.Done(); return nil }})
	start := runtime.Session
	var child *heldSession
	runtime.Session = func(ctx context.Context, installation oar.AvailableInstallation, options oar.SessionOptions) (oar.Session, error) {
		real, err := start(ctx, installation, options)
		if err != nil {
			return nil, err
		}
		release := make(chan struct{})
		close(release)
		child = &heldSession{Session: real, entered: make(chan struct{}), release: release, disposed: make(chan struct{})}
		return child, nil
	}
	h := newHarness(t, runtime)
	h.send(t, 1, "session.open", map[string]any{"runtime": "scripted", "installation": map[string]any{"via": "bundled"}, "options": map[string]any{"cwd": t.TempDir()}})
	opened, _ := h.reply(t, 1)
	handle := opened["result"].(map[string]any)["session"].(string)
	h.send(t, 2, "session.prompt", map[string]any{"session": handle, "input": "hang"})
	if reply, _ := h.reply(t, 2); reply["error"] != nil {
		t.Fatal(reply)
	}
	h.input.Close()
	select {
	case err := <-h.done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("EOF left the session running")
	}
	select {
	case <-child.disposed:
	default:
		t.Fatal("EOF did not own disposal")
	}
}
