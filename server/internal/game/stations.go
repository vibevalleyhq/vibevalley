package game

import (
	"context"
	"sync"
	"time"

	"vibevalley/internal/core"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/clock"
)

// The person plants on an empty plot and then says what to do; the manager hires a session for it some seconds later.
const wantStationFor = 10 * time.Second

type stations struct {
	core *core.Service

	mu     sync.Mutex
	wanted *stationWish
	stop   func()
}

type stationWish struct {
	station int64
	until   int64
}

func newStations(core *core.Service) (*stations, error) { return &stations{core: core}, nil }

// The next session hired within wantStationFor goes to this station, if it is still free.
func (s *stations) Want(station int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.wanted = &stationWish{station, clock.NowMs() + wantStationFor.Milliseconds()}
}

func (s *stations) OnStart(ctx context.Context) error {
	events, stop := s.core.Facts()
	s.mu.Lock()
	s.stop = stop
	s.mu.Unlock()
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
					s.hired(hired)
				}
			}
		}
	}()
	return nil
}

func (s *stations) hired(f protocol.FactHired) {
	s.mu.Lock()
	wish := s.wanted
	s.wanted = nil
	s.mu.Unlock()
	if wish != nil && wish.until > f.At {
		s.core.Apply(protocol.FactStation{ID: f.Session.ID, Station: wish.station})
	}
}

func (s *stations) OnStop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stop != nil {
		s.stop()
	}
}
