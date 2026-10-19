package lan

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"sync"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/db/generated"
)

type lanStore struct {
	generated.DBTX
	mu   sync.Mutex
	open bool
	fail bool
}

func (s *lanStore) ExecContext(_ context.Context, _ string, args ...any) (sql.Result, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail {
		return nil, errors.New("disk unavailable")
	}
	s.open = args[0].(bool)
	return nil, nil
}

func TestConcurrentOpenMatchesPersistence(t *testing.T) {
	store := &lanStore{}
	l := &Service{q: generated.New(store), host: "127.0.0.1", API: http.NotFoundHandler(), devices: map[string]*lanDevice{}, address: func() string { return "127.0.0.1" }}
	defer l.OnStop()
	var workers sync.WaitGroup
	for i := 0; i < 50; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for j := 0; j < 10; j++ {
				if _, err := l.SetOpen(j%2 == 0); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	workers.Wait()
	if l.Status().Open != store.open {
		t.Fatal("running lan access differs from the saved one")
	}
	store.fail = true
	before := l.Status().Open
	if _, err := l.SetOpen(!before); err == nil || l.Status().Open != before {
		t.Fatal("failed write changed lan access")
	}
}

func TestTrackingRechecksForgottenDevice(t *testing.T) {
	l := &Service{devices: map[string]*lanDevice{}, conns: map[string]map[int]context.CancelFunc{}}
	ctx, done := l.track(context.Background(), "forgotten")
	defer done()
	if ctx.Err() == nil || len(l.conns) != 0 {
		t.Fatal("forgotten device acquired an uncancellable request")
	}
	l.devices["current"] = &lanDevice{LanDevice: protocol.LanDevice{ID: "current"}}
	ctx, done = l.track(context.Background(), "current")
	if ctx.Err() != nil {
		t.Fatal(ctx.Err())
	}
	done()
	if ctx.Err() == nil {
		t.Fatal("finished request remains alive")
	}
}
