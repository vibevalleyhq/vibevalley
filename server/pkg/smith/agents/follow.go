package agents

import (
	"context"
	"sync"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Go-only: unlike agents/subagent.ts, independent Go subscriptions run on different goroutines. Only completion
// anchors are retained here; records and their replay remain owned by Session.RawEvents.
type followedReport struct {
	after  int64
	report SubagentReport
}

type following struct {
	mu      sync.Mutex
	reports []followedReport
	wake    chan struct{}
}

func (f *following) append(after int64, report SubagentReport) {
	f.mu.Lock()
	f.reports = append(f.reports, followedReport{after, report})
	close(f.wake)
	f.wake = make(chan struct{})
	f.mu.Unlock()
}

// Follow replays retained events and reports, then follows live work. Both callbacks run serially on one consumer:
// a report never overtakes any event in its source record, and finishes before events from the next record begin.
// It observes reports without consuming OnReport/Wait/Next. Stop cancels this consumer; an in-flight callback may
// finish, but no later report is delivered. Callbacks must return; cancellation does not interrupt user code.
func (a *Subagent) Follow(events oar.EventObserver, reports func(SubagentReport)) oar.Unsubscribe {
	ctx, cancel := context.WithCancel(context.Background())
	var mu sync.Mutex
	cursor, index := int64(-1), 0
	reader := observe.EventsReader(func(event oar.Event) {
		if ctx.Err() == nil && events != nil {
			events(event)
		}
	})
	// Called with the consumer lock held. A synthetic Close report can arrive without another raw record.
	drain := func() {
		for ctx.Err() == nil {
			a.following.mu.Lock()
			if index == len(a.following.reports) || a.following.reports[index].after > cursor {
				a.following.mu.Unlock()
				return
			}
			report := a.following.reports[index].report
			index++
			a.following.mu.Unlock()
			if reports != nil {
				reports(report)
			}
		}
	}
	var stopMu sync.Mutex
	var stopRaw oar.Unsubscribe
	stop := func() {
		cancel()
		stopMu.Lock()
		unsubscribe := stopRaw
		stopMu.Unlock()
		if unsubscribe != nil {
			unsubscribe()
		}
	}
	isolate := func() {
		if recover() != nil {
			stop()
		}
	}
	go func() {
		unsubscribe := a.Session.RawEvents(func(record oar.RawEvent) {
			defer isolate()
			mu.Lock()
			defer mu.Unlock()
			if ctx.Err() != nil {
				return
			}
			reader(record)
			a.seen.reach(ctx, record.Seq)
			if ctx.Err() != nil {
				return
			}
			cursor = record.Seq
			drain()
		}, &oar.Cursor{SessionID: a.Session.ID(), AfterSeq: -1})
		stopMu.Lock()
		stopRaw = unsubscribe
		canceled := ctx.Err() != nil
		stopMu.Unlock()
		if canceled {
			unsubscribe()
		}
	}()
	go func() {
		defer isolate()
		for {
			a.following.mu.Lock()
			wake := a.following.wake
			a.following.mu.Unlock()
			func() {
				mu.Lock()
				defer mu.Unlock()
				drain()
			}()
			select {
			case <-ctx.Done():
				return
			case <-wake:
			}
		}
	}()
	return stop
}
