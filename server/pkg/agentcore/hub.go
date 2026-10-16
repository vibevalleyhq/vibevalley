package agentcore

// Hub is an unbounded publish/subscribe (TS PubSub.unbounded): publishing never waits for a subscriber, each
// subscriber gets every value published after it subscribed, in order, on its own channel.

import "sync"

type Hub[T any] struct {
	mu     sync.Mutex
	subs   map[*Subscription[T]]struct{}
	closed bool
}

func NewHub[T any]() *Hub[T] { return &Hub[T]{subs: map[*Subscription[T]]struct{}{}} }

// Subscription is one subscriber. C is closed after Close (of it or of the hub), once what was published before
// the hub closed is delivered.
type Subscription[T any] struct {
	C <-chan T

	hub   *Hub[T]
	out   chan T
	mu    sync.Mutex
	queue []T
	wake  chan struct{}
	ended bool
	stop  chan struct{}
	once  sync.Once
}

// Subscribe starts a subscription; values published from now on reach it.
func (h *Hub[T]) Subscribe() *Subscription[T] {
	out := make(chan T)
	s := &Subscription[T]{C: out, hub: h, out: out, wake: make(chan struct{}, 1), stop: make(chan struct{})}
	h.mu.Lock()
	if h.closed {
		s.ended = true
	} else {
		h.subs[s] = struct{}{}
	}
	h.mu.Unlock()
	go s.pump()
	return s
}

// Publish hands v to every subscriber; it never blocks.
func (h *Hub[T]) Publish(v T) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
	for s := range h.subs {
		s.push(v)
	}
}

// Close ends every subscription after what they were given.
func (h *Hub[T]) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
	h.closed = true
	for s := range h.subs {
		s.end()
	}
	h.subs = nil
}

func (s *Subscription[T]) push(v T) {
	s.mu.Lock()
	s.queue = append(s.queue, v)
	s.mu.Unlock()
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *Subscription[T]) end() {
	s.mu.Lock()
	s.ended = true
	s.mu.Unlock()
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *Subscription[T]) pump() {
	defer close(s.out)
	for {
		s.mu.Lock()
		if len(s.queue) == 0 {
			ended := s.ended
			s.mu.Unlock()
			if ended {
				return
			}
			select {
			case <-s.wake:
				continue
			case <-s.stop:
				return
			}
		}
		v := s.queue[0]
		var zero T
		s.queue[0] = zero
		s.queue = s.queue[1:]
		s.mu.Unlock()
		select {
		case s.out <- v:
		case <-s.stop:
			return
		}
	}
}

// Close stops the subscription; what was not taken is dropped.
func (s *Subscription[T]) Close() {
	s.once.Do(func() {
		s.hub.mu.Lock()
		delete(s.hub.subs, s)
		s.hub.mu.Unlock()
		close(s.stop)
	})
}
