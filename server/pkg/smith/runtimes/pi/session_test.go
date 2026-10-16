package pi

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// A fake `pi --mode rpc` (the test binary re-executed with OAR_FAKE_PI=1),
// scripted enough for the adapter's control paths: a prompt answers
// "started", emits agent_start after OAR_FAKE_PI_START_MS, then text and
// agent_settled after the turn delay ("slow" prompts run long); abort settles
// the run aborted. Every prompt it receives is logged to OAR_FAKE_PI_LOG.

func TestMain(m *testing.M) {
	if os.Getenv("OAR_FAKE_PI") == "1" {
		fakePi()
		return
	}
	os.Exit(m.Run())
}

func fakePi() {
	out := bufio.NewWriter(os.Stdout)
	var mu sync.Mutex
	emit := func(record map[string]any) {
		encoded, _ := json.Marshal(record)
		mu.Lock()
		defer mu.Unlock()
		_, _ = out.Write(append(encoded, '\n'))
		_ = out.Flush()
	}
	logFile := os.Getenv("OAR_FAKE_PI_LOG")
	startDelay := 0 * time.Millisecond
	if value := os.Getenv("OAR_FAKE_PI_START_MS"); value != "" {
		var ms int
		fmt.Sscan(value, &ms)
		startDelay = time.Duration(ms) * time.Millisecond
	}
	var runMu sync.Mutex
	var cancel chan struct{}
	running := false
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var command map[string]any
		if json.Unmarshal(scanner.Bytes(), &command) != nil {
			continue
		}
		id, _ := command["id"].(string)
		respond := func(data any, success bool, errText string) {
			record := map[string]any{"id": id, "type": "response", "command": command["type"], "success": success}
			if data != nil {
				record["data"] = data
			}
			if errText != "" {
				record["error"] = errText
			}
			emit(record)
		}
		switch command["type"] {
		case "open":
			respond(map[string]any{"sessionId": "fake-session", "model": "fake/fake-1", "thinkingLevel": "off"}, true, "")
		case "dispose":
			respond(nil, true, "")
			os.Exit(0)
		case "get_state":
			respond(map[string]any{"model": map[string]any{"provider": "fake", "id": "fake-1"}, "thinkingLevel": "off", "sessionId": "x"}, true, "")
		case "get_available_models":
			respond(map[string]any{"models": []any{map[string]any{"provider": "fake", "id": "fake-1"}}}, true, "")
		case "get_session_stats":
			respond(map[string]any{"contextUsage": map[string]any{"tokens": 10, "contextWindow": 1000, "percent": 1}}, true, "")
		case "prompt":
			message, _ := command["message"].(string)
			if logFile != "" {
				file, _ := os.OpenFile(logFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
				fmt.Fprintln(file, message)
				file.Close()
			}
			runMu.Lock()
			if running {
				runMu.Unlock()
				respond(nil, false, "Agent is already processing.")
				continue
			}
			running = true
			stop := make(chan struct{})
			cancel = stop
			runMu.Unlock()
			respond(map[string]any{"disposition": "started"}, true, "")
			go func() {
				time.Sleep(startDelay)
				emit(map[string]any{"type": "agent_start"})
				turn := 30 * time.Millisecond
				if strings.Contains(message, "slow") {
					turn = 600 * time.Millisecond
				}
				aborted := false
				select {
				case <-time.After(turn):
				case <-stop:
					aborted = true
				}
				if !aborted {
					emit(map[string]any{"type": "message_update", "assistantMessageEvent": map[string]any{"type": "text_delta", "delta": "echo:" + message}})
				}
				runMu.Lock()
				running = false
				runMu.Unlock()
				emit(map[string]any{"type": "oar_context", "usage": map[string]any{"tokens": 10, "contextWindow": 1000, "percent": 1}})
				emit(map[string]any{"type": "agent_settled", "aborted": aborted})
			}()
		case "abort":
			runMu.Lock()
			if cancel != nil && running {
				close(cancel)
				cancel = nil
			}
			runMu.Unlock()
			time.Sleep(50 * time.Millisecond)
			respond(nil, true, "")
		default:
			respond(nil, true, "")
		}
	}
}

func openFake(t *testing.T, env ...string) (oar.Session, string) {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	log := t.TempDir() + "/prompts.log"
	// The fake plays the pi host: OAR_PI_NODE runs it, OAR_PI_SDK_DIR names a stand-in SDK package.
	sdk := t.TempDir()
	_ = os.WriteFile(sdk+"/package.json", []byte(`{"name":"@earendil-works/pi-coding-agent"}`), 0o600)
	t.Setenv("OAR_PI_NODE", self)
	t.Setenv("OAR_PI_SDK_DIR", sdk)
	t.Setenv("OAR_FAKE_PI", "1")
	t.Setenv("OAR_FAKE_PI_LOG", log)
	for _, pair := range env {
		name, value, _ := strings.Cut(pair, "=")
		t.Setenv(name, value)
	}
	session, err := Session(context.Background(), oar.AvailableInstallation{Via: "executable", Command: self}, oar.SessionOptions{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Dispose(context.Background()) })
	return session, log
}

func prompts(t *testing.T, log string) []string {
	t.Helper()
	data, _ := os.ReadFile(log)
	return strings.Fields(strings.TrimSpace(string(data)))
}

func waitCtx(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func TestWithdrawnInputIsNeverPromptedAndTheNextHeldStillIs(t *testing.T) {
	session, log := openFake(t)
	ctx := waitCtx(t)
	first, _ := session.Prompt(ctx, "slow-first", oar.InputOptions{})
	if !first.IsAccepted() {
		t.Fatal(first)
	}
	withdrawn, _ := session.Queue(ctx, "withdrawn", oar.InputOptions{})
	kept, _ := session.Queue(ctx, "kept", oar.InputOptions{})
	taken, _ := session.Withdraw(ctx, withdrawn.Request.Request.InputID)
	if !taken.IsAccepted() || !kept.IsAccepted() {
		t.Fatal(taken, kept)
	}
	if _, err := observe.AwaitTurnEnd(ctx, session, first.Seq, ""); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for len(prompts(t, log)) < 2 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if got := strings.Join(prompts(t, log), ","); got != "slow-first,kept" {
		t.Fatalf("prompted %s", got)
	}
}

func TestQueueWhileIdleRunsAtOnceAndWithdrawAfterDisposeIsRefused(t *testing.T) {
	session, log := openFake(t)
	ctx := waitCtx(t)
	queued, _ := session.Queue(ctx, "now", oar.InputOptions{})
	if !queued.IsAccepted() {
		t.Fatal(queued)
	}
	deadline := time.Now().Add(5 * time.Second)
	for len(prompts(t, log)) < 1 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if got := strings.Join(prompts(t, log), ","); got != "now" {
		t.Fatalf("prompted %s", got)
	}
	if err := session.Dispose(ctx); err != nil {
		t.Fatal(err)
	}
	refused, _ := session.Withdraw(ctx, queued.Request.Request.InputID)
	if refused.IsAccepted() || (refused.Code != oar.CodeDisposed && refused.Code != oar.CodeRuntimeExited) {
		t.Fatal(refused)
	}
	disposeID := ""
	answered := false
	for _, record := range session.Records() {
		if record.Kind == oar.KindRequest && record.Request.Kind == oar.RequestDispose {
			disposeID = record.ID
		}
		if record.Kind == oar.KindResponse && record.Response.Kind == oar.ResponseExited && record.RequestID == disposeID && disposeID != "" {
			answered = true
		}
	}
	if !answered {
		t.Fatal("the dispose request is answered by the exit")
	}
}

func TestAbortBeforeAgentStartReachesPiWhenTheRunStarts(t *testing.T) {
	session, _ := openFake(t, "OAR_FAKE_PI_START_MS=300")
	ctx := waitCtx(t)
	prompt, _ := session.Prompt(ctx, "slow-one", oar.InputOptions{})
	if !prompt.IsAccepted() {
		t.Fatal(prompt)
	}
	abort, _ := session.Abort(ctx)
	if !abort.IsAccepted() {
		t.Fatal(abort)
	}
	outcome, err := observe.AwaitTurnEnd(ctx, session, prompt.Seq, "")
	if err != nil || outcome.Kind != "aborted" {
		t.Fatal(outcome, err)
	}
}

func TestPiHasResourcesAndContextAtTurnEnd(t *testing.T) {
	session, _ := openFake(t)
	ctx := waitCtx(t)
	resources, err := session.Resources(ctx)
	if err != nil || resources == nil || resources.Processes < 1 {
		t.Fatal(resources, err)
	}
	run, err := observe.PromptAndWait(ctx, session, "hello", observe.PromptRunOptions{})
	if err != nil || run.Kind != "ended" || run.Text != "echo:hello" {
		t.Fatal(run, err)
	}
	usage := session.ContextUsage().Value
	if usage == nil || usage.Tokens == nil || *usage.Tokens != 10 {
		t.Fatalf("context = %+v", usage)
	}
	if model := session.Model().Value; model == nil || *model != "fake/fake-1" {
		t.Fatal(model)
	}
}
