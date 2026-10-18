package brain

import (
	"strings"
	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
)

// RunResult describes one complete Agent run, including its tool turns and queued follow-ups.
// Usage excludes earlier runs; ContextTokens is the most recent model request's consumed context.
type RunResult struct {
	ID            uint64
	Usage         ai.Usage
	ContextTokens int
	Text          string
	Aborted       bool
	Error         string
	Settled       bool
}

// RunSnapshot includes usage already received in an unfinished model response.
// Lifetime is cumulative for this Agent instance, not reconstructed from its loaded transcript.
type RunSnapshot struct {
	Current  RunResult
	Lifetime ai.Usage
}

type runAccounting struct {
	current  RunResult
	previous ai.Usage
	pending  ai.Usage
}

func copyUsage(u ai.Usage) ai.Usage {
	if u.Reasoning != nil {
		n := *u.Reasoning
		u.Reasoning = &n
	}
	return u
}
func addUsage(a, b ai.Usage) ai.Usage {
	a.Input += b.Input
	a.Output += b.Output
	a.CacheRead += b.CacheRead
	a.CacheWrite += b.CacheWrite
	a.TotalTokens += b.TotalTokens
	a.Cost.Input += b.Cost.Input
	a.Cost.Output += b.Cost.Output
	a.Cost.CacheRead += b.Cost.CacheRead
	a.Cost.CacheWrite += b.Cost.CacheWrite
	a.Cost.Total += b.Cost.Total
	if a.Reasoning != nil || b.Reasoning != nil {
		n := 0
		if a.Reasoning != nil {
			n += *a.Reasoning
		}
		if b.Reasoning != nil {
			n += *b.Reasoning
		}
		a.Reasoning = &n
	}
	return a
}
func (r *runAccounting) active() bool { return r.current.ID != 0 && !r.current.Settled }
func (r *runAccounting) begin() {
	if r.active() {
		return
	}
	r.previous = addUsage(r.previous, r.current.Usage)
	r.current = RunResult{ID: r.current.ID + 1}
	r.pending = ai.Usage{}
}
func (r *runAccounting) partial(m ai.AssistantMessage) {
	if !r.active() {
		r.begin()
	}
	r.pending = copyUsage(m.Usage)
	r.current.ContextTokens = m.Usage.Input + m.Usage.CacheRead + m.Usage.Output
}
func (r *runAccounting) message(m ai.AssistantMessage) {
	if !r.active() {
		r.begin()
	}
	r.pending = ai.Usage{}
	r.current.Usage = addUsage(r.current.Usage, m.Usage)
	r.current.ContextTokens = m.Usage.Input + m.Usage.CacheRead + m.Usage.Output
	text := strings.TrimSpace(MessageText(m))
	if text != "" {
		r.current.Text = text
	}
	r.current.Error = ""
	if m.StopReason == ai.StopError {
		r.current.Error = m.ErrorMessage
		if r.current.Error == "" {
			r.current.Error = "模型出错了"
		}
	}
	r.current.Aborted = m.StopReason == ai.StopAborted
}
func (r *runAccounting) snapshot() RunSnapshot {
	current := r.current
	current.Usage = addUsage(copyUsage(current.Usage), r.pending)
	return RunSnapshot{Current: current, Lifetime: addUsage(copyUsage(r.previous), current.Usage)}
}
func (r *runAccounting) settle(aborted bool) RunResult {
	r.current.Usage = addUsage(r.current.Usage, r.pending)
	r.pending = ai.Usage{}
	r.current.Aborted = r.current.Aborted || aborted
	r.current.Settled = true
	return r.snapshot().Current
}

// Called before publishing the consumed core event.
func (a *Agent) observeRun(event agentcore.AgentEvent) {
	a.mu.Lock()
	defer a.mu.Unlock()
	switch e := event.(type) {
	case agentcore.AgentStarted:
		a.accounting.begin()
	case agentcore.MessageStarted:
		if message, ok := e.Message.(ai.AssistantMessage); ok {
			a.accounting.partial(message)
		}
	case agentcore.MessageUpdated:
		a.accounting.partial(e.Message)
	case agentcore.MessageEnded:
		if m, ok := e.Message.(ai.AssistantMessage); ok {
			a.accounting.message(m)
		} else if e.Message.Role() == "user" || e.Message.Role() == "custom" {
			a.accounting.current.Text = ""
		}
	case agentcore.AgentEnded:
		a.accounting.current.Aborted = a.accounting.current.Aborted || e.Aborted
	}
}

func (a *Agent) Progress() RunSnapshot {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.accounting.snapshot()
}
