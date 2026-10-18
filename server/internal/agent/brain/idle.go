package brain

// Folding when the run ends would give the owner a lossy summary a minute later; folding when they have gone keeps the
// conversation as it was while they are likely to go on with it.

import (
	"time"

	"vibevalley/pkg/agentcore"
)

func (a *Agent) idleAfter() time.Duration {
	if a.options.IdleFoldAfter == 0 {
		return 10 * time.Minute
	}
	return a.options.IdleFoldAfter
}

func (a *Agent) idleAt() int {
	if a.options.IdleFoldAt == 0 {
		return a.folding.Budget * 4 / 5
	}
	return a.options.IdleFoldAt
}

func (a *Agent) stopIdleLocked() {
	if a.idle != nil {
		a.idle.Stop()
		a.idle = nil
	}
}

func (a *Agent) idleLaterLocked() {
	after := a.idleAfter()
	if after < 0 || EstimateTokens(a.Core.State().Messages) <= a.idleAt() {
		return
	}
	a.stopIdleLocked()
	a.idle = time.AfterFunc(after, a.foldIdle)
}

func (a *Agent) quietLocked() bool { return !a.accounting.active() && !a.Core.HasQueuedMessages() }

func (a *Agent) foldIdle() {
	a.mu.Lock()
	a.idle = nil
	quiet := a.quietLocked()
	a.mu.Unlock()
	if a.ctx.Err() != nil || !quiet {
		return
	}
	if a.options.WakeSoon != nil && a.options.WakeSoon(a.idleAfter()) {
		return
	}
	state := a.Core.State()
	folding := a.folding
	folding.Budget = a.idleAt()
	result, _ := a.fold(a.ctx, state.Messages, state.Tools, folding, "idle")
	if result == nil {
		return
	}
	a.foldMu.Lock()
	a.folds = map[string]CompactionSummaryMessage{}
	a.foldMu.Unlock()
	// What came in while the summary was being made is not lost: the fold is dropped, and done again when it is idle next.
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.Core.State().Messages
	if !a.quietLocked() || !sameMessages(now, state.Messages) {
		return
	}
	a.Core.SetMessages(result.messages)
	if a.session != nil {
		_ = a.session.Append(result.summary)
	}
	a.refreshPrefix()
}

func sameMessages(a, b []agentcore.AgentMessage) bool {
	return len(a) == len(b) && (len(a) == 0 || a[len(a)-1].Time() == b[len(b)-1].Time())
}
