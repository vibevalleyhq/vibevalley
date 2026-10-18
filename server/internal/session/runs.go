package session

// A run starts when the runtime opens a turn and ends with that turn's report. What started it is known only to whoever sent the input,
// so the sender leaves its trigger on the hand first (triggers, in order) and the turn takes the oldest; a turn nobody asked for is the
// runtime's own. Words steered into a running turn are heard by that run.

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/x/clock"
)

// Called before the input goes out, so the turn it opens finds it.
func (c *sessions) expect(h *hand, by protocol.RunTrigger) {
	h.mu.Lock()
	h.triggers = append(h.triggers, by)
	h.mu.Unlock()
}

// Undoes expect when the input did not open a turn.
func (c *sessions) unexpect(h *hand) {
	h.mu.Lock()
	if n := len(h.triggers); n > 0 {
		h.triggers = h.triggers[:n-1]
	}
	h.mu.Unlock()
}

func (c *sessions) startRun(h *hand) {
	h.mu.Lock()
	by := protocol.RunTrigger{Kind: protocol.RunTriggerKindRuntime}
	if len(h.triggers) > 0 {
		by, h.triggers = h.triggers[0], h.triggers[1:]
	}
	h.mu.Unlock()
	var issue sql.NullString
	if session := c.core.Session(h.id); session != nil && session.Issue != nil {
		issue = sql.NullString{String: *session.Issue, Valid: true}
	}
	trigger, _ := json.Marshal(by)
	id := base.NewID()
	err := c.q.StartRun(context.Background(), generated.StartRunParams{ID: id, Session: h.id, Issue: issue, TriggeredBy: string(trigger), StartedAt: clock.NowMs()})
	if err != nil {
		log.Printf("vibevalley: %s's run not kept: %v", h.id, err)
		return
	}
	h.mu.Lock()
	h.run, h.heard = id, nil
	h.mu.Unlock()
	h.journal.RunStarted(id)
}

func (c *sessions) heardInRun(h *hand, id string) {
	h.mu.Lock()
	run := h.run
	if run != "" {
		h.heard = append(h.heard, id)
	}
	heard, _ := json.Marshal(h.heard)
	h.mu.Unlock()
	if run == "" {
		return
	}
	if err := c.q.HeardInRun(context.Background(), generated.HeardInRunParams{Heard: sql.NullString{String: string(heard), Valid: true}, ID: run}); err != nil {
		log.Printf("vibevalley: run %s: %v", id, err)
	}
}

func (c *sessions) endRun(h *hand, outcome protocol.Outcome, summary string, spent *protocol.Spent) {
	h.mu.Lock()
	id := h.run
	h.run, h.heard = "", nil
	h.mu.Unlock()
	if id != "" {
		h.journal.RunEnded(id, outcome)
		c.finishRun(id, outcome, summary, spent)
	}
}

func (c *sessions) finishRun(id string, outcome protocol.Outcome, summary string, spent *protocol.Spent) error {
	params := generated.EndRunParams{
		EndedAt: sql.NullInt64{Int64: clock.NowMs(), Valid: true}, Outcome: sql.NullString{String: string(outcome), Valid: true},
		Summary: sql.NullString{String: summary, Valid: summary != ""}, ID: id,
	}
	if spent != nil {
		body, _ := json.Marshal(spent)
		params.Spent = sql.NullString{String: string(body), Valid: true}
	}
	if err := c.q.EndRun(context.Background(), params); err != nil {
		log.Printf("vibevalley: run %s: %v", id, err)
		return err
	}
	return nil
}

// The runs still going when the server stopped stopped with it.
func (c *sessions) endOpenRuns() {
	open, err := c.q.OpenRuns(context.Background())
	if err != nil {
		log.Printf("vibevalley: open runs: %v", err)
		return
	}
	for _, r := range open {
		c.finishRun(r.ID, protocol.OutcomeInterrupted, "VibeValley 重启了，这一轮停在了半路", nil)
	}
}

func (c *sessions) Runs(issue string) ([]protocol.Run, error) {
	rows, err := c.q.RunsOfIssue(context.Background(), sql.NullString{String: issue, Valid: true})
	if err != nil {
		return nil, err
	}
	out := make([]protocol.Run, 0, len(rows))
	for _, r := range rows {
		out = append(out, runOf(r))
	}
	return out, nil
}

func runOf(r generated.SessionRun) protocol.Run {
	run := protocol.Run{ID: r.ID, Session: r.Session, Heard: []string{}, StartedAt: r.StartedAt}
	if err := json.Unmarshal([]byte(r.TriggeredBy), &run.TriggeredBy); err != nil {
		log.Printf("vibevalley: run %s: what started it cannot be read: %v", r.ID, err)
	}
	if r.Issue.Valid {
		run.Issue = &r.Issue.String
	}
	if r.Heard.Valid {
		if err := json.Unmarshal([]byte(r.Heard.String), &run.Heard); err != nil {
			log.Printf("vibevalley: run %s: what it heard cannot be read: %v", r.ID, err)
		}
	}
	if r.EndedAt.Valid {
		run.EndedAt = &r.EndedAt.Int64
	}
	if r.Outcome.Valid {
		outcome := protocol.Outcome(r.Outcome.String)
		run.Outcome = &outcome
	}
	if r.Summary.Valid {
		run.Summary = &r.Summary.String
	}
	if r.Spent.Valid {
		var spent protocol.Spent
		if json.Unmarshal([]byte(r.Spent.String), &spent) == nil {
			run.Spent = &spent
		}
	}
	return run
}

func (c *sessions) CurrentRun(id string) string {
	h := c.hand(id)
	if h == nil {
		c.mu.Lock()
		execution := c.executions[id]
		c.mu.Unlock()
		if execution != nil {
			return execution.CurrentRun()
		}
		return ""
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.run
}
