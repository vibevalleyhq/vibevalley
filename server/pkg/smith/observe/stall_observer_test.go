package observe_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/oartest"
	"vibevalley/pkg/smith/observe"
)

// Ported from the observeStalls / observeAgent / simpleStateOf tests of
// tests/session.test.ts, on the scripted runtime with real time (Go has no
// fake timers): a turn that hangs until it is aborted.

func soHangingSession(t *testing.T) oar.Session {
	t.Helper()
	runtime := oartest.Runtime(oartest.Options{Turn: func(turn *oartest.Turn) error {
		<-turn.Context.Done()
		return nil
	}})
	installation, err := runtime.Installation(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	session, err := runtime.Session(context.Background(), installation.Available, oar.SessionOptions{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Dispose(context.Background()) })
	return session
}

func TestObserveStallsReportsASilentActiveTurn(t *testing.T) {
	session := soHangingSession(t)
	var mu sync.Mutex
	var stalls []string
	stop := observe.ObserveStalls(session, observe.StallOptions{StallAfter: 50 * time.Millisecond, OnStall: func(info observe.StallInfo) {
		mu.Lock()
		defer mu.Unlock()
		stalls = append(stalls, info.LastRecordKind)
		if info.SilentForMs < 50 {
			t.Errorf("silent for %d ms", info.SilentForMs)
		}
	}})
	defer stop()
	started, err := session.Prompt(context.Background(), "hang", oar.InputOptions{})
	if err != nil || !started.IsAccepted() {
		t.Fatalf("prompt %+v %v", started, err)
	}
	read := func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), stalls...)
	}
	time.Sleep(20 * time.Millisecond)
	if got := read(); len(got) != 0 {
		t.Fatalf("must not fire before the threshold: %v", got)
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(read()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := read(); len(got) != 1 || got[0] != "response" {
		t.Fatalf("fires once past the threshold (last record: the accepted response): %v", got)
	}
	time.Sleep(300 * time.Millisecond)
	if got := read(); len(got) != 1 {
		t.Fatalf("fires once per silence episode: %v", got)
	}
}

func TestObserveAgentUnifiesFoldAndStall(t *testing.T) {
	session := soHangingSession(t)
	var now struct {
		sync.Mutex
		ms int64
	}
	clock := func() int64 {
		now.Lock()
		defer now.Unlock()
		return now.ms
	}
	now.ms = time.Now().UnixMilli()
	observer := observe.ObserveAgent(session, observe.ObserveAgentOptions{StallAfter: 50 * time.Millisecond, Now: clock, Tick: 5 * time.Millisecond})
	var mu sync.Mutex
	var states []string
	observer.Subscribe(func(view observe.AgentView) {
		mu.Lock()
		defer mu.Unlock()
		states = append(states, observe.SimpleStateOf(view))
	})
	if _, err := session.Prompt(context.Background(), "hang", oar.InputOptions{}); err != nil {
		t.Fatal(err)
	}
	read := func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), states...)
	}
	deadline := time.Now().Add(2 * time.Second)
	for !soContains(read(), "busy") && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	// Silence past the threshold: advance the injected clock.
	now.Lock()
	now.ms = time.Now().UnixMilli() + 2000
	now.Unlock()
	for !soContains(read(), "stuck") && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	observer.Dispose()
	got := read()
	if got[0] != "idle" {
		t.Fatalf("initial view pushed on subscribe: %v", got)
	}
	if got[1] != "busy" {
		t.Fatalf("busy after the prompt: %v", got)
	}
	if got[len(got)-1] != "stuck" {
		t.Fatalf("silence past threshold flips the view once: %v", got)
	}
	first := soIndexOf(got, "stuck")
	if soContains(got[first:], "busy") {
		t.Fatalf("no flapping while silent: %v", got)
	}
	stuck := 0
	for _, state := range got {
		if state == "stuck" {
			stuck++
		}
	}
	if stuck != 1 {
		t.Fatalf("pushed only on the silence edge: %v", got)
	}
}

func soContains(values []string, value string) bool { return soIndexOf(values, value) != -1 }

func soIndexOf(values []string, value string) int {
	for i, known := range values {
		if known == value {
			return i
		}
	}
	return -1
}

func TestSimpleStateOfReportsErrorOnlyAsIdleAfterFailure(t *testing.T) {
	running := observe.AgentView{Status: oar.AgentStatus{Kind: "running", Phase: oar.PhaseThinking}}
	if got := observe.SimpleStateOf(running); got != "busy" {
		t.Fatal(got)
	}
	failed := oar.Failed(oar.FailureUnknown, "boom")
	failedIdle := observe.AgentView{Status: oar.AgentStatus{Kind: "idle", LastTurnOutcome: &failed}}
	if got := observe.SimpleStateOf(failedIdle); got != "error" {
		t.Fatal(got)
	}
	stuckBeatsBusy := running
	stuckBeatsBusy.Stall = &observe.Stall{SinceSeq: 0, SilentForMs: 99}
	if got := observe.SimpleStateOf(stuckBeatsBusy); got != "stuck" {
		t.Fatal(got)
	}
}

func TestObserveAgentIsolatesAPanickingListener(t *testing.T) {
	session := soHangingSession(t)
	observer := observe.ObserveAgent(session, observe.ObserveAgentOptions{StallAfter: time.Hour})
	defer observer.Dispose()
	observer.Subscribe(func(observe.AgentView) { panic("listener failure") })
	var mu sync.Mutex
	seen := 0
	observer.Subscribe(func(observe.AgentView) {
		mu.Lock()
		seen++
		mu.Unlock()
	})
	if _, err := session.Prompt(context.Background(), "hang", oar.InputOptions{}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		count := seen
		mu.Unlock()
		if count > 1 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("the second listener starved behind a panicking one")
}

func TestObserveStallsOwnsAlreadyRunningTurn(t *testing.T) {
	session := soHangingSession(t)
	if result, err := session.Prompt(context.Background(), "already working", oar.InputOptions{}); err != nil || !result.IsAccepted() {
		t.Fatalf("prompt: %+v %v", result, err)
	}
	time.Sleep(60 * time.Millisecond)
	stalls := make(chan observe.StallInfo, 10)
	stop := observe.ObserveStalls(session, observe.StallOptions{StallAfter: 50 * time.Millisecond, OnStall: func(info observe.StallInfo) { stalls <- info }})
	defer stop()
	select {
	case info := <-stalls:
		if info.SilentForMs < 50 {
			t.Fatalf("early stall: %+v", info)
		}
	case <-time.After(time.Second):
		t.Fatal("missed the turn that started before subscription")
	}
	select {
	case <-stalls:
		t.Fatal("reported the same silence twice")
	case <-time.After(100 * time.Millisecond):
	}
}
