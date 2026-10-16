package agents

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/oartest"
)

// Ported from tests/fixtures/subagent-fixtures.ts.

type script = func(turn *oartest.Turn) error

func registryOf(t *testing.T, runtimes ...oar.Runtime) *oar.RuntimeRegistry {
	t.Helper()
	registry, err := oar.NewRuntimeRegistry(runtimes...)
	if err != nil {
		t.Fatal(err)
	}
	return registry
}

func crewOf(t *testing.T, turn script, options Options) *Subagents {
	t.Helper()
	options.Runtimes = registryOf(t, oartest.Runtime(oartest.Options{ID: "fake", Turn: turn}))
	crew := New(options)
	t.Cleanup(func() { _ = crew.Close(context.Background()) })
	return crew
}

func echo(turn *oartest.Turn) error {
	turn.Say("did: " + turn.Input)
	return nil
}

// gate is a script whose turns stay open until the test releases them; a
// release before a turn waits counts for it.
type gate struct {
	mu      sync.Mutex
	waiting []chan struct{}
	permits int
	started atomic.Int64
}

func (g *gate) script(turn *oartest.Turn) error {
	g.started.Add(1)
	turn.Say("working on " + turn.Input)
	g.pass(turn.Context)
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
	next := g.waiting[0]
	g.waiting = g.waiting[1:]
	close(next)
}

func (g *gate) pass(ctx context.Context) {
	g.mu.Lock()
	if g.permits > 0 {
		g.permits--
		g.mu.Unlock()
		return
	}
	wait := make(chan struct{})
	g.waiting = append(g.waiting, wait)
	g.mu.Unlock()
	select {
	case <-wait:
	case <-ctx.Done():
	}
}

func testCtx(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func spawned(t *testing.T, crew *Subagents, task, name string) *Subagent {
	t.Helper()
	result, err := crew.Spawn(testCtx(t), SpawnOptions{Runtime: "fake", Task: task, Name: name})
	if err != nil {
		t.Fatal(err)
	}
	if result.Kind != "spawned" {
		t.Fatalf("spawn = %+v", result)
	}
	return result.Agent
}

// poll is vitest's expect.poll: true within timeout, or the test fails.
func poll(t *testing.T, timeout time.Duration, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// silentOnDispose wraps a runtime so its sessions behave like claude's and
// codex's adapters: after dispose, no turn_ended reaches observers (the
// scripted runtime ends a disposed turn aborted).
func silentOnDispose(runtime oar.Runtime) oar.Runtime {
	start := runtime.Session
	runtime.Session = func(ctx context.Context, installation oar.AvailableInstallation, options oar.SessionOptions) (oar.Session, error) {
		real, err := start(ctx, installation, options)
		if err != nil {
			return nil, err
		}
		return &silentSession{Session: real}, nil
	}
	return runtime
}

type silentSession struct {
	oar.Session
	disposed atomic.Bool
}

func (s *silentSession) Dispose(ctx context.Context) error {
	s.disposed.Store(true)
	return s.Session.Dispose(ctx)
}

func (s *silentSession) RawEvents(observer oar.RawEventObserver, cursor *oar.Cursor) oar.Unsubscribe {
	return s.Session.RawEvents(func(record oar.RawEvent) {
		if s.disposed.Load() && record.Kind == oar.KindFrame {
			kept := []oar.EventBody{}
			for _, event := range record.Frame.Events {
				if _, ended := event.(oar.TurnEnded); !ended {
					kept = append(kept, event)
				}
			}
			record.Frame.Events = kept
		}
		observer(record)
	}, cursor)
}
