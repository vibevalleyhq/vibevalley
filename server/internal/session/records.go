package session

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/x/clock"
)

// Every session is a row from the moment it is sent: on the farm the core state has the rest of it (its phase, its plot),
// ended its row says when and how its issue took it, and its runs are session_run.

func (c *sessions) keep(s protocol.Session) {
	params := generated.KeepSessionParams{ID: s.ID, Agent: s.Agent, Name: s.Name, Runtime: s.Runtime, Task: s.Task, Project: recordText(s.Project),
		Issue: recordText(s.Issue), HiredAt: s.HiredAt}
	if s.Playbook != nil {
		body, _ := json.Marshal(s.Playbook)
		params.Playbook = sql.NullString{String: string(body), Valid: true}
	}
	if err := c.q.KeepSession(context.Background(), params); err != nil {
		log.Printf("vibevalley: session %s not kept: %v", s.ID, err)
	}
}

func (c *sessions) ended(id string, closed protocol.IssueClose) {
	err := c.q.EndSession(context.Background(), generated.EndSessionParams{EndedAt: sql.NullInt64{Int64: clock.NowMs(), Valid: true},
		Closed: sql.NullString{String: string(closed), Valid: true}, ID: id})
	if err != nil {
		log.Printf("vibevalley: session %s's end not kept: %v", id, err)
	}
}

// List is every session of the agent, or of every agent when it is empty: on the farm and ended, newest first.
func (c *sessions) List(agent string) []protocol.Session {
	out := []protocol.Session{}
	for _, s := range c.core.State().Sessions {
		if agent == "" || s.Agent == agent {
			out = append(out, s)
		}
	}
	rows, err := c.q.EndedSessions(context.Background(), agent)
	if err != nil {
		log.Printf("vibevalley: sessions: %v", err)
	}
	runs, err := c.q.RunsOfEndedSessions(context.Background())
	if err != nil {
		log.Printf("vibevalley: sessions' runs: %v", err)
	}
	bySession := map[string][]generated.SessionRun{}
	for _, r := range runs {
		bySession[r.Session] = append(bySession[r.Session], r)
	}
	for _, r := range rows {
		if !slices.ContainsFunc(out, func(s protocol.Session) bool { return s.ID == r.ID }) {
			out = append(out, endedSession(r, bySession[r.ID]))
		}
	}
	slices.SortStableFunc(out, func(a, b protocol.Session) int { return int(b.HiredAt - a.HiredAt) })
	return out
}

// Get is a session on the farm, or one that has ended; nil when there is none.
func (c *sessions) Get(id string) *protocol.Session {
	if s := c.core.Session(id); s != nil {
		return s
	}
	r, err := c.q.SessionByID(context.Background(), id)
	if err != nil || !r.EndedAt.Valid {
		return nil
	}
	runs, _ := c.q.RunsOfSession(context.Background(), id)
	s := endedSession(r, runs)
	return &s
}

// An ended session as the core state would have had it: its runs counted, its last one's word, what it spent in all.
func endedSession(r generated.Session, runs []generated.SessionRun) protocol.Session {
	s := protocol.Session{ID: r.ID, Name: r.Name, Agent: r.Agent, Runtime: r.Runtime, Task: r.Task, HiredAt: r.HiredAt, Runs: int64(len(runs)),
		Project: recordPtr(r.Project), Issue: recordPtr(r.Issue),
		Phase: protocol.Phase{Value: protocol.PhaseClosed{At: r.EndedAt.Int64, Closed: protocol.IssueClose(r.Closed.String)}}}
	if r.Playbook.Valid {
		var p protocol.SessionPlaybook
		if json.Unmarshal([]byte(r.Playbook.String), &p) == nil {
			s.Playbook = &p
		}
	}
	var spent protocol.Spent
	var cny float64
	priced := false
	for _, run := range runs {
		var one protocol.Spent
		if run.Spent.Valid && json.Unmarshal([]byte(run.Spent.String), &one) == nil {
			spent.Tokens += one.Tokens
			if one.CNY != nil {
				cny, priced = cny+*one.CNY, true
			}
		}
	}
	if priced {
		spent.CNY = &cny
	}
	if spent.Tokens > 0 || priced {
		s.Spent = &spent
	}
	if n := len(runs); n > 0 && runs[n-1].Outcome.Valid {
		last := runs[n-1]
		s.LastRun = &protocol.LastRun{Outcome: protocol.Outcome(last.Outcome.String), Summary: last.Summary.String, At: last.EndedAt.Int64}
	}
	return s
}

// Before the table a session's head was events/<id>.head.json: each is moved in once and removed.
func (c *sessions) moveHeads() {
	entries, err := os.ReadDir(c.trajectories.dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".head.json") {
			continue
		}
		file := filepath.Join(c.trajectories.dir, e.Name())
		body, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		var h struct {
			ID, Name                            string
			Agent, Runtime, Project, Job, Issue *string
			StartedAt                           int64
			EndedAt                             *int64
			Closed                              *string
			Playbook                            json.RawMessage
		}
		if json.Unmarshal(body, &h) != nil || h.ID == "" || h.ID == protocol.ManagerAgent {
			_ = os.Remove(file)
			continue
		}
		params := generated.MoveHeadParams{ID: h.ID, Agent: recordValue(h.Agent), Name: h.Name, Runtime: recordValue(h.Runtime), Task: recordValue(h.Job),
			Project: recordText(h.Project), Issue: recordText(h.Issue), HiredAt: h.StartedAt, Closed: recordText(h.Closed)}
		if len(h.Playbook) > 0 && string(h.Playbook) != "null" {
			params.Playbook = sql.NullString{String: string(h.Playbook), Valid: true}
		}
		if h.EndedAt != nil {
			params.EndedAt = sql.NullInt64{Int64: *h.EndedAt, Valid: true}
		}
		if err := c.q.MoveHead(context.Background(), params); err != nil {
			log.Printf("vibevalley: %s not moved in: %v", file, err)
			continue
		}
		_ = os.Remove(file)
	}
}

// The logs of sessions that ended more than days ago go; the sessions stay, small, so the board keeps every issue.
func (c *sessions) expireLogs(days int) {
	if days <= 0 {
		return
	}
	ids, err := c.q.SessionsEndedBefore(context.Background(), sql.NullInt64{Int64: clock.NowMs() - int64(days)*protocol.DayMs, Valid: true})
	if err != nil {
		log.Printf("vibevalley: old logs: %v", err)
		return
	}
	for _, id := range ids {
		c.trajectories.forget(id)
	}
}

func recordText(s *string) sql.NullString {
	if s == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *s, Valid: true}
}

func recordPtr(s sql.NullString) *string {
	if !s.Valid {
		return nil
	}
	return &s.String
}

func recordValue(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
