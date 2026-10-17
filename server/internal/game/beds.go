package game

import (
	"context"
	"sync"
	"time"

	"vibevalley/internal/core"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/clock"
)

// The person plants on an empty bed and then says what to do; the manager hires a worker for it some seconds later.
const wantBedFor = 10 * time.Second

type beds struct {
	core *core.Service

	mu     sync.Mutex
	wanted *bedWish
	stop   func()
}

type bedWish struct {
	bed   int64
	until int64
}

func newBeds(core *core.Service) (*beds, error) { return &beds{core: core}, nil }

// The next worker hired within wantBedFor goes to this bed, if it is still free.
func (b *beds) Want(bed int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.wanted = &bedWish{bed, clock.NowMs() + wantBedFor.Milliseconds()}
}

func (b *beds) OnStart(ctx context.Context) error {
	_, events, stop := b.core.Events()
	b.mu.Lock()
	b.stop = stop
	b.mu.Unlock()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case e, ok := <-events:
				if !ok {
					return
				}
				if hired, ok := e.Value.(protocol.FactHired); ok {
					b.hired(hired)
				}
			}
		}
	}()
	return nil
}

func (b *beds) hired(f protocol.FactHired) {
	b.mu.Lock()
	wish := b.wanted
	b.wanted = nil
	b.mu.Unlock()
	if wish != nil && wish.until > f.At {
		b.core.Apply(protocol.FactStation{ID: f.Worker.ID, Station: wish.bed})
	}
}

func (b *beds) OnStop() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.stop != nil {
		b.stop()
	}
}
