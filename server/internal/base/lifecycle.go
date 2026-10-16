package base

import (
	"context"
	"sync"

	"go.uber.org/fx"
)

// Service is what a service does besides answering: background work started with the farm, stopped with it. OnStart
// subscribes to the news it follows and sets its work going; what it publishes at once goes in OnReady(ctx) (Readier),
// called once every service has started, so every subscriber hears it.
type Service interface {
	OnStart(ctx context.Context) error
	OnStop()
}

type Readier interface{ OnReady(ctx context.Context) }

// Run is a service's constructor with the service on the farm's lifecycle: its OnStart is a hook added as it is built,
// so it starts after the services it is built from, and its OnStop runs in the reverse order; a Readier is readied, in
// the order the services started, once all have.
func Run[T Service](r *Readies, ctor any) any {
	return fx.Annotate(ctor,
		fx.OnStart(func(ctx context.Context, s T) error {
			if x, ok := any(s).(Readier); ok {
				r.add(x)
			}
			return s.OnStart(ctx)
		}),
		fx.OnStop(func(s T) { s.OnStop() }),
	)
}

// Readies is the services to ready, in the order they started.
type Readies struct {
	mu  sync.Mutex
	all []Readier
}

func (r *Readies) add(s Readier) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.all = append(r.all, s)
}

// hook readies them all, on a hook of its own after every service's start.
func (r *Readies) hook(lc fx.Lifecycle) {
	lc.Append(fx.Hook{OnStart: func(ctx context.Context) error {
		r.mu.Lock()
		all := r.all
		r.mu.Unlock()
		for _, s := range all {
			s.OnReady(ctx)
		}
		return nil
	}})
}
