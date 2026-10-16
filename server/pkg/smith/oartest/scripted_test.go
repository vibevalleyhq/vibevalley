package oartest

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

func echo() oar.Runtime {
	return Runtime(Options{Turn: func(turn *Turn) error {
		delay := 10 * time.Millisecond
		if strings.Contains(turn.Input, "slow") {
			delay = 300 * time.Millisecond
		}
		select {
		case <-time.After(delay):
		case <-turn.Context.Done():
		}
		turn.Say("echo:" + turn.Input)
		return nil
	}})
}

func open(t *testing.T) oar.Session {
	t.Helper()
	runtime := echo()
	installation, err := runtime.Installation(context.Background())
	if err != nil || installation.Kind != "available" {
		t.Fatalf("installation: %v %v", installation, err)
	}
	session, err := runtime.Session(context.Background(), installation.Available, oar.SessionOptions{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Dispose(context.Background()) })
	return session
}

func ctx(t *testing.T) context.Context {
	c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return c
}

func TestPromptAndWait(t *testing.T) {
	session := open(t)
	run, err := observe.PromptAndWait(ctx(t), session, "hello", observe.PromptRunOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if run.Kind != "ended" || run.Outcome.Kind != "completed" || run.Text != "echo:hello" {
		t.Fatalf("run = %+v", run)
	}
	if model := session.Model().Value; model == nil || *model != "scripted-1" {
		t.Fatalf("model = %v", model)
	}
	usage := session.Usage().Value
	if usage.Total == nil || usage.Total.Input == 0 {
		t.Fatalf("usage = %+v", usage)
	}
	if status := session.Status().Value; status.Kind != "idle" || status.LastTurnOutcome == nil {
		t.Fatalf("status = %+v", status)
	}
}

func TestBusyAndSteerAndQueue(t *testing.T) {
	session := open(t)
	c := ctx(t)
	first, _ := session.Prompt(c, "slow one", oar.InputOptions{})
	if !first.IsAccepted() {
		t.Fatalf("first prompt %+v", first)
	}
	busy, _ := session.Prompt(c, "second", oar.InputOptions{})
	if busy.IsAccepted() || busy.Code != oar.CodeBusy {
		t.Fatalf("busy = %+v", busy)
	}
	steered, err := session.Steer(c, "nudge", oar.InputOptions{})
	if err != nil || !steered.IsAccepted() {
		t.Fatalf("steer = %+v %v", steered, err)
	}
	queued, _ := session.Queue(c, "later", oar.InputOptions{})
	if !queued.IsAccepted() {
		t.Fatalf("queue = %+v", queued)
	}
	withdrawn, _ := session.Withdraw(c, queued.Request.Request.InputID)
	if !withdrawn.IsAccepted() {
		t.Fatalf("withdraw = %+v", withdrawn)
	}
	again, _ := session.Withdraw(c, queued.Request.Request.InputID)
	if again.Code != oar.CodeNotQueued {
		t.Fatalf("second withdraw = %+v", again)
	}
	aborted, _ := session.Abort(c)
	if !aborted.IsAccepted() {
		t.Fatalf("abort = %+v", aborted)
	}
	outcome, err := observe.AwaitTurnEnd(c, session, first.Seq, "")
	if err != nil || outcome.Kind != "aborted" {
		t.Fatalf("outcome = %+v %v", outcome, err)
	}
	late, _ := session.Abort(c)
	if late.Code != oar.CodeNoActiveTurn {
		t.Fatalf("late abort = %+v", late)
	}
}

func TestCursorReplayThenLiveHasNoGapsOrDuplicates(t *testing.T) {
	session := open(t)
	c := ctx(t)
	for i := 0; i < 3; i++ {
		run, err := observe.PromptAndWait(c, session, "hi", observe.PromptRunOptions{})
		if err != nil || run.Kind != "ended" {
			t.Fatalf("run %d: %+v %v", i, run, err)
		}
	}
	var mu sync.Mutex
	var seen []int64
	unsubscribe := session.RawEvents(func(record oar.RawEvent) {
		mu.Lock()
		seen = append(seen, record.Seq)
		mu.Unlock()
	}, &oar.Cursor{SessionID: session.ID(), AfterSeq: 2})
	defer unsubscribe()
	mu.Lock()
	replayed := len(seen)
	mu.Unlock()
	if replayed != len(session.Records())-3 {
		t.Fatalf("replay delivered %d of %d", replayed, len(session.Records())-3)
	}
	run, err := observe.PromptAndWait(c, session, "more", observe.PromptRunOptions{})
	if err != nil || run.Kind != "ended" {
		t.Fatal(run, err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		n := len(seen)
		mu.Unlock()
		if n == len(session.Records())-3 || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	for i, seq := range seen {
		if seq != int64(i+3) {
			t.Fatalf("delivery %d has seq %d: %v", i, seq, seen)
		}
	}
	if len(seen) != len(session.Records())-3 {
		t.Fatalf("delivered %d, retained %d", len(seen), len(session.Records()))
	}
}

func TestDisposeRejectsLaterControls(t *testing.T) {
	session := open(t)
	c := ctx(t)
	if err := session.Dispose(c); err != nil {
		t.Fatal(err)
	}
	prompt, _ := session.Prompt(c, "after", oar.InputOptions{})
	if prompt.Code != oar.CodeRuntimeExited {
		t.Fatalf("prompt after dispose = %+v", prompt)
	}
	if err := session.Dispose(c); err != nil {
		t.Fatal(err)
	}
}

func TestEmptyInputAndInputIDs(t *testing.T) {
	session := open(t)
	c := ctx(t)
	empty, _ := session.Prompt(c, "", oar.InputOptions{})
	if empty.Code != oar.CodeUnsupported {
		t.Fatalf("empty = %+v", empty)
	}
	if _, err := session.Prompt(c, "x", oar.InputOptions{InputID: "not-a-uuid"}); err == nil {
		t.Fatal("a non-UUID inputId must be refused")
	}
}

func TestPanickingObserverDoesNotTouchTheRun(t *testing.T) {
	session := open(t)
	session.RawEvents(func(oar.RawEvent) { panic("boom") }, nil)
	run, err := observe.PromptAndWait(ctx(t), session, "hello", observe.PromptRunOptions{})
	if err != nil || run.Kind != "ended" {
		t.Fatal(run, err)
	}
}

func TestRecordsRoundTripThroughJSON(t *testing.T) {
	session := open(t)
	if _, err := observe.PromptAndWait(ctx(t), session, "hello", observe.PromptRunOptions{}); err != nil {
		t.Fatal(err)
	}
	for _, record := range session.Records() {
		encoded, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		var decoded oar.RawEvent
		if err := json.Unmarshal(encoded, &decoded); err != nil {
			t.Fatal(err)
		}
		again, _ := json.Marshal(decoded)
		if string(again) != string(encoded) {
			t.Fatalf("round trip changed\n%s\n%s", encoded, again)
		}
	}
}

func TestCoalescedEvents(t *testing.T) {
	runtime := Runtime(Options{Turn: func(turn *Turn) error {
		turn.Say("a")
		turn.Say("b")
		turn.Say("c")
		return nil
	}})
	installation, _ := runtime.Installation(context.Background())
	session, err := runtime.Session(context.Background(), installation.Available, oar.SessionOptions{Cwd: "."})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Dispose(context.Background())
	var mu sync.Mutex
	var texts []string
	done := make(chan struct{})
	session.Events(func(event oar.Event) {
		mu.Lock()
		defer mu.Unlock()
		if text, ok := event.Body.(oar.TextDelta); ok {
			texts = append(texts, text.Text)
		}
		if _, ok := event.Body.(oar.TurnEnded); ok {
			close(done)
		}
	}, oar.EventsOptions{CoalesceText: true})
	if _, err := session.Prompt(ctx(t), "go", oar.InputOptions{}); err != nil {
		t.Fatal(err)
	}
	<-done
	mu.Lock()
	defer mu.Unlock()
	if len(texts) != 1 || texts[0] != "abc" {
		t.Fatalf("texts = %v", texts)
	}
}
