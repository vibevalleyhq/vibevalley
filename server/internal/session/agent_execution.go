package session

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"

	vvagent "vibevalley/internal/agent/brain"
	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/x/clock"
)

// RunInput is attached only when the loop consumes an input, not when it is queued.
type RunInput struct {
	Issue string              `json:"issue,omitempty"`
	By    protocol.RunTrigger `json:"by"`
	Heard []string            `json:"heard,omitempty"`
	// What the journal shows was asked; the message's text when "".
	Asked string `json:"-"`
}

type InputConsumed struct {
	Session  string
	Messages []string
}

func (c *sessions) InputsConsumed() *base.Hub[InputConsumed] { return c.consumed }

type RunFinished struct {
	ID      string
	Issues  []string
	Outcome protocol.Outcome
}

func (c *sessions) FinishedRuns() *base.Hub[RunFinished] { return c.finished }

// AgentExecution owns the run and its journal for an in-process agent loop.
// One agent_start/agent_end interval can consume inputs for several issues.
type AgentExecution struct {
	mu        sync.Mutex
	sessions  *sessions
	session   string
	journal   Journal
	toolStart func(string, json.RawMessage) ToolStart
	run       string
	outcome   protocol.Outcome
	summary   string
	heard     []string
	closed    bool
	// The input a restarted agent's run goes on with: consumed before the restart, so no event of the run carries it.
	resuming *RunInput
	// Terminal persistence may need retrying, but that run cannot accept more inputs.
	ending bool
}

func (c *sessions) AgentExecution(id string, journal Journal, toolStart func(string, json.RawMessage) ToolStart) *AgentExecution {
	x := &AgentExecution{sessions: c, session: id, journal: journal, toolStart: toolStart}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.executions == nil {
		c.executions = map[string]*AgentExecution{}
	}
	c.executions[id] = x
	return x
}

func (x *AgentExecution) begin(input RunInput) error {
	if x.ending {
		if err := x.finish(); err != nil {
			return err
		}
	}
	if x.run != "" {
		if input.Issue != "" {
			return x.sessions.q.LinkRunIssue(context.Background(), generated.LinkRunIssueParams{Run: x.run, Issue: input.Issue})
		}
		return nil
	}
	if input.Issue == "" && input.By.Kind == "" && x.resuming != nil {
		input = *x.resuming
	}
	x.resuming = nil
	if input.By.Kind == "" {
		input.By.Kind = protocol.RunTriggerKindRuntime
	}
	trigger, err := json.Marshal(input.By)
	if err != nil {
		return err
	}
	id := base.NewID()
	tx, err := x.sessions.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	q := x.sessions.q.WithTx(tx)
	if err := q.StartRun(context.Background(), generated.StartRunParams{ID: id, Session: x.session, Issue: sql.NullString{String: input.Issue, Valid: input.Issue != ""}, TriggeredBy: string(trigger), StartedAt: clock.NowMs()}); err != nil {
		return err
	}
	if input.Issue != "" {
		if err := q.LinkRunIssue(context.Background(), generated.LinkRunIssueParams{Run: id, Issue: input.Issue}); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	x.run, x.outcome, x.summary = id, protocol.OutcomeCompleted, ""
	x.heard = nil
	x.journal.RunStarted(id)
	return nil
}

func (x *AgentExecution) finish() error {
	if x.run == "" {
		return nil
	}
	x.ending = true
	issues, err := x.sessions.q.RunIssues(context.Background(), x.run)
	if err != nil {
		return err
	}
	if err := x.sessions.finishRun(x.run, x.outcome, x.summary, nil); err != nil {
		return err
	}
	x.journal.RunEnded(x.run, x.outcome)
	result := RunFinished{ID: x.run, Issues: issues, Outcome: x.outcome}
	x.run = ""
	x.ending = false
	x.sessions.finished.Publish(result)
	return nil
}

// Observe receives the ordered harness events; input is non-nil only for a consumed input message.
func (x *AgentExecution) Observe(e vvagent.AgentEvent, input *RunInput) error {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.closed {
		return nil
	}
	if input != nil {
		message, ok := e.(agentcore.MessageStarted)
		if !ok {
			return errors.New("run input requires a message start")
		}
		if err := x.begin(*input); err != nil {
			return err
		}
		if len(input.Heard) > 0 {
			for _, id := range input.Heard {
				if !slices.Contains(x.heard, id) {
					x.heard = append(x.heard, id)
				}
			}
			body, err := json.Marshal(x.heard)
			if err != nil {
				return err
			}
			if err := x.sessions.q.HeardInRun(context.Background(), generated.HeardInRunParams{ID: x.run, Heard: sql.NullString{String: string(body), Valid: true}}); err != nil {
				return err
			}
			x.sessions.consumed.Publish(InputConsumed{Session: x.session, Messages: slices.Clone(input.Heard)})
		}
		asked := input.Asked
		if asked == "" {
			asked = vvagent.MessageText(message.Message)
		}
		x.journal.Asked(asked, nil)
	}
	switch e := e.(type) {
	case agentcore.AgentEnded:
		if e.Aborted && !x.ending {
			x.outcome = protocol.OutcomeInterrupted
		}
		return x.finish()
	case agentcore.MessageEnded:
		m, ok := e.Message.(ai.AssistantMessage)
		if !ok {
			return nil
		}
		if err := x.begin(RunInput{}); err != nil {
			return err
		}
		for _, part := range m.Content {
			if part.Type == ai.TypeThinking && !part.Redacted {
				x.journal.Thought(part.Thinking, nil)
			}
		}
		text := strings.TrimSpace(vvagent.MessageText(m))
		x.journal.Said(text, nil)
		x.summary = text
		switch m.StopReason {
		case ai.StopError:
			x.outcome = protocol.OutcomeFailed
			x.summary = m.ErrorMessage
			if x.summary == "" {
				x.summary = "模型出错了"
			}
			x.journal.Note(protocol.SessionEventTypeRunError, x.summary, nil)
		case ai.StopAborted:
			x.outcome = protocol.OutcomeInterrupted
		}
	case agentcore.ToolStarted:
		if err := x.begin(RunInput{}); err != nil {
			return err
		}
		x.journal.ToolStarted(e.ToolCallID, x.toolStart(e.ToolName, e.Args), nil)
	case agentcore.ToolEnded:
		if err := x.begin(RunInput{}); err != nil {
			return err
		}
		text := agentcore.ResultText(e.Result.Content)
		x.journal.ToolEnded(e.ToolCallID, text, !e.IsError, nil)
	}
	return nil
}

// FailedStart records a rejected input as its own failed run, without consuming another input's work.
func (x *AgentExecution) FailedStart(input RunInput, text, reason string) (string, error) {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.closed {
		return "", nil
	}
	if x.run != "" && !x.ending {
		return "", errors.New("another agent execution is still running")
	}
	if err := x.begin(input); err != nil {
		return "", err
	}
	x.journal.Asked(text, nil)
	x.outcome, x.summary = protocol.OutcomeFailed, reason
	x.journal.Note(protocol.SessionEventTypeRunError, reason, nil)
	id := x.run
	return id, x.finish()
}

// Resuming names the input of the next run, which goes on with one consumed before a restart; nil forgets it.
func (x *AgentExecution) Resuming(input *RunInput) {
	x.mu.Lock()
	defer x.mu.Unlock()
	x.resuming = input
}

func (x *AgentExecution) Close() error {
	x.mu.Lock()
	defer x.mu.Unlock()
	x.closed = true
	if x.run != "" && !x.ending {
		x.outcome = protocol.OutcomeInterrupted
		x.summary = "VibeValley 停下了，这一轮中断了"
	}
	return x.finish()
}

func (x *AgentExecution) CurrentRun() string {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.ending {
		return ""
	}
	return x.run
}
