package store

import (
	"container/heap"
	"sync"
	"time"
)

// Timer represents a cancellable one-shot timer scheduled on a Clock.
type Timer interface {
	Stop() bool
	Reset(d time.Duration) bool
}

// Clock abstracts wall time and timers so store deferred flushes and scheduler sleeps
// run deterministically under FakeClock in tests and against system time in production.
type Clock interface {
	Now() time.Time
	NowMs() int64
	AfterFunc(d time.Duration, fn func()) Timer
}

// RealClock delegates directly to the Go standard library time package.
type RealClock struct{}

func (RealClock) Now() time.Time { return time.Now() }

func (RealClock) NowMs() int64 { return time.Now().UnixMilli() }

func (RealClock) AfterFunc(d time.Duration, fn func()) Timer {
	return time.AfterFunc(d, fn)
}

type fakeTimer struct {
	clock    *FakeClock
	deadline time.Time
	seq      uint64
	fn       func()
	active   bool
	index    int
}

func (t *fakeTimer) Stop() bool {
	t.clock.mu.Lock()
	defer t.clock.mu.Unlock()
	if !t.active {
		return false
	}
	t.active = false
	if t.index >= 0 {
		heap.Remove(&t.clock.timers, t.index)
	}
	return true
}

func (t *fakeTimer) Reset(d time.Duration) bool {
	t.clock.mu.Lock()
	defer t.clock.mu.Unlock()
	wasActive := t.active
	t.deadline = t.clock.now.Add(d)
	t.clock.nextSeq++
	t.seq = t.clock.nextSeq
	if wasActive && t.index >= 0 {
		heap.Fix(&t.clock.timers, t.index)
		return true
	}
	t.active = true
	heap.Push(&t.clock.timers, t)
	return wasActive
}

type fakeTimerHeap []*fakeTimer

func (h fakeTimerHeap) Len() int { return len(h) }

func (h fakeTimerHeap) Less(i, j int) bool {
	if !h[i].deadline.Equal(h[j].deadline) {
		return h[i].deadline.Before(h[j].deadline)
	}
	return h[i].seq < h[j].seq
}

func (h fakeTimerHeap) Swap(i, j int) {
	h[i], h[j] = h[j], h[i]
	h[i].index = i
	h[j].index = j
}

func (h *fakeTimerHeap) Push(x any) {
	t := x.(*fakeTimer)
	t.index = len(*h)
	*h = append(*h, t)
}

func (h *fakeTimerHeap) Pop() any {
	old := *h
	n := len(old)
	t := old[n-1]
	old[n-1] = nil
	t.index = -1
	*h = old[:n-1]
	return t
}

// FakeClock is a deterministic, thread-safe virtual clock for tests.
type FakeClock struct {
	mu      sync.Mutex
	now     time.Time
	nextSeq uint64
	timers  fakeTimerHeap
}

// NewFakeClock creates a FakeClock initialized at start (or Unix epoch+1s if zero).
func NewFakeClock(start time.Time) *FakeClock {
	if start.IsZero() {
		start = time.Unix(1_700_000_000, 0).UTC()
	}
	return &FakeClock{now: start}
}

func (c *FakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *FakeClock) NowMs() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now.UnixMilli()
}

func (c *FakeClock) AfterFunc(d time.Duration, fn func()) Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.nextSeq++
	t := &fakeTimer{
		clock:    c,
		deadline: c.now.Add(d),
		seq:      c.nextSeq,
		fn:       fn,
		active:   true,
		index:    -1,
	}
	heap.Push(&c.timers, t)
	return t
}

// PendingTimers returns the number of currently active pending timers.
func (c *FakeClock) PendingTimers() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.timers)
}

// Advance moves the virtual clock forward by d and fires all due timers in deadline order.
// Callbacks run unlocked so they may inspect Now() or schedule follow-up timers without deadlocking.
func (c *FakeClock) Advance(d time.Duration) {
	if d < 0 {
		d = 0
	}
	c.mu.Lock()
	target := c.now.Add(d)
	for {
		if len(c.timers) == 0 {
			break
		}
		next := c.timers[0]
		if next.deadline.After(target) {
			break
		}
		heap.Pop(&c.timers)
		next.active = false
		if next.deadline.After(c.now) {
			c.now = next.deadline
		}
		fn := next.fn
		c.mu.Unlock()
		if fn != nil {
			fn()
		}
		c.mu.Lock()
	}
	if target.After(c.now) {
		c.now = target
	}
	c.mu.Unlock()
}
