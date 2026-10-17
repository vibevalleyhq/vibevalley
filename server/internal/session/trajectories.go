package session

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"

	"vibevalley/internal/base"
	"vibevalley/internal/core"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/clock"
)

// Nothing that leads out of the folder.
var knownID = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

type trajectories struct {
	core *core.Service
	dir  string

	mu      sync.Mutex
	open    map[string]*journal
	writers map[string]*base.FileWriter
	// One head changed at a time, read to written.
	marking sync.Mutex
}

func newTrajectories(cfg base.Config, core *core.Service) (*trajectories, error) {
	t := &trajectories{core: core, dir: filepath.Join(cfg.Home, "activities"), open: map[string]*journal{}, writers: map[string]*base.FileWriter{}}
	// The steps of those that ended long ago go; their heads stay, small, so the board keeps every issue.
	if days := cfg.Trajectory.Days; days > 0 {
		old := clock.NowMs() - int64(days)*protocol.DayMs
		for _, head := range t.heads() {
			if head.EndedAt != nil && *head.EndedAt < old {
				_ = os.Remove(t.activitiesFile(head.ID))
			}
		}
	}
	return t, nil
}

func (*trajectories) OnStart(context.Context) error { return nil }

func (t *trajectories) OnStop() {
	t.mu.Lock()
	open := make([]*journal, 0, len(t.open))
	for _, j := range t.open {
		open = append(open, j)
	}
	t.mu.Unlock()
	for _, j := range open {
		j.Close()
	}
}

func (t *trajectories) activitiesFile(id string) string { return filepath.Join(t.dir, id+".json") }
func (t *trajectories) headFile(id string) string       { return filepath.Join(t.dir, id+".head.json") }

func (t *trajectories) readHead(id string) *protocol.TrajectoryHead {
	body, err := os.ReadFile(t.headFile(id))
	if err != nil {
		return nil
	}
	var head protocol.TrajectoryHead
	if json.Unmarshal(body, &head) != nil || head.ID == "" {
		return nil
	}
	return &head
}

func (t *trajectories) writeHead(head protocol.TrajectoryHead) error {
	t.mu.Lock()
	w, ok := t.writers[head.ID]
	if !ok {
		w = base.NewFileWriter(t.headFile(head.ID), 0o644)
		t.writers[head.ID] = w
	}
	t.mu.Unlock()
	return w.Write(func() ([]byte, error) { return json.Marshal(head) })
}

func (t *trajectories) heads() []protocol.TrajectoryHead {
	entries, err := os.ReadDir(t.dir)
	if err != nil {
		return nil
	}
	var out []protocol.TrajectoryHead
	for _, e := range entries {
		if name, ok := strings.CutSuffix(e.Name(), ".head.json"); ok {
			if head := t.readHead(name); head != nil {
				out = append(out, *head)
			}
		}
	}
	return out
}

// Its head is written now unless it has one: a session back from a restart keeps its start.
func (t *trajectories) Open(head protocol.TrajectoryHead, keep int) Journal {
	since := head
	if had := t.readHead(head.ID); had != nil {
		since = *had
	}
	since.EndedAt = nil
	if err := t.writeHead(since); err != nil {
		log.Printf("vibevalley: could not save %s: %v", t.headFile(head.ID), err)
	}
	id := head.ID
	j := openJournal(t.activitiesFile(id), readJournal(t.activitiesFile(id)), func(step protocol.Activity) { t.core.Activity(id, step) }, keep)
	t.mu.Lock()
	t.open[id] = j
	t.mu.Unlock()
	return j
}

func (t *trajectories) Finish(id string, closed protocol.IssueClose, session *protocol.Session) {
	t.mu.Lock()
	j := t.open[id]
	delete(t.open, id)
	t.mu.Unlock()
	if j != nil {
		j.Close()
	}
	t.mark(id, func(head *protocol.TrajectoryHead) {
		ended := clock.NowMs()
		head.EndedAt, head.Closed = &ended, &closed
		if session == nil {
			return
		}
		runs := session.Runs
		head.Runs = &runs
		if last := session.LastRun; last != nil {
			outcome, summary := last.Outcome, last.Summary
			head.Outcome, head.Summary = &outcome, &summary
		}
		if session.Spent != nil && session.Spent.CNY != nil {
			cny := *session.Spent.CNY
			head.CNY = &cny
		}
	})
}

func (t *trajectories) mark(id string, change func(*protocol.TrajectoryHead)) {
	t.marking.Lock()
	defer t.marking.Unlock()
	if head := t.readHead(id); head != nil {
		change(head)
		if err := t.writeHead(*head); err != nil {
			log.Printf("vibevalley: the trajectory of %s was not marked: %v", id, err)
		}
	}
}

func (t *trajectories) List(agent string) []protocol.TrajectoryHead {
	out := []protocol.TrajectoryHead{}
	for _, h := range t.heads() {
		if agent == "" || (h.Agent != nil && *h.Agent == agent) {
			out = append(out, h)
		}
	}
	slices.SortStableFunc(out, func(a, b protocol.TrajectoryHead) int { return int(b.StartedAt - a.StartedAt) })
	return out
}

func (t *trajectories) Get(id string) *protocol.Trajectory {
	if !knownID.MatchString(id) {
		return nil
	}
	head := t.readHead(id)
	if head == nil {
		return nil
	}
	t.mu.Lock()
	j := t.open[id]
	t.mu.Unlock()
	var steps []protocol.Activity
	if j != nil {
		steps = j.Activities()
	} else {
		steps = readJournal(t.activitiesFile(id))
	}
	return &protocol.Trajectory{Head: *head, Activities: steps}
}
