package acp

import (
	"sync"
	"time"
)

// DefaultUsageUpdateTimeout bounds the wait for a post-answer usage_update.
const DefaultUsageUpdateTimeout = 500 * time.Millisecond

// UsageGate bridges the gap between an agent's `session/prompt` answer and
// the `usage_update` it pushes afterwards (usage-wait.ts). kimi-code
// f9ca33376 resolves the prompt response and then `void
// this.emitUsageUpdate()`, which awaits the model catalog and the context
// before notifying, and returns without a push when the catalog has no
// `max_context_size` for the current model. Recording the answer's
// turn_ended on the response alone leaves contextUsage() at the PREVIOUS
// turn's value, and there is no guarantee an update ever comes: hence a
// bounded wait, not a barrier.
type UsageGate struct {
	mu      sync.Mutex
	seen    bool
	release chan struct{}
}

// NewUsageGate is a gate that has seen nothing.
func NewUsageGate() *UsageGate { return &UsageGate{} }

// Arm forgets any update seen so far; call before sending the prompt.
func (g *UsageGate) Arm() {
	g.mu.Lock()
	g.seen = false
	g.mu.Unlock()
}

// Observe is fed every recorded root update; only one that carried a usage event counts as arrival.
func (g *UsageGate) Observe(usage bool) {
	if !usage {
		return
	}
	g.mu.Lock()
	g.seen = true
	if g.release != nil {
		close(g.release)
		g.release = nil
	}
	g.mu.Unlock()
}

// Settle is the wait after a prompt response: nil when none is due (the
// profile does not declare the late push, the turn is being aborted, or an
// update already arrived since Arm); otherwise a function that returns once
// one arrives or after the profile's bound. Call the function without
// holding a lock the update's recorder takes.
func (g *UsageGate) Settle(profile Profile, aborting bool) func() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !profile.UsageUpdateAfterPrompt || aborting || g.seen {
		return nil
	}
	timeout := profile.UsageUpdateTimeout
	if timeout <= 0 {
		timeout = DefaultUsageUpdateTimeout
	}
	release := make(chan struct{})
	g.release = release
	return func() {
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		select {
		case <-release:
		case <-timer.C:
		}
		g.mu.Lock()
		if g.release == release {
			g.release = nil
		}
		g.mu.Unlock()
	}
}
