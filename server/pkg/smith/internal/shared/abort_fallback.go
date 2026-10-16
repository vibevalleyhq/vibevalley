package shared

import (
	"sync"
	"time"
)

// DefaultAbortFallbackTimeout is the fallback's deadline when none is given.
const DefaultAbortFallbackTimeout = 10 * time.Second

// AbortFallback bounds interruption independently of its acknowledgement
// (shared/abort-fallback.ts). Repeated aborts cannot postpone the first
// deadline. An explicit refusal withdraws only that attempt; a turn end or
// process exit clears every attempt. The process owner supplies its normal
// SIGTERM/SIGKILL teardown as kill.
//
// Locking (PORTING.md rule 5): the fallback has no lock of its own. Arm,
// Clear and the withdraw func Arm returns must be called with lock held
// (the adapter's s.mu). The timer callback takes lock first, then runs the
// armed attempts' callbacks and kill with it held, as one JS tick would. A
// callback that fired but still waits for lock when Clear runs does
// nothing: Clear (and so a dispose that clears) always wins.
type AbortFallback struct {
	kill    func()
	timeout time.Duration
	lock    sync.Locker

	timer      *time.Timer
	generation uint64
	triggered  bool
	attempts   []*abortAttempt
}

type abortAttempt struct {
	onFallback func()
}

// NewAbortFallback makes a fallback that calls kill timeout after the first
// armed attempt (0: DefaultAbortFallbackTimeout). lock is the adapter's
// session lock.
func NewAbortFallback(kill func(), timeout time.Duration, lock sync.Locker) *AbortFallback {
	if timeout <= 0 {
		timeout = DefaultAbortFallbackTimeout
	}
	return &AbortFallback{kill: kill, timeout: timeout, lock: lock}
}

// Arm records one abort attempt; onFallback (may be nil) runs when the
// deadline passes, before kill. Once the fallback has triggered, onFallback
// runs at once. The returned func withdraws this attempt (an explicit
// refusal); withdrawing the last attempt clears the fallback. Call with lock held.
func (f *AbortFallback) Arm(onFallback func()) (withdraw func()) {
	if f.triggered {
		if onFallback != nil {
			onFallback()
		}
		return func() {}
	}
	attempt := &abortAttempt{onFallback: onFallback}
	f.attempts = append(f.attempts, attempt)
	if f.timer == nil {
		generation := f.generation
		f.timer = time.AfterFunc(f.timeout, func() { f.fire(generation) })
	}
	return func() {
		for index, armed := range f.attempts {
			if armed == attempt {
				f.attempts = append(f.attempts[:index:index], f.attempts[index+1:]...)
				if len(f.attempts) == 0 {
					f.Clear()
				}
				return
			}
		}
	}
}

func (f *AbortFallback) fire(generation uint64) {
	f.lock.Lock()
	defer f.lock.Unlock()
	if generation != f.generation || f.timer == nil {
		return
	}
	f.triggered = true
	// Recording acceptance can reenter controls and mutate the attempts.
	takeovers := append([]*abortAttempt(nil), f.attempts...)
	for _, attempt := range takeovers {
		if attempt.onFallback != nil {
			attempt.onFallback()
		}
	}
	f.kill()
}

// Clear stops the deadline and forgets every attempt (a turn end, a process
// exit, a dispose). Call with lock held.
func (f *AbortFallback) Clear() {
	if f.timer != nil {
		f.timer.Stop()
		f.timer = nil
	}
	f.generation++
	f.attempts = nil
	f.triggered = false
}
