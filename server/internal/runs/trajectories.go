package runs

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
)

// Trajectories (ported from the TypeScript server's trajectories.ts, removed): every helper's work, step by step, from the moment it is hired,
// kept after it leaves; and the manager's, which never ends. Each is two files in $VIBEVALLEY_HOME/steps: <id>.json, the
// steps as a journal writes them (steps.go), and <id>.head.json, whose it is and what for. A helper's is kept
// VIBEVALLEY_TRAJECTORY_DAYS (default 30) after it left, then dropped when the server starts. Rationale:
// .agents/notes/implemented/feature/2026-10-13-trajectories.md.

// crewKeepDays is how long a helper's trajectory is kept after it left, unless VIBEVALLEY_TRAJECTORY_DAYS says (0: for good).
const crewKeepDays = 30

// crewKnownID is a helper's id or the manager's: nothing that leads out of the folder.
var crewKnownID = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

type Trajectories struct {
	site *base.Site
	dir  string

	mu      sync.Mutex
	open    map[string]*crewJournal
	writers map[string]*base.FileWriter
	// marking: one head changed at a time, read to written.
	marking sync.Mutex
}

func newTrajectories(cfg base.Config, site *base.Site) (*Trajectories, error) {
	t := &Trajectories{site: site, dir: filepath.Join(cfg.Home, "steps"), open: map[string]*crewJournal{}, writers: map[string]*base.FileWriter{}}
	// The steps of those that ended long ago go; their heads stay, small, so the board keeps every ticket.
	days := crewKeepDays
	if v := os.Getenv("VIBEVALLEY_TRAJECTORY_DAYS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			days = n
		}
	}
	if days > 0 {
		old := base.NowMs() - int64(days)*base.DayMs
		for _, head := range t.heads() {
			if head.EndedAt != nil && *head.EndedAt < old {
				_ = os.Remove(t.stepsFile(head.ID))
			}
		}
	}
	return t, nil
}

func (*Trajectories) OnStart(context.Context) error { return nil }

// close writes whatever is pending.
func (t *Trajectories) OnStop() {
	t.mu.Lock()
	open := make([]*crewJournal, 0, len(t.open))
	for _, j := range t.open {
		open = append(open, j)
	}
	t.mu.Unlock()
	for _, j := range open {
		j.Close()
	}
}

func (t *Trajectories) stepsFile(id string) string { return filepath.Join(t.dir, id+".json") }
func (t *Trajectories) headFile(id string) string  { return filepath.Join(t.dir, id+".head.json") }

func (t *Trajectories) readHead(id string) *protocol.TrajectoryHead {
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

func (t *Trajectories) writeHead(head protocol.TrajectoryHead) error {
	t.mu.Lock()
	w, ok := t.writers[head.ID]
	if !ok {
		w = base.NewFileWriter(t.headFile(head.ID), 0o644)
		t.writers[head.ID] = w
	}
	t.mu.Unlock()
	return w.Write(func() ([]byte, error) { return json.Marshal(head) })
}

func (t *Trajectories) heads() []protocol.TrajectoryHead {
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

// Open is the journal of a trajectory, over its steps so far; its head is written now unless it has one (a helper
// back from a restart keeps its start). The steps go to the pages as step events as they come. keep: steps kept.
func (t *Trajectories) Open(head protocol.TrajectoryHead, keep int) base.Journal {
	since := head
	if had := t.readHead(head.ID); had != nil {
		since = *had
	}
	since.EndedAt = nil
	if err := t.writeHead(since); err != nil {
		log.Printf("vibevalley: could not save %s: %v", t.headFile(head.ID), err)
	}
	id := head.ID
	j := crewOpenJournal(t.stepsFile(id), crewReadJournal(t.stepsFile(id)), func(step protocol.WorkStep) { t.site.Step(id, step) }, keep)
	t.mu.Lock()
	t.open[id] = j
	t.mu.Unlock()
	return j
}

// Finish: the helper left; its journal written out and closed, its trajectory marked ended, with how its job
// closed and its last turn (helper as it was when it left; nil when unknown).
func (t *Trajectories) Finish(id string, closed protocol.IssueClose, helper *protocol.Helper) {
	t.mu.Lock()
	j := t.open[id]
	delete(t.open, id)
	t.mu.Unlock()
	if j != nil {
		j.Close()
	}
	t.mark(id, func(head *protocol.TrajectoryHead) {
		ended := base.NowMs()
		head.EndedAt, head.Closed = &ended, &closed
		if helper == nil {
			return
		}
		turns := helper.Turns
		head.Turns = &turns
		if last := helper.Last; last != nil {
			outcome, summary := last.Outcome, last.Summary
			head.Outcome, head.Summary = &outcome, &summary
		}
		if helper.Spent != nil && helper.Spent.CNY != nil {
			cny := *helper.Spent.CNY
			head.CNY = &cny
		}
	})
}

// mark changes a trajectory's head and writes it; nothing when there is none.
func (t *Trajectories) mark(id string, change func(*protocol.TrajectoryHead)) {
	t.marking.Lock()
	defer t.marking.Unlock()
	if head := t.readHead(id); head != nil {
		change(head)
		_ = t.writeHead(*head)
	}
}

// List is whose trajectories there are, newest first; one agent's when agent is not empty.
func (t *Trajectories) List(agent string) []protocol.TrajectoryHead {
	out := []protocol.TrajectoryHead{}
	for _, h := range t.heads() {
		if agent == "" || (h.Agent != nil && *h.Agent == agent) {
			out = append(out, h)
		}
	}
	slices.SortStableFunc(out, func(a, b protocol.TrajectoryHead) int { return int(b.StartedAt - a.StartedAt) })
	return out
}

func (t *Trajectories) Get(id string) *protocol.Trajectory {
	if !crewKnownID.MatchString(id) {
		return nil
	}
	head := t.readHead(id)
	if head == nil {
		return nil
	}
	t.mu.Lock()
	j := t.open[id]
	t.mu.Unlock()
	var steps []protocol.WorkStep
	if j != nil {
		steps = j.Steps()
	} else {
		steps = crewReadJournal(t.stepsFile(id))
	}
	return &protocol.Trajectory{Head: *head, Steps: steps}
}
