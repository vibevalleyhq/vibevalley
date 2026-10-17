package memory

import (
	"context"

	"vibevalley/internal/protocol"
)

// This farm's own memories, in the memory table, picked by recall.go. Always there and always first.
type localProvider struct{ m *memories }

const localName = "local"

func (localProvider) Name() string              { return localName }
func (localProvider) Available() (bool, string) { return true, "" }

func (l localProvider) OnStart(ctx context.Context) error { return l.m.OnStart(ctx) }
func (l localProvider) OnStop()                           { l.m.OnStop() }

// pick has already ordered and bounded them: the score only keeps that order when lines from several providers meet.
func (l localProvider) Prefetch(_ context.Context, cue RecallCue) ([]recalledLine, error) {
	var lines []string
	var ids []string
	if cue.Peek {
		lines = l.m.Preview(cue.Agent, cue.Project, cue.Text).Lines
	} else {
		found := l.m.Recall(cue)
		lines, ids = found.Lines, found.IDs
	}
	out := make([]recalledLine, len(lines))
	for i, line := range lines {
		out[i] = recalledLine{Line: line, Score: float64(len(lines) - i)}
		if i < len(ids) {
			out[i].ID = ids[i]
		}
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
