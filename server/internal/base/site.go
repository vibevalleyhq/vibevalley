package base

// The farm's core state on the server (FarmState), and the stream of site events the pages read (ported from the TypeScript
// server's site.ts, removed). The state changes in one place only: Apply folds a fact in with protocol.Reduce, then sends it. A page
// that connects later starts from a snapshot. The state is kept in $VIBEVALLEY_HOME/farm.json; the chat's messages and
// the schedules live in the database, which fill the state's copy of them at start. Beside the state go a helper's
// steps, notices and runtime changes: sent, not kept.

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"time"

	"vibevalley/internal/protocol"
)

const (
	// saveAfter: writes to farm.json wait this long, so a burst of facts is one write.
	saveAfter = 500 * time.Millisecond
	// stateEvery: the folded state goes out at most this often.
	stateEvery = 200 * time.Millisecond
	// wantBedFor: how long a bed the person planted on waits for the helper the manager hires for it.
	wantBedFor = 10 * time.Second
)

type Site struct {
	mu      sync.Mutex
	state   protocol.FarmState
	legacy  []protocol.Playbook
	events  *Hub[protocol.SiteEvent]
	effects *Hub[protocol.GameEffect]
	wanted  *struct {
		bed   int64
		until int64
	}
	disk    *FileWriter
	pending *time.Timer
	closed  bool
}

func NowMs() int64 { return time.Now().UnixMilli() }

// restored is what a restarted server starts from: what was kept, with no call on, and every helper on a bed.
func restored(kept protocol.FarmState) protocol.FarmState {
	kept.CallReason, kept.Chat, kept.Progress, kept.Schedules, kept.Issues = nil, nil, nil, nil, nil
	kept.Call, kept.Foreman = protocol.CallStateIdle, protocol.ForemanStateIdle
	return protocol.WithStations(kept)
}

// toKeep is what farm.json keeps: the state without the chat, the progress, the schedules and the issues, whose home is
// the database.
func toKeep(state protocol.FarmState) protocol.FarmState {
	state.Chat, state.Progress, state.Schedules, state.Issues = nil, nil, nil, nil
	return state
}

// siteLegacyPlaybooks is the playbooks farm.json had before they were issues (tickets/issues.go adoptPlaybooks takes
// them); the first time, farm.json as it was is copied beside it.
func siteLegacyPlaybooks(file string, body []byte) []protocol.Playbook {
	var old struct {
		Playbooks []protocol.Playbook `json:"playbooks"`
	}
	if json.Unmarshal(body, &old) != nil || len(old.Playbooks) == 0 {
		return nil
	}
	copied := file + ".playbooks"
	if _, err := os.Stat(copied); err != nil {
		if err := os.WriteFile(copied, body, 0o644); err != nil {
			log.Printf("vibevalley: farm.json not copied before its playbooks became issues: %v", err)
		}
	}
	return old.Playbooks
}

// LegacyPlaybooks is the playbooks farm.json had before they were issues.
func (s *Site) LegacyPlaybooks() []protocol.Playbook { return s.legacy }

func NewSite(home string) *Site {
	file := filepath.Join(home, "farm.json")
	kept := protocol.EmptyFarm()
	var legacy []protocol.Playbook
	if body, err := os.ReadFile(file); err == nil {
		var farm protocol.FarmState
		if err := json.Unmarshal(body, &farm); err == nil {
			kept = farm
			legacy = siteLegacyPlaybooks(file, body)
		} else {
			log.Printf("vibevalley: farm.json unreadable, starting empty: %v", err)
		}
	}
	if kept.Helpers == nil {
		kept.Helpers = []protocol.Helper{}
	}
	return &Site{
		legacy:  legacy,
		state:   restored(kept),
		events:  NewHub[protocol.SiteEvent](),
		effects: NewHub[protocol.GameEffect](),
		disk:    NewFileWriter(file, 0o644),
	}
}

func (s *Site) body() ([]byte, error) {
	s.mu.Lock()
	keep := toKeep(s.state)
	s.mu.Unlock()
	return json.Marshal(keep)
}

// save writes the state a little later; a crash loses half a second at most. Called with mu held.
func (s *Site) save() {
	if s.closed {
		return
	}
	if s.pending != nil {
		s.pending.Stop()
	}
	s.pending = time.AfterFunc(saveAfter, func() {
		if err := s.disk.Write(s.body); err != nil {
			log.Printf("vibevalley: could not save farm.json: %v", err)
		}
	})
}

// Close saves the state once more and stops saving.
func (s *Site) Close() {
	s.mu.Lock()
	s.closed = true
	if s.pending != nil {
		s.pending.Stop()
	}
	s.mu.Unlock()
	if err := s.disk.Write(s.body); err != nil {
		log.Printf("vibevalley: could not save farm.json: %v", err)
	}
}

// withAt is a fact with its time set: every fact has an At field.
func withAt(fact protocol.FactValue, at int64) protocol.FactValue {
	v := reflect.New(reflect.TypeOf(fact)).Elem()
	v.Set(reflect.ValueOf(fact))
	v.FieldByName("At").SetInt(at)
	return v.Interface().(protocol.FactValue)
}

// Apply folds a fact into the state (its At is now) and sends it to the pages. A fact that changes nothing is not news.
func (s *Site) Apply(fact protocol.FactValue) {
	s.mu.Lock()
	defer s.mu.Unlock()
	at := NowMs()
	if hired, ok := fact.(protocol.FactHired); ok {
		// A helper hired soon after the person planted on a bed takes that bed.
		if s.wanted != nil && s.wanted.until > at {
			bed := s.wanted.bed
			hired.Station = &bed
			fact = hired
		}
		s.wanted = nil
	}
	f := protocol.Fact{Value: withAt(fact, at)}
	next, changed := protocol.Reduce(s.state, f)
	if !changed {
		return
	}
	brought := protocol.EffectsOf(s.state, f)
	s.state = next
	s.save()
	s.events.Publish(protocol.SiteEvent{Value: f.Value.(protocol.SiteEventValue)})
	for _, e := range brought {
		s.effects.Publish(e)
	}
}

// Events is a snapshot of now, then every fact and everything beside the state; stop ends it.
func (s *Site) Events() (snapshot protocol.SiteEvent, events <-chan protocol.SiteEvent, stop func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	events, stop = s.events.Subscribe()
	return protocol.SiteEvent{Value: protocol.SiteEventSnapshot{At: NowMs(), State: s.state}}, events, stop
}

func (s *Site) frame(effects []protocol.GameEffect) protocol.SiteFrame {
	s.mu.Lock()
	state := s.state
	s.mu.Unlock()
	if effects == nil {
		effects = []protocol.GameEffect{}
	}
	return protocol.SiteFrame{
		State: state, Inbox: protocol.Inbox(state), Plans: protocol.PlaybooksOf(state), View: protocol.ViewOf(state), Effects: effects,
	}
}

// States is the state now, then again after it changes, at most once per 200 ms, each with its view and the effects
// since the last frame: for clients that do not fold facts. It ends when done closes.
func (s *Site) States(done <-chan struct{}) <-chan protocol.SiteFrame {
	s.mu.Lock()
	facts, stopFacts := s.events.Subscribe()
	effects, stopEffects := s.effects.Subscribe()
	s.mu.Unlock()
	out := make(chan protocol.SiteFrame, 1)
	go func() {
		defer close(out)
		defer stopFacts()
		defer stopEffects()
		send := func(f protocol.SiteFrame) bool {
			select {
			case out <- f:
				return true
			case <-done:
				return false
			}
		}
		if !send(s.frame(nil)) {
			return
		}
		for {
			var gathered []protocol.GameEffect
			// Wait for the first change, then gather for a window.
			select {
			case <-done:
				return
			case e := <-facts:
				if !isFact(e) {
					continue
				}
			case e := <-effects:
				gathered = append(gathered, e)
			}
			window := time.After(stateEvery)
		gather:
			for {
				select {
				case <-done:
					return
				case <-facts:
				case e := <-effects:
					gathered = append(gathered, e)
				case <-window:
					break gather
				}
			}
			if !send(s.frame(gathered)) {
				return
			}
		}
	}()
	return out
}

func isFact(e protocol.SiteEvent) bool {
	_, ok := e.Value.(protocol.FactValue)
	return ok
}

// WantBed: the person planted on bed; the next helper hired in the next few seconds takes it, when free.
func (s *Site) WantBed(bed int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.wanted = &struct {
		bed   int64
		until int64
	}{bed, NowMs() + wantBedFor.Milliseconds()}
}

// State is the core state now.
func (s *Site) State() protocol.FarmState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

func (s *Site) Helper(id string) *protocol.Helper {
	s.mu.Lock()
	defer s.mu.Unlock()
	if h := protocol.HelperOf(s.state, id); h != nil {
		copy := *h
		return &copy
	}
	return nil
}

func (s *Site) Call() protocol.CallState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state.Call
}

func (s *Site) SetCall(state protocol.CallState, reason string) {
	f := protocol.FactCall{State: state}
	if reason != "" {
		f.Reason = &reason
	}
	s.Apply(f)
}

func (s *Site) SetForeman(state protocol.ForemanState) {
	if s.State().Foreman == state {
		return
	}
	s.Apply(protocol.FactForeman{State: state})
}

// SetCommits: the commit count (the farm's experience); a fact only when it changed.
func (s *Site) SetCommits(count protocol.CommitCount) {
	if was := s.State().Commits; was != nil && reflect.DeepEqual(*was, count) {
		return
	}
	s.Apply(protocol.FactCommits{Commits: count})
}

// Step: a step of a helper's work, new or grown, for pages showing its detail.
func (s *Site) Step(id string, step protocol.WorkStep) {
	s.events.Publish(protocol.SiteEvent{Value: protocol.SiteEventStep{At: NowMs(), ID: id, Step: step}})
}

func (s *Site) Notice(level protocol.NoticeLevel, text string) {
	s.events.Publish(protocol.SiteEvent{Value: protocol.SiteEventNotice{At: NowMs(), Level: level, Text: text}})
}

// Runtime: a runtime's info changed (its account usage, mostly).
func (s *Site) Runtime(info protocol.RuntimeInfo) {
	s.events.Publish(protocol.SiteEvent{Value: protocol.SiteEventRuntime{At: NowMs(), Info: info}})
}

const DayMs = 86_400_000
