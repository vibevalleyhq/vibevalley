package memory

import (
	"cmp"
	"context"
	"errors"
	"log"
	"slices"
	"strings"
	"sync"
	"time"

	"vibevalley/internal/agent"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/str"
)

// How long a provider outside the farm may take to say what a starting run recalls; past it the run starts without it.
// Hermes gives external providers 8 s; a run waiting on it is the owner waiting, so less.
const prefetchTimeout = 2 * time.Second

// Every provider, the local one first: what the rest of the farm calls (Hermes's MemoryManager). The local one is embedded
// too, so what only it has (keep, for the tests) still reaches the Service.
type providers struct {
	*memories
	all     []provider
	timeout time.Duration
}

func newProviders(local *memories, store *agent.Service) (*providers, error) {
	profiles := func() []string {
		var ids []string
		for _, a := range store.Agents() {
			ids = append(ids, a.ID)
		}
		return ids
	}
	return &providers{memories: local, all: []provider{localProvider{local, profiles}}, timeout: prefetchTimeout}, nil
}

// A provider that cannot start is left out with a line in the log; the farm and the other providers go on.
func (p *providers) OnStart(ctx context.Context) error {
	kept := p.all[:0]
	for _, one := range p.all {
		if ok, why := one.Available(); !ok {
			log.Printf("vibevalley: memory from %s is off: %s", one.Name(), why)
			continue
		}
		if err := one.OnStart(ctx); err != nil {
			if one.Name() == localName {
				return err
			}
			log.Printf("vibevalley: memory from %s did not start: %v", one.Name(), err)
			continue
		}
		kept = append(kept, one)
	}
	p.all = kept
	return nil
}

func (p *providers) OnStop() {
	for _, one := range p.all {
		one.OnStop()
	}
}

// The local provider's ids go as they are; another's carry its name: name:id.
func idOf(one provider, id string) string {
	if one.Name() == localName || id == "" {
		return id
	}
	return one.Name() + ":" + id
}

// Which provider an id is from, and the id as that provider knows it.
func (p *providers) owner(id string) (provider, string) {
	if name, rest, ok := strings.Cut(id, ":"); ok {
		for _, one := range p.all {
			if one.Name() == name {
				return one, rest
			}
		}
	}
	return p.all[0], id
}

// The cue as one provider gets it: only its own ids to skip, as it knows them (the local one's carry no name).
func cueFor(one provider, cue RecallCue) RecallCue {
	if len(cue.Skip) == 0 {
		return cue
	}
	skip := map[string]bool{}
	for id := range cue.Skip {
		name, rest, prefixed := strings.Cut(id, ":")
		switch {
		case !prefixed && one.Name() == localName:
			skip[id] = true
		case prefixed && name == one.Name():
			skip[rest] = true
		}
	}
	cue.Skip = skip
	return cue
}

// Asks every provider at once; the local one is waited for, any other only up to the timeout. A provider that fails or is
// too slow gives nothing, with a line in the log.
func askAll[T any](p *providers, what string, ask func(ctx context.Context, one provider) ([]T, error)) [][]T {
	found := make([][]T, len(p.all))
	var wg sync.WaitGroup
	for i, one := range p.all {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx := context.Background()
			if one.Name() != localName {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, p.timeout)
				defer cancel()
			}
			got, err := ask(ctx, one)
			if err != nil {
				if errors.Is(err, context.DeadlineExceeded) {
					log.Printf("vibevalley: memory from %s took longer than %s; %s goes on without it", one.Name(), p.timeout, what)
				} else {
					log.Printf("vibevalley: memory from %s for %s: %v", one.Name(), what, err)
				}
				return
			}
			found[i] = got
		}()
	}
	wg.Wait()
	return found
}

func (p *providers) prefetchAll(cue RecallCue) [][]recalledLine {
	return askAll(p, cue.Agent, func(ctx context.Context, one provider) ([]recalledLine, error) {
		lines, err := one.Prefetch(ctx, cueFor(one, cue))
		for j := range lines {
			lines[j].ID = idOf(one, lines[j].ID)
		}
		return lines, err
	})
}

// Behind memory_search: every provider's best, taken in turns (their scores do not compare), the same memory once.
func (p *providers) Search(q SearchQuery) []Found {
	limit := q.Limit
	if limit <= 0 {
		limit = searchLimit
	}
	q.Limit = limit
	groups := askAll(p, "a search", func(ctx context.Context, one provider) ([]Found, error) {
		found, err := one.Search(ctx, q)
		for j := range found {
			found[j].ID = idOf(one, found[j].ID)
			found[j].Source = one.Name()
		}
		return found, err
	})
	out := []Found{}
	var seen []map[string]bool
	for rank := 0; len(out) < limit; rank++ {
		more := false
		for _, g := range groups {
			if rank >= len(g) || len(out) == limit {
				continue
			}
			more = true
			terms := termsOf(g[rank].Text)
			if slices.ContainsFunc(seen, func(t map[string]bool) bool { return memoryLikeness(t, terms) >= 0.8 }) ||
				slices.ContainsFunc(out, func(f Found) bool { return f.Text == g[rank].Text }) {
				continue
			}
			seen = append(seen, terms)
			out = append(out, g[rank])
		}
		if !more {
			break
		}
	}
	return out
}

// One provider's lines go as it gave them (it has bounded them already); several are merged best first, the same line once,
// within the recall's count and characters.
func mergeRecalled(groups [][]recalledLine) []recalledLine {
	var some [][]recalledLine
	for _, g := range groups {
		if len(g) > 0 {
			some = append(some, g)
		}
	}
	if len(some) <= 1 {
		if len(some) == 0 {
			return nil
		}
		return some[0]
	}
	var all []recalledLine
	for _, g := range some {
		all = append(all, g...)
	}
	slices.SortStableFunc(all, func(a, b recalledLine) int { return cmp.Compare(b.Score, a.Score) })
	var out []recalledLine
	seen := map[string]bool{}
	chars := 0
	for _, l := range all {
		length := str.Units(l.Line) + 1
		if len(out) == recallCount || seen[l.Line] || chars+length > recallChars {
			continue
		}
		seen[l.Line] = true
		out = append(out, l)
		chars += length
	}
	return out
}

func (p *providers) Recall(cue RecallCue) Recalled {
	var out Recalled
	for _, l := range mergeRecalled(p.prefetchAll(cue)) {
		if l.ID != "" {
			out.IDs = append(out.IDs, l.ID)
		}
		out.Lines = append(out.Lines, l.Line)
	}
	return out
}

// What a session of the agent would recall starting a run in project, told text; nothing is counted as recalled.
func (p *providers) Preview(agentID, project, text string) protocol.RecallPreview {
	out := protocol.RecallPreview{Lines: []string{}, Limit: recallChars}
	for _, l := range mergeRecalled(p.prefetchAll(RecallCue{Agent: agentID, Project: project, Text: text, Peek: true})) {
		out.Lines = append(out.Lines, l.Line)
		out.Chars += int64(str.Units(l.Line) + 1)
	}
	return out
}

// Every provider gets the run, in order; one failing leaves the others theirs.
func (p *providers) Keep(run FinishedRun) {
	for _, one := range p.all {
		if err := one.SyncTurn(context.Background(), run); err != nil {
			log.Printf("vibevalley: %s did not keep what %s learned: %v", one.Name(), run.Session, err)
		}
	}
}

func (p *providers) List(agentID string) []protocol.Memory {
	out := []protocol.Memory{}
	for _, one := range p.all {
		listed, err := one.List(context.Background(), agentID)
		if err != nil {
			log.Printf("vibevalley: memories of %s from %s: %v", agentID, one.Name(), err)
			continue
		}
		for _, m := range listed {
			m.ID = idOf(one, m.ID)
			out = append(out, m)
		}
	}
	return out
}

// The local provider's answer is the one returned; the others get the note too and only log a failure.
func (p *providers) Write(agentID, text, project string) (protocol.Memory, error) {
	n := Note{Agent: agentID, Text: text, Project: project}
	kept, err := p.all[0].Add(context.Background(), n)
	if err != nil {
		return protocol.Memory{}, err
	}
	for _, one := range p.all[1:] {
		if _, err := one.Add(context.Background(), n); err != nil {
			log.Printf("vibevalley: a note for %s did not reach %s: %v", agentID, one.Name(), err)
		}
	}
	return kept, nil
}

func (p *providers) Forget(agentID, id string) error {
	one, own := p.owner(id)
	return one.Forget(context.Background(), agentID, own)
}
