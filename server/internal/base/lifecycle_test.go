package base

import (
	"context"
	"slices"
	"sync"
	"testing"

	"go.uber.org/fx"
)

// lifecycleTrail is what the probes did, in order.
type lifecycleTrail struct {
	mu    sync.Mutex
	lines []string
}

func (t *lifecycleTrail) add(line string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.lines = append(t.lines, line)
}

// Three services, each built from the one before; a and c have something to publish once all have started.
type probeA struct{ trail *lifecycleTrail }
type probeB struct{ trail *lifecycleTrail }
type probeC struct{ trail *lifecycleTrail }

func (p *probeA) OnStart(context.Context) error { p.trail.add("start a"); return nil }
func (p *probeA) OnReady(context.Context)       { p.trail.add("ready a") }
func (p *probeA) OnStop()                       { p.trail.add("close a") }
func (p *probeB) OnStart(context.Context) error { p.trail.add("start b"); return nil }
func (p *probeB) OnStop()                       { p.trail.add("close b") }
func (p *probeC) OnStart(context.Context) error { p.trail.add("start c"); return nil }
func (p *probeC) OnReady(context.Context)       { p.trail.add("ready c") }
func (p *probeC) OnStop()                       { p.trail.add("close c") }

func TestRunStartsEachServiceAfterWhatItIsBuiltFrom(t *testing.T) {
	trail := &lifecycleTrail{}
	r := &Readies{}
	// Listed out of order: the order comes from what each is built from.
	app := fx.New(
		fx.NopLogger,
		fx.Supply(trail),
		fx.Provide(
			Run[*probeC](r, func(t *lifecycleTrail, _ *probeB) *probeC { return &probeC{t} }),
			Run[*probeA](r, func(t *lifecycleTrail) *probeA { return &probeA{t} }),
			Run[*probeB](r, func(t *lifecycleTrail, _ *probeA) *probeB { return &probeB{t} }),
		),
		fx.Invoke(func(*probeC) {}),
		fx.Invoke(r.hook),
	)
	if err := app.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := app.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := []string{"start a", "start b", "start c", "ready a", "ready c", "close c", "close b", "close a"}
	if !slices.Equal(trail.lines, want) {
		t.Fatalf("got %q, want %q", trail.lines, want)
	}
}
