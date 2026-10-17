package memory

import (
	"context"
	"errors"
	"log"
	"slices"
	"strings"
	"sync"
	"time"

	"vibevalley/internal/agent"
	"vibevalley/internal/protocol"
	"vibevalley/internal/setting"
	"vibevalley/pkg/x/ptr"
	"vibevalley/pkg/x/str"
)

const (
	// How long a provider outside the farm may take to answer a read; past it the run starts (the search answers) without it.
	// Hermes gives external providers 8 s; a run waiting on it is the owner waiting, so less.
	prefetchTimeout = 2 * time.Second
	// A write goes in the background, so it may take longer; one that hangs still must not hold the queue for ever.
	writeTimeout = 30 * time.Second
	writeQueue   = 256
)

// Every provider, the local one first: what the rest of the farm calls (Hermes's MemoryManager). The local one is embedded
// too, so what only it has (keep, for the tests) still reaches the Service.
type providers struct {
	*memories
	local    provider
	settings *setting.Service
	timeout  time.Duration
	// A source from its settings; tests put their own.
	build func(setting.MemorySourceConfig) provider

	mu sync.Mutex
	// The local one first, then the sources that are on.
	all []provider
	// Sources set up but not on, and why.
	off   []protocol.MemorySourceInfo
	built []setting.MemorySourceConfig
	// Sources follow the settings only once started: before that (tests) all stays as it was set.
	started bool
	stopped bool

	writes chan func()
	worker sync.WaitGroup
	once   sync.Once
}

func newProviders(local *memories, store *agent.Service, settings *setting.Service) (*providers, error) {
	profiles := func() []string {
		var ids []string
		for _, a := range store.Agents() {
			ids = append(ids, a.ID)
		}
		return ids
	}
	own := &localProvider{m: local, profiles: profiles}
	return &providers{memories: local, local: own, settings: settings, all: []provider{own}, timeout: prefetchTimeout, build: newSource}, nil
}

func newSource(c setting.MemorySourceConfig) provider {
	switch c.Kind {
	case protocol.MemorySourceKindNowledge:
		return newNowledge(c)
	case protocol.MemorySourceKindEveros:
		return newEveros(c)
	}
	return nil
}

var sourceLabels = map[string]string{localName: "本地", string(protocol.MemorySourceKindNowledge): "Nowledge Mem", string(protocol.MemorySourceKindEveros): "EverOS"}

func (p *providers) OnStart(ctx context.Context) error {
	if err := p.local.OnStart(ctx); err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.started = true
	p.follow(ctx)
	return nil
}

// Called with p.mu held. The sources are built again whenever their settings change: a source saved on the settings page is
// used from the next read or write, without a restart. A source that cannot start is left out with a line in the log.
func (p *providers) follow(ctx context.Context) {
	if !p.started || p.stopped || p.settings == nil {
		return
	}
	configured := p.settings.MemorySources()
	if p.built != nil && slices.Equal(configured, p.built) {
		return
	}
	for _, one := range p.all {
		if one.Name() != localName {
			go one.OnStop()
		}
	}
	p.all, p.off, p.built = []provider{p.local}, nil, append([]setting.MemorySourceConfig{}, configured...)
	for _, c := range configured {
		name := string(c.Kind)
		off := func(why string) {
			p.off = append(p.off, protocol.MemorySourceInfo{Name: name, Label: sourceLabels[name], Off: &why})
		}
		if !c.Enabled {
			off("没打开")
			continue
		}
		one := p.build(c)
		if one == nil {
			off("不认识这种来源")
			continue
		}
		if ok, why := one.Available(); !ok {
			log.Printf("vibevalley: memory from %s is off: %s", name, why)
			off(why)
			continue
		}
		if err := one.OnStart(ctx); err != nil {
			log.Printf("vibevalley: memory from %s did not start: %v", name, err)
			off("没接上：" + err.Error())
			continue
		}
		p.all = append(p.all, one)
	}
}

func (p *providers) current() []provider {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.follow(context.Background())
	return slices.Clone(p.all)
}

// Waits for the writes already queued; none are taken after.
func (p *providers) OnStop() {
	p.mu.Lock()
	p.stopped = true
	all := p.all
	if p.writes != nil {
		close(p.writes)
	}
	p.mu.Unlock()
	p.worker.Wait()
	for _, one := range all {
		one.OnStop()
	}
}

// Writes to sources outside the farm go one at a time in the background: keeping a run or a note never waits on them, and
// they land in the order they were made.
func (p *providers) queue(what string, write func(ctx context.Context) error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stopped {
		return
	}
	p.once.Do(func() {
		p.writes = make(chan func(), writeQueue)
		p.worker.Add(1)
		go func() {
			defer p.worker.Done()
			for w := range p.writes {
				w()
			}
		}()
	})
	select {
	case p.writes <- func() {
		ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
		defer cancel()
		if err := write(ctx); err != nil {
			log.Printf("vibevalley: %s: %v", what, err)
		}
	}:
	default:
		log.Printf("vibevalley: %s: too many writes waiting, dropped", what)
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
func owner(all []provider, id string) (provider, string) {
	if name, rest, ok := strings.Cut(id, ":"); ok {
		for _, one := range all {
			if one.Name() == name {
				return one, rest
			}
		}
	}
	return all[0], id
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
func askAll[T any](p *providers, all []provider, what string, ask func(ctx context.Context, one provider) ([]T, error)) [][]T {
	found := make([][]T, len(all))
	var wg sync.WaitGroup
	for i, one := range all {
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
	return askAll(p, p.current(), cue.Agent, func(ctx context.Context, one provider) ([]recalledLine, error) {
		lines, err := one.Prefetch(ctx, cueFor(one, cue))
		for j := range lines {
			lines[j].ID = idOf(one, lines[j].ID)
		}
		return lines, err
	})
}

// Turns over the groups best first, one from each in turn (their scores do not compare), leaving out what is nearly the
// same as one already taken; keep says whether one more fits.
func interleave[T any](groups [][]T, text func(T) string, keep func(T) bool) []T {
	var out []T
	var seen []map[string]bool
	var texts []string
	for rank := 0; ; rank++ {
		more := false
		for _, g := range groups {
			if rank >= len(g) {
				continue
			}
			more = true
			one := g[rank]
			terms := termsOf(text(one))
			if slices.Contains(texts, text(one)) || slices.ContainsFunc(seen, func(t map[string]bool) bool { return memoryLikeness(t, terms) >= 0.8 }) {
				continue
			}
			if !keep(one) {
				continue
			}
			seen, texts = append(seen, terms), append(texts, text(one))
			out = append(out, one)
		}
		if !more {
			return out
		}
	}
}

// One provider's lines go as it gave them (it has bounded them already); several are taken in turns, the same line once,
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
	count, chars := 0, 0
	return interleave(some, func(l recalledLine) string { return l.Line }, func(l recalledLine) bool {
		length := str.Units(l.Line) + 1
		if count == recallCount || chars+length > recallChars {
			return false
		}
		count, chars = count+1, chars+length
		return true
	})
}

// Only what is told is counted as recalled: a local memory merged out is not.
func (p *providers) Recall(cue RecallCue) Recalled {
	var out Recalled
	var local []string
	for _, l := range mergeRecalled(p.prefetchAll(cue)) {
		if l.ID != "" {
			out.IDs = append(out.IDs, l.ID)
			if !strings.Contains(l.ID, ":") {
				local = append(local, l.ID)
			}
		}
		out.Lines = append(out.Lines, l.Line)
	}
	p.markRecalled(local)
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

// Behind memory_search: every provider's best, taken in turns, the same memory once.
func (p *providers) Search(q SearchQuery) []Found {
	if q.Limit <= 0 {
		q.Limit = searchLimit
	}
	groups := askAll(p, p.current(), "a search", func(ctx context.Context, one provider) ([]Found, error) {
		found, err := one.Search(ctx, q)
		for j := range found {
			found[j].ID = idOf(one, found[j].ID)
			found[j].Source = one.Name()
		}
		return found, err
	})
	out := interleave(groups, func(f Found) string { return f.Text }, func(Found) bool { return true })
	if out == nil {
		return []Found{}
	}
	return out[:min(len(out), q.Limit)]
}

// The local provider keeps the run before this returns; the others get it in the background, and one failing leaves the
// others theirs.
func (p *providers) Keep(run FinishedRun) {
	all := p.current()
	if err := all[0].SyncTurn(context.Background(), run); err != nil {
		log.Printf("vibevalley: %s did not keep what %s learned: %v", all[0].Name(), run.Session, err)
	}
	for _, one := range all[1:] {
		p.queue(one.Name()+" did not keep what "+run.Session+" learned", func(ctx context.Context) error { return one.SyncTurn(ctx, run) })
	}
}

func (p *providers) EndSession(s EndedSession) {
	for _, one := range p.current()[1:] {
		p.queue(one.Name()+" did not take the end of "+s.Session, func(ctx context.Context) error { return one.OnSessionEnd(ctx, s) })
	}
}

// What the 记性 tab lists: the local memories, then those of each source that can list them, each with where it is from.
func (p *providers) List(agentID string) []protocol.Memory {
	var listing []provider
	for _, one := range p.current() {
		if one.Can().List {
			listing = append(listing, one)
		}
	}
	out := []protocol.Memory{}
	for i, listed := range askAll(p, listing, "the memories of "+agentID, func(ctx context.Context, one provider) ([]protocol.Memory, error) {
		return one.List(ctx, agentID)
	}) {
		one := listing[i]
		for _, m := range listed {
			m.ID = idOf(one, m.ID)
			if one.Name() != localName {
				m.Source = ptr.To(one.Name())
			}
			out = append(out, m)
		}
	}
	return out
}

func (p *providers) Sources() []protocol.MemorySourceInfo {
	all := p.current()
	out := []protocol.MemorySourceInfo{}
	for _, one := range all {
		can := one.Can()
		out = append(out, protocol.MemorySourceInfo{Name: one.Name(), Label: sourceLabels[one.Name()], On: true, CanList: can.List, CanForget: can.Forget, Transcripts: can.Transcripts})
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return append(out, p.off...)
}

// The local provider's answer is the one returned; the others get the note in the background and only log a failure.
func (p *providers) Write(agentID, text, project string) (protocol.Memory, error) {
	n := Note{Agent: agentID, Text: text, Project: project}
	all := p.current()
	kept, err := all[0].Add(context.Background(), n)
	if err != nil {
		return protocol.Memory{}, err
	}
	for _, one := range all[1:] {
		p.queue("a note for "+agentID+" did not reach "+one.Name(), func(ctx context.Context) error {
			_, err := one.Add(ctx, n)
			return err
		})
	}
	return kept, nil
}

func (p *providers) Forget(agentID, id string) error {
	one, own := owner(p.current(), id)
	if !one.Can().Forget {
		return protocol.Refused{Reason: sourceLabels[one.Name()] + " 里的记忆到它自己那里删"}
	}
	return one.Forget(context.Background(), agentID, own)
}
