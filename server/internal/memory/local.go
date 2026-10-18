package memory

import (
	"context"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/clock"
)

// This farm's own memories, in the memory table, picked by recall.go. Always there and always first.
type localProvider struct {
	m *memories
	// The profiles a search for every one looks through.
	profiles func() []string
}

const localName = "local"

func (localProvider) Name() string              { return localName }
func (localProvider) Available() (bool, string) { return true, "" }

func (l localProvider) OnStart(ctx context.Context) error { return l.m.OnStart(ctx) }
func (l localProvider) OnStop()                           { l.m.OnStop() }

// pick has already ordered and bounded them; nothing is marked recalled here: the manager marks those kept after merging.
func (l localProvider) Prefetch(_ context.Context, cue RecallCue) ([]recalledLine, error) {
	var picked []protocol.Memory
	if cue.Peek {
		if cue.Project == "" {
			return nil, nil
		}
		all, err := l.m.list(cue.Agent)
		if err != nil {
			return nil, err
		}
		picked = pick(all, pickCue{Project: cue.Project, Text: cue.Text, Now: clock.NowMs()})
	} else {
		picked = l.m.recallable(cue)
	}
	out := make([]recalledLine, len(picked))
	for i, m := range picked {
		out[i] = recalledLine{ID: m.ID, Line: lineOf(m, cue.Project), Score: float64(len(picked) - i)}
	}
	return out, nil
}

func (l localProvider) SyncTurn(_ context.Context, run FinishedRun) error {
	l.m.Keep(run)
	return nil
}

func (l localProvider) List(_ context.Context, agent string) ([]protocol.Memory, error) {
	return l.m.List(agent), nil
}

func (l localProvider) Add(_ context.Context, n Note) (protocol.Memory, error) {
	return l.m.Write(n.Agent, n.Text, n.Project)
}

func (l localProvider) Forget(_ context.Context, agent, id string) error {
	return l.m.Forget(agent, id)
}

func (l localProvider) Search(_ context.Context, q SearchQuery) ([]Found, error) {
	agents := []string{q.Agent}
	if q.Agent == "" {
		agents = l.profiles()
	}
	var all []protocol.Memory
	for _, agent := range agents {
		listed, err := l.m.list(agent)
		if err != nil {
			return nil, err
		}
		all = append(all, listed...)
	}
	return search(all, q), nil
}

func (localProvider) Can() abilities { return abilities{List: true, Forget: true} }

func (localProvider) OnSessionEnd(context.Context, EndedSession) error { return nil }
