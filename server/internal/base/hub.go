package base

import (
	"context"
	"sync"
	"time"
)

// A subscriber that falls behind gets a longer queue, never a dropped value.
type Hub[T any] struct {
	mu   sync.Mutex
	subs map[*hubSub[T]]struct{}
}

type hubSub[T any] struct {
	mu     sync.Mutex
	queue  []T
	signal chan struct{}
	closed bool
}

func NewHub[T any]() *Hub[T] { return &Hub[T]{subs: map[*hubSub[T]]struct{}{}} }

func (h *Hub[T]) Publish(v T) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for s := range h.subs {
		s.mu.Lock()
		s.queue = append(s.queue, v)
		s.mu.Unlock()
		select {
		case s.signal <- struct{}{}:
		default:
		}
	}
}

func (h *Hub[T]) Subscribe() (<-chan T, func()) {
	s := &hubSub[T]{signal: make(chan struct{}, 1)}
	h.mu.Lock()
	h.subs[s] = struct{}{}
	h.mu.Unlock()
	out := make(chan T)
	done := make(chan struct{})
	go func() {
		defer close(out)
		for {
			s.mu.Lock()
			if s.closed {
				s.mu.Unlock()
				return
			}
			if len(s.queue) == 0 {
				s.mu.Unlock()
				select {
				case <-s.signal:
					continue
				case <-done:
					return
				}
			}
			v := s.queue[0]
			var zero T
			s.queue[0] = zero
			s.queue = s.queue[1:]
			s.mu.Unlock()
			select {
			case out <- v:
			case <-done:
				return
			}
		}
	}()
	var once sync.Once
	return out, func() {
		once.Do(func() {
			h.mu.Lock()
			delete(h.subs, s)
			h.mu.Unlock()
			s.mu.Lock()
			s.closed = true
			s.mu.Unlock()
			close(done)
		})
	}
}

func Sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
