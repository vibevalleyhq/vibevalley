package morph

import (
	"bufio"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
)

// Ported from tests/community/morph/morph-session.test.ts: a scripted
// Console Runtime API on a real loopback server (snapshots over a real
// WebSocket), each task answering its statuses one per query.

type fakeConsole struct {
	t        *testing.T
	server   *httptest.Server
	mu       sync.Mutex
	calls    []string
	bodies   []map[string]any
	statuses map[string][]string
	streams  map[string]chan string
	routes   map[string]func(map[string]any) (int, any)
	next     int
	released bool
}

func newFakeConsole(t *testing.T) *fakeConsole {
	f := &fakeConsole{t: t, statuses: map[string][]string{}, streams: map[string]chan string{}, routes: map[string]func(map[string]any) (int, any){}}
	f.server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeConsole) client() *Client {
	return NewClient(Endpoint{URL: f.server.URL + "/runtime", Token: "t"})
}

func (f *fakeConsole) serve(w http.ResponseWriter, r *http.Request) {
	route := strings.TrimPrefix(r.URL.Path, "/runtime")
	if route == "/stream/ws" {
		f.stream(w, r)
		return
	}
	var body map[string]any
	data, _ := io.ReadAll(r.Body)
	_ = json.Unmarshal(data, &body)
	f.mu.Lock()
	f.calls = append(f.calls, r.Method+" "+route)
	f.bodies = append(f.bodies, body)
	scripted := f.routes[r.Method+" "+route]
	f.mu.Unlock()
	status, answer := 404, any("not found")
	switch {
	case scripted != nil:
		status, answer = scripted(body)
	case r.Method == "POST" && route == "/topics":
		status, answer = 201, map[string]any{"id": "topic-1"}
	case r.Method == "PUT" && route == "/workspace":
		status, answer = 200, map[string]any{}
	case r.Method == "POST" && route == "/tasks":
		f.mu.Lock()
		f.next++
		id := fmt.Sprintf("task-%d", f.next)
		f.statuses[id] = []string{"running"}
		f.mu.Unlock()
		status, answer = 200, map[string]any{"id": id, "status": "queued", "topic_id": "topic-1"}
	case r.Method == "GET" && strings.HasPrefix(route, "/tasks/"):
		id := strings.TrimPrefix(route, "/tasks/")
		f.mu.Lock()
		queue := f.statuses[id]
		if len(queue) == 0 {
			queue = []string{"running"}
		}
		state := queue[0]
		if len(queue) > 1 {
			f.statuses[id] = queue[1:]
		}
		f.mu.Unlock()
		info := map[string]any{"id": id, "status": state, "topic_id": "topic-1"}
		if state == "done" {
			info["result"] = map[string]any{"final": map[string]any{"output": "answer"}}
		}
		status, answer = 200, info
	case r.Method == "POST" && strings.HasSuffix(route, "/stop"):
		id := strings.TrimSuffix(strings.TrimPrefix(route, "/tasks/"), "/stop")
		f.finish(id, "canceled")
		status, answer = 200, map[string]any{"found": true}
	case r.Method == "GET" && strings.HasSuffix(route, "/metadata"):
		status, answer = 200, map[string]any{"context": map[string]any{"available": true, "used_input_tokens": 100, "context_window_tokens": 1000, "usage_ratio": 0.1}}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(answer)
}

// stream upgrades to a WebSocket and forwards pushed snapshots as text frames.
func (f *fakeConsole) stream(w http.ResponseWriter, r *http.Request) {
	task := r.URL.Query().Get("task_id")
	conn, buffered, err := w.(http.Hijacker).Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	sum := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	fmt.Fprintf(buffered, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", base64.StdEncoding.EncodeToString(sum[:]))
	_ = buffered.Flush()
	frames := make(chan string, 16)
	f.mu.Lock()
	f.streams[task] = frames
	f.mu.Unlock()
	go func() { _, _ = io.Copy(io.Discard, bufio.NewReader(conn)) }()
	for frame := range frames {
		payload := []byte(frame)
		header := []byte{0x81}
		if len(payload) < 126 {
			header = append(header, byte(len(payload)))
		} else {
			header = append(header, 126, byte(len(payload)>>8), byte(len(payload)))
		}
		if _, err := conn.Write(append(header, payload...)); err != nil {
			return
		}
	}
}

func (f *fakeConsole) push(t *testing.T, task string, frame map[string]any) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		f.mu.Lock()
		stream := f.streams[task]
		f.mu.Unlock()
		if stream != nil {
			encoded, _ := json.Marshal(frame)
			stream <- string(encoded)
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("no stream for %s", task)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (f *fakeConsole) route(key string, handle func(map[string]any) (int, any)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.routes[key] = handle
}

func (f *fakeConsole) finish(task, status string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.statuses[task] = []string{status}
}

func (f *fakeConsole) sent() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var tasks []string
	for i, call := range f.calls {
		if call == "POST /tasks" {
			if task, ok := f.bodies[i]["task"].(string); ok {
				tasks = append(tasks, task)
			}
		}
	}
	return tasks
}

func (f *fakeConsole) called(call string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if c == call {
			return true
		}
	}
	return false
}

type fakeLease struct{ f *fakeConsole }

func (l fakeLease) Client() *Client { return l.f.client() }
func (fakeLease) Owned() bool       { return false }
func (fakeLease) OnExit(func(*int)) {}
func (l fakeLease) Release() (bool, *int) {
	l.f.mu.Lock()
	l.f.released = true
	l.f.mu.Unlock()
	return false, nil
}

func open(t *testing.T, f *fakeConsole, options oar.SessionOptions) (oar.Session, error) {
	if options.Cwd == "" {
		options.Cwd = "/work"
	}
	start := SessionWith(func(context.Context, string, string) (Lease, error) { return fakeLease{f}, nil })
	session, err := start(context.Background(), oar.AvailableInstallation{Via: "executable", Command: "morph"}, options)
	if err == nil {
		t.Cleanup(func() { _ = session.Dispose(context.Background()) })
	}
	return session, err
}

func answerOf(outcome oar.ControlOutcome) string {
	if outcome.IsAccepted() {
		return "accepted"
	}
	return string(outcome.Code)
}

func waitFor(t *testing.T, what string, done func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !done() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func idle(session oar.Session) func() bool {
	return func() bool { return !session.Status().Value.IsRunning() }
}

func TestOpenCreatesTheTopicAndAttachesCwd(t *testing.T) {
	f := newFakeConsole(t)
	session, err := open(t, f, oar.SessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if session.ID() != "topic-1" || strings.Join(f.calls, ",") != "POST /topics,PUT /workspace" {
		t.Fatal(session.ID(), f.calls)
	}
	if f.bodies[1]["workspace_dir"] != "/work" || f.bodies[1]["topic_id"] != "topic-1" {
		t.Fatal(f.bodies[1])
	}
	encoded, _ := json.Marshal(session.Capabilities())
	if string(encoded) != `{"queue":{"durable":false},"attribution":"opaque","images":false}` {
		t.Fatal(string(encoded))
	}
}

func TestATurnEndsWithTheTerminalTaskAnswerAndContextUsage(t *testing.T) {
	f := newFakeConsole(t)
	session, _ := open(t, f, oar.SessionOptions{})
	ctx := context.Background()
	if got := answerOf(must(session.Prompt(ctx, "hi", oar.InputOptions{}))); got != "accepted" {
		t.Fatal(got)
	}
	f.push(t, "task-1", map[string]any{"task_id": "task-1", "status": "running", "text": "ans"})
	waitFor(t, "a frame", func() bool { return len(session.Records()) > 3 })
	if got := answerOf(must(session.Prompt(ctx, "again", oar.InputOptions{}))); got != "busy" {
		t.Fatal(got)
	}
	f.finish("task-1", "done")
	waitFor(t, "the turn end", idle(session))
	if usage := session.ContextUsage().Value; usage == nil || *usage.Percent != 10 {
		t.Fatal(usage)
	}
	var text strings.Builder
	for _, record := range session.Records() {
		for _, event := range record.Frame.Events {
			if delta, ok := event.(oar.TextDelta); ok {
				text.WriteString(delta.Text)
			}
		}
	}
	if text.String() != "answer" {
		t.Fatalf("text = %q", text.String())
	}
}

func must(outcome oar.ControlOutcome, err error) oar.ControlOutcome {
	if err != nil {
		panic(err)
	}
	return outcome
}

func TestSteerAndAbort(t *testing.T) {
	f := newFakeConsole(t)
	session, _ := open(t, f, oar.SessionOptions{})
	ctx := context.Background()
	if got := answerOf(must(session.Steer(ctx, "early", oar.InputOptions{}))); got != "no_active_turn" {
		t.Fatal(got)
	}
	if got := answerOf(must(session.Abort(ctx))); got != "no_active_turn" {
		t.Fatal(got)
	}
	must(session.Prompt(ctx, "work", oar.InputOptions{}))
	f.route("POST /tasks", func(map[string]any) (int, any) {
		return 200, map[string]any{"id": "ack-1", "status": "done", "steer_target_task_id": "task-1"}
	})
	if got := answerOf(must(session.Steer(ctx, "more", oar.InputOptions{}))); got != "accepted" {
		t.Fatal(got)
	}
	f.route("POST /tasks", func(map[string]any) (int, any) { return 200, map[string]any{"id": "ack-2", "status": "done"} })
	if got := answerOf(must(session.Steer(ctx, "lost", oar.InputOptions{}))); got != "runtime_refused" {
		t.Fatal(got)
	}
	if got := answerOf(must(session.Abort(ctx))); got != "accepted" || !f.called("POST /tasks/task-1/stop") {
		t.Fatal(got)
	}
	waitFor(t, "the aborted end", idle(session))
	last := session.Status().Value.LastTurnOutcome
	if last == nil || last.Kind != "aborted" {
		t.Fatal(last)
	}
}

func TestQueueIsHeldWithdrawableAndSentWhenIdle(t *testing.T) {
	f := newFakeConsole(t)
	session, _ := open(t, f, oar.SessionOptions{})
	ctx := context.Background()
	must(session.Prompt(ctx, "first", oar.InputOptions{}))
	if got := answerOf(must(session.Queue(ctx, "second", oar.InputOptions{}))); got != "accepted" {
		t.Fatal(got)
	}
	withdrawn := must(session.Queue(ctx, "withdrawn", oar.InputOptions{InputID: "8f0c3d1e-0000-4000-8000-000000000003"}))
	if got := answerOf(must(session.Withdraw(ctx, withdrawn.Request.Request.InputID))); got != "accepted" {
		t.Fatal(got)
	}
	f.finish("task-1", "done")
	waitFor(t, "the queued input", func() bool { return len(f.sent()) == 2 })
	if got := strings.Join(f.sent(), ","); got != "first,second" {
		t.Fatal(got)
	}
}

func TestAnApprovalIsRecordedAndApproved(t *testing.T) {
	f := newFakeConsole(t)
	approvals := 0
	f.route("GET /approvals/apr-1", func(map[string]any) (int, any) { return 200, map[string]any{"id": "apr-1", "tool": "bash"} })
	f.route("POST /approvals/apr-1/approve", func(map[string]any) (int, any) {
		approvals++
		f.finish("task-1", "done")
		return 200, map[string]any{"ok": true}
	})
	f.route("GET /tasks/task-1", func(map[string]any) (int, any) {
		f.mu.Lock()
		state := f.statuses["task-1"][0]
		f.mu.Unlock()
		if state == "done" {
			return 200, map[string]any{"id": "task-1", "status": "done"}
		}
		return 200, map[string]any{"id": "task-1", "status": "pending", "approval_request_id": "apr-1"}
	})
	session, _ := open(t, f, oar.SessionOptions{})
	must(session.Prompt(context.Background(), "go", oar.InputOptions{}))
	waitFor(t, "the turn end", idle(session))
	var kinds []string
	for _, record := range session.Records() {
		if record.Kind == oar.KindRequest && record.Direction == oar.ToApp {
			kinds = append(kinds, "request:"+record.ID)
		}
		if record.Kind == oar.KindResponse && record.Response.Kind == oar.ResponseAnswered {
			kinds = append(kinds, "answered:"+record.RequestID)
		}
	}
	if strings.Join(kinds, ",") != "request:apr-1,answered:apr-1" || approvals != 1 {
		t.Fatal(kinds, approvals)
	}
}

func TestDisposeStopsWorkAndReleasesTheConsole(t *testing.T) {
	f := newFakeConsole(t)
	session, _ := open(t, f, oar.SessionOptions{})
	ctx := context.Background()
	must(session.Prompt(ctx, "work", oar.InputOptions{}))
	if err := session.Dispose(ctx); err != nil {
		t.Fatal(err)
	}
	if !f.called("POST /tasks/task-1/stop") || !f.released {
		t.Fatal(f.calls)
	}
	records := session.Records()
	last := records[len(records)-1]
	if last.Kind != oar.KindResponse || last.Response.Kind != oar.ResponseAccepted {
		t.Fatalf("%+v", last)
	}
	if got := answerOf(must(session.Prompt(ctx, "after", oar.InputOptions{}))); got != "disposed" {
		t.Fatal(got)
	}
}

func TestResumeAndRefusalsAndProfiles(t *testing.T) {
	f := newFakeConsole(t)
	f.route("GET /topics/topic-7", func(map[string]any) (int, any) { return 200, map[string]any{"id": "topic-7"} })
	session, err := open(t, f, oar.SessionOptions{Resume: "topic-7", Cwd: "/elsewhere"})
	if err != nil || session.ID() != "topic-7" || f.bodies[len(f.bodies)-1]["workspace_dir"] != "/elsewhere" {
		t.Fatal(err)
	}
	if _, err := open(t, newFakeConsole(t), oar.SessionOptions{Resume: "missing"}); err == nil || err.Error() != "morph has no topic missing to resume" {
		t.Fatal(err)
	}
	var unsupported *oar.UnsupportedOptionError
	if _, err := open(t, newFakeConsole(t), oar.SessionOptions{SystemPrompt: oar.String("x")}); !errors.As(err, &unsupported) {
		t.Fatal(err)
	}
	if _, err := open(t, newFakeConsole(t), oar.SessionOptions{LaunchArgs: []string{"--flag"}}); !errors.As(err, &unsupported) || unsupported.Option != "launchArgs" {
		t.Fatal(err)
	}
	if _, err := open(t, newFakeConsole(t), oar.SessionOptions{Effort: "high"}); err == nil || !strings.Contains(err.Error(), "effort high") {
		t.Fatal(err)
	}
	old := newFakeConsole(t)
	old.route("POST /topics", func(map[string]any) (int, any) { return 405, "method not allowed" })
	if _, err := open(t, old, oar.SessionOptions{}); err == nil || !strings.Contains(err.Error(), "POST /topics") {
		t.Fatal(err)
	}
	profiles := newFakeConsole(t)
	profiles.route("GET /llm/profiles", func(map[string]any) (int, any) {
		return 200, map[string]any{"default": map[string]any{"name": "default", "model": "gpt"}, "items": []any{map[string]any{"name": "codex", "model": "gpt-codex"}}}
	})
	withModel, err := open(t, profiles, oar.SessionOptions{Model: "codex"})
	if err != nil {
		t.Fatal(err)
	}
	must(withModel.Prompt(context.Background(), "hi", oar.InputOptions{}))
	if profiles.bodies[len(profiles.bodies)-1]["llm_profile"] != "codex" {
		t.Fatal(profiles.bodies)
	}
	if _, err := open(t, profiles, oar.SessionOptions{Model: "nope"}); err == nil || err.Error() != "morph has no LLM profile nope (configured: default, codex)" {
		t.Fatal(err)
	}
}
