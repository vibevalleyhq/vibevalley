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

// Parts are the pieces of one package's Service, run as one: started in order (those already started are stopped again when one fails), readied
// in order, stopped in reverse.
type Parts []Service

func (p Parts) OnStart(ctx context.Context) error {
	for i, s := range p {
		if err := s.OnStart(ctx); err != nil {
			for j := i - 1; j >= 0; j-- {
				p[j].OnStop()
			}
			return err
		}
	}
	return nil
}

func (p Parts) OnReady(ctx context.Context) {
	for _, s := range p {
		if r, ok := s.(Readier); ok {
			r.OnReady(ctx)
		}
	}
}

func (p Parts) OnStop() {
	for i := len(p) - 1; i >= 0; i-- {
		p[i].OnStop()
	}
}
