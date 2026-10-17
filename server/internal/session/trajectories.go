package session

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"sync"

	"vibevalley/internal/base"
	"vibevalley/internal/core"
	"vibevalley/internal/protocol"
)

// Nothing that leads out of the folder.
var knownID = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// trajectories keeps each session's log of events, events/<id>.json: the open ones in memory as they grow, the others on
// disk. Who the session is lives in the session table (records.go).
type trajectories struct {
	core *core.Service
	dir  string

	mu   sync.Mutex
	open map[string]*journal
}

func newTrajectories(cfg base.Config, core *core.Service) (*trajectories, error) {
	t := &trajectories{core: core, dir: filepath.Join(cfg.Home, "events"), open: map[string]*journal{}}
	if err := moveActivities(filepath.Join(cfg.Home, "activities"), t.dir); err != nil {
		return nil, err
	}
	if err := splitAllResults(t.dir); err != nil {
		return nil, err
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

func (t *trajectories) eventsFile(id string) string { return filepath.Join(t.dir, id+".json") }

// Open is a session's log, carried on from what it kept: a session back from a restart goes on where it was.
func (t *trajectories) Open(id string, keep int) Journal {
	j := openJournal(t.eventsFile(id), readJournal(t.eventsFile(id)), func(e protocol.SessionEvent) { t.core.SessionEvent(id, e) }, keep)
	t.mu.Lock()
	t.open[id] = j
	t.mu.Unlock()
	return j
}

// Finish writes the log out and lets it go; it stays on disk.
func (t *trajectories) Finish(id string) {
	t.mu.Lock()
	j := t.open[id]
	delete(t.open, id)
	t.mu.Unlock()
	if j != nil {
		j.Close()
	}
}

// Events is a session's log, oldest first: from memory while it is open, else from disk; run > 0 is that run's only.
func (t *trajectories) Events(id string, run int64) []protocol.SessionEvent {
	if !knownID.MatchString(id) {
		return nil
	}
	t.mu.Lock()
	j := t.open[id]
	t.mu.Unlock()
	var all []protocol.SessionEvent
	if j != nil {
		all = j.Events()
	} else {
		all = readJournal(t.eventsFile(id))
	}
	if run <= 0 {
		return all
	}
	out := []protocol.SessionEvent{}
	for _, e := range all {
		if e.Run != nil && *e.Run == run {
			out = append(out, e)
		}
	}
	return out
}

// forget deletes a session's log; who it was stays in the table.
func (t *trajectories) forget(id string) {
	if knownID.MatchString(id) {
		_ = os.Remove(t.eventsFile(id))
	}
}
