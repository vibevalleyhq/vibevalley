package base

import (
	"context"
	"sync"

	"go.uber.org/fx"
)

// What a service publishes at once goes in OnReady (Readier), called once every service has started, so every subscriber hears it.
type Service interface {
	OnStart(ctx context.Context) error
	OnStop()
}

type Readier interface{ OnReady(ctx context.Context) }

// Its OnStart is a hook added as it is built, so it starts after the services it is built from; OnStop runs in the reverse order.
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

type Readies struct {
	mu  sync.Mutex
	all []Readier
}

func (r *Readies) add(s Readier) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.all = append(r.all, s)
}

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
