package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
	"vibevalley/pkg/smith/observe"

	"vibevalley/pkg/smith/agents"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/oartest"
)

// Ported from tests/cli-progress.test.ts and tests/cli-mcp.test.ts.

var seq int64

func at(receivedAt int64, path []string, bodies ...oar.EventBody) []oar.Event {
	seq++
	events := make([]oar.Event, 0, len(bodies))
	for _, body := range bodies {
		events = append(events, oar.Event{Envelope: oar.Envelope{SessionID: "s-1", AgentPath: path, Seq: seq, ReceivedAt: receivedAt}, Body: body})
	}
	return events
}

func renderAll(runtime string) func([]oar.Event) []string {
	render := observe.ProgressRenderer(runtime)
	return func(events []oar.Event) []string {
		lines := []string{}
		for _, event := range events {
			lines = append(lines, render(event)...)
		}
		return lines
	}
}

func expectLines(t *testing.T, got []string, want ...string) {
	t.Helper()
	if want == nil {
		want = []string{}
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestProgressPrintsNothingForQuietEvents(t *testing.T) {
	render := renderAll("claude")
	expectLines(t, render(at(0, nil, oar.TurnStarted{RequestID: "r", Input: "hi"})))
	expectLines(t, render(at(1, nil, oar.TextDelta{Text: ""})))
	expectLines(t, render(at(2, nil, oar.Reasoning{Content: oar.ReasoningContent{Kind: "redacted"}})))
	expectLines(t, render(at(3, nil, oar.Reasoning{Content: oar.ReasoningContent{Kind: "empty"}})))
	expectLines(t, render(at(4, nil, oar.Reasoning{Content: oar.ReasoningContent{Kind: "text"}})))
	expectLines(t, render(at(5, nil, oar.Model{Model: "m"}, oar.Usage{})))
	expectLines(t, render(at(6, nil, oar.Effort{Effort: "high"})))
}

func TestRenderOpened(t *testing.T) {
	model, low, high, tier := "gpt-5.5", "low", "high", "priority"
	for _, c := range []struct {
		opened observe.OpenedSession
		want   string
	}{
		{observe.OpenedSession{SessionID: "t-1", Model: &model, Effort: &low}, "[session t-1 · model gpt-5.5 · effort low]"},
		{observe.OpenedSession{SessionID: "t-1", Resumed: true, Model: &model, Effort: &high}, "[resumed t-1 · model gpt-5.5 · effort high]"},
		{observe.OpenedSession{SessionID: "c-1"}, "[session c-1]"},
		{observe.OpenedSession{SessionID: "t", ServiceTier: &tier}, "[session t · tier priority]"},
	} {
		if got := observe.RenderOpened(c.opened); got != c.want {
			t.Fatalf("got %q, want %q", got, c.want)
		}
	}
}

func TestProgressTextThinkingAndTools(t *testing.T) {
	render := renderAll("claude")
	expectLines(t, render(at(0, nil, oar.TextDelta{Text: "The answer is 4."})), "The answer is 4.")
	expectLines(t, render(at(1, nil, oar.Reasoning{Content: oar.ReasoningContent{Kind: "text", Text: "2 + 2..."}}, oar.TextDelta{Text: "4"})), "[thinking] 2 + 2...", "4")
	bash := `{"command":"echo hi"}`
	expectLines(t, render(at(1000, nil, oar.ToolCallStarted{CallID: "c1", Tool: "Bash", Input: &bash})), "[Running command] echo hi")
	expectLines(t, render(at(3500, nil, oar.ToolCallEnded{CallID: "c1"})), "[Ran command] (2.5s)")

	codex := renderAll("codex")
	expectLines(t, codex(at(0, nil, oar.ToolCallStarted{CallID: "c1", Tool: "webSearch"})), "[Searching the web]")
	expectLines(t, codex(at(100, nil, oar.ToolCallEnded{CallID: "never-started"})), "[Done]")

	later := renderAll("claude")
	described := `{"command":"echo hi","description":"Say hi"}`
	expectLines(t, later(at(0, nil, oar.ToolCallStarted{CallID: "c1", Tool: "Bash"})), "[Running command]")
	expectLines(t, later(at(10, nil, oar.ToolCallInput{CallID: "c1", Input: bash})), "[Running command] echo hi")
	expectLines(t, later(at(20, nil, oar.ToolCallInput{CallID: "c1", Input: described})))
	expectLines(t, later(at(30, nil, oar.ToolCallInput{CallID: "c9", Input: bash})))
	expectLines(t, later(at(1000, nil, oar.ToolCallEnded{CallID: "c1"})), "[Ran command] (1.0s)")

	agents := renderAll("claude")
	expectLines(t, agents(at(0, []string{"task-1"}, oar.ToolCallStarted{CallID: "c1", Tool: "Read"})), "[task-1] [Reading file]")
	expectLines(t, agents(at(0, nil, oar.ToolCallStarted{CallID: "c1", Tool: "Bash"})), "[Running command]")
	expectLines(t, agents(at(500, []string{"task-1"}, oar.ToolCallEnded{CallID: "c1"})), "[task-1] [Read file] (0.5s)")
	expectLines(t, agents(at(1000, nil, oar.ToolCallEnded{CallID: "c1"})), "[Ran command] (1.0s)")
}

func TestProgressOutcomesAndMetaLines(t *testing.T) {
	if got := observe.RenderOutcome(oar.Failed(oar.FailureQuota, "credit balance too low")); got != "[turn failed: quota] credit balance too low" {
		t.Fatal(got)
	}
	render := renderAll("claude")
	expectLines(t, render(at(0, nil, oar.TurnEnded{Outcome: oar.Completed()})), "[turn completed]")
	expectLines(t, render(at(0, nil, oar.ControlRejected{RequestID: "r", Action: "steer", Code: "no_active_turn", Reason: "not_steerable"})), "[steer rejected] not_steerable")
	code := 143
	expectLines(t, render(at(0, nil, oar.Exited{Code: &code})), "[runtime exited: 143]")
	pi := renderAll("pi")
	expectLines(t, pi(at(0, nil, oar.CompactionStarted{Trigger: "threshold"})), "[compacting: threshold]")
	expectLines(t, pi(at(0, nil, oar.CompactionEnded{Outcome: "completed", Trigger: "manual"})), "[compacted]")
	expectLines(t, pi(at(0, nil, oar.CompactionEnded{Outcome: "failed", Reason: "boom"})), "[compaction failed] boom")
	three := 3
	expectLines(t, pi(at(0, nil, oar.Retry{Attempt: 2, MaxAttempts: &three, Reason: "overloaded"})), "[retry 2/3] overloaded")
	expectLines(t, pi(at(0, nil, oar.AppRequest{RequestID: "p", Type: "can_use_tool"})), "[waiting for app: can_use_tool]")
	expectLines(t, pi(at(0, nil, oar.AppRequestCancelled{RequestID: "p"})), "[runtime withdrew its request]")
	x := "x"
	expectLines(t, pi(at(0, nil, oar.ToolCallProgress{CallID: "c", Output: &x}, oar.AppAnswered{RequestID: "p"})))
}

// ─── oar mcp ───────────────────────────────────────────────────────────────

type gate struct {
	mu      sync.Mutex
	permits int
	waiting []chan struct{}
	started int
}

func (g *gate) script(turn *oartest.Turn) error {
	g.mu.Lock()
	g.started++
	g.mu.Unlock()
	turn.Say("working on " + turn.Input)
	g.mu.Lock()
	if g.permits > 0 {
		g.permits--
		g.mu.Unlock()
	} else {
		wait := make(chan struct{})
		g.waiting = append(g.waiting, wait)
		g.mu.Unlock()
		select {
		case <-wait:
		case <-turn.Context.Done():
			return nil
		}
	}
	turn.Say(" steered: " + strings.Join(turn.Steered(), "|"))
	return nil
}

func (g *gate) release() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.waiting) == 0 {
		g.permits++
		return
	}
	close(g.waiting[0])
	g.waiting = g.waiting[1:]
}

func (g *gate) startedCount() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.started
}

func echo(turn *oartest.Turn) error {
	turn.Say("did: " + turn.Input)
	return nil
}

type client struct {
	t       *testing.T
	input   *io.PipeWriter
	mu      sync.Mutex
	next    int
	answers map[int]chan map[string]any
	served  chan struct{}
}

func connect(t *testing.T, script func(*oartest.Turn) error) *client {
	t.Helper()
	registry, _ := oar.NewRuntimeRegistry(oartest.Runtime(oartest.Options{ID: "fake", Turn: script}))
	crew := agents.New(agents.Options{Runtimes: registry})
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	server := &mcpServer{tools: subagentTools(crew, nil), crew: crew, out: outW}
	c := &client{t: t, input: inW, answers: map[int]chan map[string]any{}, served: make(chan struct{})}
	go func() {
		server.serve(context.Background(), inR)
		_ = crew.Close(context.Background())
		close(c.served)
	}()
	go func() {
		scanner := bufio.NewScanner(outR)
		scanner.Buffer(make([]byte, 1024*1024), 16*1024*1024)
		for scanner.Scan() {
			var message map[string]any
			if json.Unmarshal(scanner.Bytes(), &message) != nil {
				continue
			}
			id, ok := message["id"].(float64)
			if !ok {
				continue
			}
			c.mu.Lock()
			answer := c.answers[int(id)]
			c.mu.Unlock()
			if answer != nil {
				answer <- message
			}
		}
	}()
	return c
}

func (c *client) request(method string, params map[string]any) (int, chan map[string]any) {
	c.mu.Lock()
	c.next++
	id := c.next
	answer := make(chan map[string]any, 1)
	c.answers[id] = answer
	c.mu.Unlock()
	line, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	_, _ = c.input.Write(append(line, '\n'))
	return id, answer
}

func (c *client) call(method string, params map[string]any) map[string]any {
	_, answer := c.request(method, params)
	select {
	case message := <-answer:
		return message
	case <-time.After(10 * time.Second):
		c.t.Fatalf("no answer to %s", method)
		return nil
	}
}

type toolResult struct {
	text       string
	isError    bool
	structured any
}

func (c *client) tool(name string, args map[string]any) toolResult {
	answer := c.call("tools/call", map[string]any{"name": name, "arguments": args})
	result, _ := answer["result"].(map[string]any)
	content, _ := result["content"].([]any)
	text := ""
	if len(content) > 0 {
		text, _ = content[0].(map[string]any)["text"].(string)
	}
	isError, _ := result["isError"].(bool)
	return toolResult{text: text, isError: isError, structured: result["structuredContent"]}
}

func (c *client) end() {
	_ = c.input.Close()
	select {
	case <-c.served:
	case <-time.After(30 * time.Second):
		c.t.Fatal("the server did not finish")
	}
}

func TestMCPInitializeListsTools(t *testing.T) {
	c := connect(t, echo)
	initialized := c.call("initialize", map[string]any{"protocolVersion": "2025-06-18"})
	result := initialized["result"].(map[string]any)
	if result["protocolVersion"] != "2025-06-18" || result["serverInfo"].(map[string]any)["name"] != "oar" {
		t.Fatal(result)
	}
	listed, _ := json.Marshal(c.call("tools/list", nil)["result"])
	for _, want := range []string{`"name":"run"`, `"name":"wait"`, `"name":"list"`, `"required":["reports"]`, `"required":["agents","unread"]`} {
		if !strings.Contains(string(listed), want) {
			t.Fatalf("tools/list lacks %s", want)
		}
	}
	missing := c.call("no/such", nil)
	if missing["error"].(map[string]any)["code"].(float64) != -32601 {
		t.Fatal(missing)
	}
	c.end()
}

func TestMCPRunReturnsTheReport(t *testing.T) {
	c := connect(t, echo)
	reply := c.tool("run", map[string]any{"runtime": "fake", "task": "list files", "name": "reviewer"})
	report, _ := reply.structured.(map[string]any)
	if reply.isError || report["id"] != "reviewer" || report["text"] != "did: list files" || report["turn"].(float64) != 1 || report["outcome"].(map[string]any)["kind"] != "completed" {
		t.Fatal(reply)
	}
	var parsed any
	_ = json.Unmarshal([]byte(reply.text), &parsed)
	if !reflect.DeepEqual(parsed, reply.structured) {
		t.Fatal("the text and the structured content differ")
	}
	c.end()
}

func TestMCPRunKeepsAFailedTurnsPartialText(t *testing.T) {
	c := connect(t, func(turn *oartest.Turn) error {
		turn.Say("partial work")
		return errNative
	})
	reply := c.tool("run", map[string]any{"runtime": "fake", "task": "fail"})
	report := reply.structured.(map[string]any)
	outcome := report["outcome"].(map[string]any)
	if reply.isError || report["text"] != "partial work" || outcome["failure"] != "unknown" || outcome["reason"] != "native failure" {
		t.Fatal(reply)
	}
	c.end()
}

type nativeError struct{}

func (nativeError) Error() string { return "native failure" }

var errNative = nativeError{}

func TestMCPUnreadReportsAreNamedUntilWaitReadsThem(t *testing.T) {
	c := connect(t, echo)
	if spawned := c.tool("spawn", map[string]any{"runtime": "fake", "task": "a", "name": "alpha"}); !strings.Contains(spawned.text, `"id": "alpha"`) {
		t.Fatal(spawned)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		list := c.tool("list", nil).structured.(map[string]any)
		if unread := list["unread"].([]any); len(unread) == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no unread report")
		}
		time.Sleep(20 * time.Millisecond)
	}
	wait := c.tool("wait", map[string]any{"timeoutMs": 1000})
	reports := wait.structured.(map[string]any)["reports"].([]any)
	if len(reports) != 1 || reports[0].(map[string]any)["text"] != "did: a" {
		t.Fatal(wait)
	}
	if unread := c.tool("list", nil).structured.(map[string]any)["unread"].([]any); len(unread) != 0 {
		t.Fatal(unread)
	}
	empty := c.tool("wait", map[string]any{"timeoutMs": 0})
	if encoded, _ := json.Marshal(empty.structured); string(encoded) != `{"reports":[]}` {
		t.Fatal(string(encoded))
	}
	c.end()
}

func TestMCPRefusalsAndBadInputAreToolErrors(t *testing.T) {
	c := connect(t, echo)
	refused := c.tool("run", map[string]any{"runtime": "missing", "task": "x"})
	if !refused.isError || refused.structured.(map[string]any)["code"] != "unknown_runtime" {
		t.Fatal(refused)
	}
	if reply := c.tool("send", map[string]any{"id": "nobody", "message": "hi"}); !reply.isError || reply.text != "no subagent nobody; the list tool names them" {
		t.Fatal(reply)
	}
	if reply := c.tool("spawn", map[string]any{"runtime": "fake"}); !reply.isError || reply.text != "task is required" {
		t.Fatal(reply)
	}
	c.end()
}

func TestMCPClosingARunningAgentReturnsItsAbortedReport(t *testing.T) {
	g := &gate{}
	c := connect(t, g.script)
	done := make(chan toolResult, 1)
	go func() { done <- c.tool("run", map[string]any{"runtime": "fake", "task": "slow", "name": "closing"}) }()
	for g.startedCount() < 1 {
		time.Sleep(10 * time.Millisecond)
	}
	c.tool("close", map[string]any{"id": "closing"})
	reply := <-done
	report := reply.structured.(map[string]any)
	if report["outcome"].(map[string]any)["kind"] != "aborted" || report["text"] != "working on slow" {
		t.Fatal(reply)
	}
	c.end()
}

func TestMCPCancelledRunGetsNoAnswerAndLeavesItsReport(t *testing.T) {
	g := &gate{}
	c := connect(t, g.script)
	id, answer := c.request("tools/call", map[string]any{"name": "run", "arguments": map[string]any{"runtime": "fake", "task": "slow", "name": "slow"}})
	for g.startedCount() < 1 {
		time.Sleep(10 * time.Millisecond)
	}
	line, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "notifications/cancelled", "params": map[string]any{"requestId": id}})
	_, _ = c.input.Write(append(line, '\n'))
	time.Sleep(50 * time.Millisecond)
	g.release()
	if wait := c.tool("wait", map[string]any{"timeoutMs": 5000}); !strings.Contains(wait.text, `"id": "slow"`) {
		t.Fatal(wait)
	}
	select {
	case message := <-answer:
		t.Fatalf("a cancelled call was answered: %v", message)
	case <-time.After(100 * time.Millisecond):
	}
	c.end()
}

func TestMCPFinishesWhenInputEndsWithARunPending(t *testing.T) {
	g := &gate{}
	c := connect(t, g.script)
	c.request("tools/call", map[string]any{"name": "run", "arguments": map[string]any{"runtime": "fake", "task": "never ends"}})
	for g.startedCount() < 1 {
		time.Sleep(10 * time.Millisecond)
	}
	c.end()
}

func TestRenderModelsAndUpgrade(t *testing.T) {
	result := oar.ListModelsResult{Kind: "ok", Models: []oar.ModelEntry{{ID: "gpt", ResolvedID: "gpt-5", DisplayName: "GPT", EffortLevels: []string{"low", "high"}, DefaultEffort: "high", Default: true}}}
	expectLines(t, renderModels(modelsReport{RuntimeID: "codex", Models: &result}), `codex	gpt -> gpt-5 "GPT" [low,high*] (default)`)
	snapshot := oar.InstallationSnapshot{Kind: "not_found"}
	expectLines(t, renderModels(modelsReport{RuntimeID: "x", Installation: &snapshot}), "x: not available (not_found)")
	check := oar.UpdateCheck{Kind: "ok", Installed: "1.0.0", Latest: "1.1.0", UpdateAvailable: true, Source: "npm"}
	expectLines(t, renderUpgradeReport(upgradeReport{RuntimeID: "claude", Check: &check}), "claude\t1.0.0 -> 1.1.0 available (npm)")
}
