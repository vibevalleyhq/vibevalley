package shared

import (
	"sync"
	"testing"
	"time"
)

type fallbackProbe struct {
	mu     sync.Mutex
	events []string
}

func (p *fallbackProbe) add(event string) { p.events = append(p.events, event) }

func (p *fallbackProbe) snapshot() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.events...)
}

func TestAbortFallbackKillsAfterTheFirstDeadline(t *testing.T) {
	probe := &fallbackProbe{}
	fallback := NewAbortFallback(func() { probe.add("kill") }, 100*time.Millisecond, &probe.mu)
	probe.mu.Lock()
	fallback.Arm(func() { probe.add("first") })
	probe.mu.Unlock()
	time.Sleep(60 * time.Millisecond)
	probe.mu.Lock()
	// A repeated abort cannot postpone the first deadline.
	fallback.Arm(func() { probe.add("second") })
	probe.mu.Unlock()
	if !eventually(time.Second, func() bool { return len(probe.snapshot()) == 3 }) {
		t.Fatalf("events = %v", probe.snapshot())
	}
	time.Sleep(80 * time.Millisecond)
	if got := probe.snapshot(); len(got) != 3 || got[0] != "first" || got[1] != "second" || got[2] != "kill" {
		t.Fatalf("events = %v", got)
	}
	// Once triggered, a new attempt is taken over at once.
	probe.mu.Lock()
	fallback.Arm(func() { probe.add("late") })
	probe.mu.Unlock()
	if got := probe.snapshot(); got[len(got)-1] != "late" {
		t.Fatalf("events = %v", got)
	}
}

func TestAbortFallbackRefusalWithdrawsOnlyThatAttempt(t *testing.T) {
	probe := &fallbackProbe{}
	fallback := NewAbortFallback(func() { probe.add("kill") }, 80*time.Millisecond, &probe.mu)
	probe.mu.Lock()
	refuseFirst := fallback.Arm(func() { probe.add("first") })
	fallback.Arm(func() { probe.add("second") })
	refuseFirst()
	probe.mu.Unlock()
	if !eventually(time.Second, func() bool { return len(probe.snapshot()) == 2 }) {
		t.Fatalf("events = %v", probe.snapshot())
	}
	if got := probe.snapshot(); got[0] != "second" || got[1] != "kill" {
		t.Fatalf("events = %v", got)
	}
}

func TestAbortFallbackLastRefusalOrClearDisarms(t *testing.T) {
	probe := &fallbackProbe{}
	fallback := NewAbortFallback(func() { probe.add("kill") }, 50*time.Millisecond, &probe.mu)
	probe.mu.Lock()
	refuse := fallback.Arm(nil)
	refuse()
	refuse()
	probe.mu.Unlock()
	probe.mu.Lock()
	fallback.Arm(func() { probe.add("attempt") })
	fallback.Clear()
	probe.mu.Unlock()
	time.Sleep(150 * time.Millisecond)
	if got := probe.snapshot(); len(got) != 0 {
		t.Fatalf("events = %v", got)
	}
}

// A timer that fired while the adapter held its lock, then saw Clear (a turn
// end or dispose) before it got the lock, does nothing.
func TestAbortFallbackClearWinsOverAWaitingTimer(t *testing.T) {
	probe := &fallbackProbe{}
	fallback := NewAbortFallback(func() { probe.add("kill") }, 20*time.Millisecond, &probe.mu)
	probe.mu.Lock()
	fallback.Arm(func() { probe.add("attempt") })
	time.Sleep(80 * time.Millisecond) // the timer fires and waits for the lock
	fallback.Clear()
	probe.mu.Unlock()
	time.Sleep(50 * time.Millisecond)
	if got := probe.snapshot(); len(got) != 0 {
		t.Fatalf("events = %v", got)
	}
	// Re-armed after the clear: a fresh deadline.
	probe.mu.Lock()
	fallback.Arm(nil)
	probe.mu.Unlock()
	if !eventually(time.Second, func() bool { return len(probe.snapshot()) == 1 }) {
		t.Fatalf("events = %v", probe.snapshot())
	}
}
