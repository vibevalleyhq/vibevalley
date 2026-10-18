package observe

import (
	"context"
	"sync"
	"time"

	"vibevalley/pkg/smith/oar"
)

// RecordSource is shared by the public Session and runtime-author AdapterSession.
type RecordSource interface {
	ID() string
	RawEvents(oar.RawEventObserver, *oar.Cursor) oar.Unsubscribe
	Records() []oar.RawEvent
}

// RecordSubscription owns delivery completion and any coalesced tail. Close drains the current source tail before
// returning; call it after disposing the source for a complete capture. Cancel abandons pending delivery.
type RecordSubscription struct {
	source     RecordSource
	stop       oar.Unsubscribe
	flush      func()
	cancelText func()
	mu         sync.Mutex
	seq        int64
	wake       chan struct{}
	canceled   bool
	once       sync.Once
	closeMu    sync.Mutex
	closed     bool
	closeErr   error
}

func SubscribeRecords(source RecordSource, observer oar.RawEventObserver, cursor *oar.Cursor) *RecordSubscription {
	if cursor == nil {
		after := int64(-1)
		if records := source.Records(); len(records) > 0 {
			after = records[len(records)-1].Seq
		}
		cursor = &oar.Cursor{SessionID: source.ID(), AfterSeq: after}
	}
	s := &RecordSubscription{source: source, seq: cursor.AfterSeq, wake: make(chan struct{})}
	s.stop = source.RawEvents(func(record oar.RawEvent) {
		s.mu.Lock()
		canceled := s.canceled
		s.mu.Unlock()
		if canceled {
			return
		}
		observer(record)
		s.mu.Lock()
		s.seq = record.Seq
		close(s.wake)
		s.wake = make(chan struct{})
		s.mu.Unlock()
	}, cursor)
	return s
}

func SubscribeEvents(source RecordSource, observer oar.EventObserver, options oar.EventsOptions) *RecordSubscription {
	target := observer
	var flush, cancel func()
	if options.CoalesceText {
		target, flush, cancel = coalesceText(observer, time.Duration(options.MaxHoldMs)*time.Millisecond)
	}
	s := SubscribeRecords(source, EventsReader(target), options.Cursor)
	s.flush, s.cancelText = flush, cancel
	return s
}

func (s *RecordSubscription) Cancel() {
	s.once.Do(func() {
		s.mu.Lock()
		s.canceled = true
		close(s.wake)
		s.wake = make(chan struct{})
		s.mu.Unlock()
		s.stop()
		if s.cancelText != nil {
			s.cancelText()
		}
	})
}

func (s *RecordSubscription) Close(ctx context.Context) (err error) {
	s.closeMu.Lock()
	defer s.closeMu.Unlock()
	if s.closed {
		return s.closeErr
	}
	defer func() { s.closed = true; s.closeErr = err }()
	records := s.source.Records()
	target := int64(-1)
	if len(records) > 0 {
		target = records[len(records)-1].Seq
	}
	if err := s.Through(ctx, target); err != nil {
		s.Cancel()
		return err
	}
	s.stop()
	if s.flush != nil {
		s.flush()
	}
	s.Cancel()
	return nil
}

// Through waits until the consumer handled seq, without closing a live subscription.
// Canceling this wait leaves the subscription active.
func (s *RecordSubscription) Through(ctx context.Context, target int64) error {
	for {
		s.mu.Lock()
		seq, canceled, wake := s.seq, s.canceled, s.wake
		s.mu.Unlock()
		if canceled {
			return context.Canceled
		}
		if seq >= target {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-wake:
		}
	}
}
