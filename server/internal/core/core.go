package core

// The state changes in one place only: Apply folds a fact in with protocol.Reduce, then sends it. state.json keeps the state but the chat, progress,
// schedules and issues, whose home is the database.

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/clock"
)

const (
	// A burst of facts is one write.
	saveAfter  = 500 * time.Millisecond
	stateEvery = 200 * time.Millisecond
)

type Service struct {
	mu      sync.Mutex
	state   protocol.CoreState
	events  *base.Hub[protocol.SideEvent]
	facts   *base.Hub[protocol.Fact]
	live    *base.Hub[protocol.LiveEvent]
	effects *base.Hub[protocol.GameEffect]
	did     *base.Hub[OwnerDid]
	disk    *base.FileWriter
	pending *time.Timer
	closed  bool
}

// What state.json keeps: the chat, progress, schedules and issues are the database's.
func toKeep(state protocol.CoreState) protocol.CoreState {
	state.Chat, state.Progress, state.Schedules, state.Issues = nil, nil, nil, nil
	return state
}

// Started again, nobody is on the call and the manager is not mid-sentence.
func restored(kept protocol.CoreState) protocol.CoreState {
	kept = toKeep(kept)
	kept.Call, kept.CallReason, kept.Manager = protocol.CallStateIdle, nil, protocol.ManagerStateIdle
	return protocol.WithStations(kept)
}

func New(home string) *Service {
	file := filepath.Join(home, "state.json")
	kept := protocol.EmptyCoreState()
	if body, err := os.ReadFile(file); err == nil {
		var farm protocol.CoreState
		if err := json.Unmarshal(body, &farm); err == nil {
			kept = farm
		} else {
			log.Printf("vibevalley: state.json unreadable, starting empty: %v", err)
		}
	}
	if kept.Sessions == nil {
		kept.Sessions = []protocol.Session{}
	}
	return &Service{
		state:   restored(kept),
		events:  base.NewHub[protocol.SideEvent](),
		facts:   base.NewHub[protocol.Fact](),
		live:    base.NewHub[protocol.LiveEvent](),
		did:     base.NewHub[OwnerDid](),
		effects: base.NewHub[protocol.GameEffect](),
		disk:    base.NewFileWriter(file, 0o644),
	}
}

func (s *Service) body() ([]byte, error) {
	s.mu.Lock()
	keep := toKeep(s.state)
	s.mu.Unlock()
	return json.Marshal(keep)
}

// A crash loses half a second at most. Called with mu held.
func (s *Service) save() {
	if s.closed {
		return
	}
	if s.pending != nil {
		return
	}
	s.pending = time.AfterFunc(saveAfter, func() {
		s.mu.Lock()
		s.pending = nil
		s.mu.Unlock()
		if err := s.disk.Write(s.body); err != nil {
			log.Printf("vibevalley: could not save state.json: %v", err)
		}
	})
}

func (s *Service) Close() {
	s.mu.Lock()
	s.closed = true
	if s.pending != nil {
		s.pending.Stop()
	}
	s.mu.Unlock()
	if err := s.disk.Write(s.body); err != nil {
		log.Printf("vibevalley: could not save state.json: %v", err)
	}
}

func withAt(fact protocol.FactValue, at int64) protocol.FactValue {
	v := reflect.New(reflect.TypeOf(fact)).Elem()
	v.Set(reflect.ValueOf(fact))
	v.FieldByName("At").SetInt(at)
	return v.Interface().(protocol.FactValue)
}

// A fact that changes nothing is not news.
func (s *Service) Apply(fact protocol.FactValue) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f := protocol.Fact{Value: withAt(fact, clock.NowMs())}
	next, changed := protocol.Reduce(s.state, f)
	if !changed {
		return
	}
	brought := protocol.EffectsOf(s.state, f)
	s.state = next
	s.save()
	s.publish(protocol.SideEvent{Value: f.Value.(protocol.SideEventValue)})
	for _, e := range brought {
		s.effects.Publish(e)
	}
}

func (s *Service) Events() (snapshot protocol.SideEvent, events <-chan protocol.SideEvent, stop func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	events, stop = s.events.Subscribe()
	return protocol.SideEvent{Value: protocol.SideEventSnapshot{At: clock.NowMs(), State: s.state}}, events, stop
}

func (s *Service) frame(effects []protocol.GameEffect) protocol.StateFrame {
	s.mu.Lock()
	state := s.state
	s.mu.Unlock()
	return protocol.FrameOf(state, effects)
}

// For clients that do not fold facts. It ends when done closes.
func (s *Service) States(done <-chan struct{}) <-chan protocol.StateFrame {
	s.mu.Lock()
	facts, stopFacts := s.events.Subscribe()
	effects, stopEffects := s.effects.Subscribe()
	s.mu.Unlock()
	out := make(chan protocol.StateFrame, 1)
	go func() {
		defer close(out)
		defer stopFacts()
		defer stopEffects()
		send := func(f protocol.StateFrame) bool {
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

func isFact(e protocol.SideEvent) bool {
	_, ok := e.Value.(protocol.FactValue)
	return ok
}

func (s *Service) State() protocol.CoreState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

func (s *Service) Session(id string) *protocol.Session {
	s.mu.Lock()
	defer s.mu.Unlock()
	if h := protocol.SessionOf(s.state, id); h != nil {
		copy := *h
		return &copy
	}
	return nil
}

func (s *Service) Call() protocol.CallState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state.Call
}

// What the owner did that changes no state (so it is no fact), said by the service it went through: the game counts some.
type OwnerDid struct {
	Kind OwnerDidKind
	// Reviewed: whose changes.
	Session string
}

type OwnerDidKind string

const (
	OwnerReviewed OwnerDidKind = "reviewed" // looked at a session's changes (issue.Review)
	OwnerTalked   OwnerDidKind = "talked"   // a voice agent came on the call (voice.Start)
)

func (s *Service) Did(d OwnerDid) { s.did.Publish(d) }

func (s *Service) OwnerDids() *base.Hub[OwnerDid] { return s.did }

// The farm opens when the owner starts it or says something: the call goes live unless it is already.
func (s *Service) Open() {
	if s.Call() != protocol.CallStateLive {
		s.SetCall(protocol.CallStateLive, "")
	}
}

func (s *Service) SetCall(state protocol.CallState, reason string) {
	f := protocol.FactCall{State: state}
	if reason != "" {
		f.Reason = &reason
	}
	s.Apply(f)
}

func (s *Service) SetManager(state protocol.ManagerState) {
	s.Apply(protocol.FactManager{State: state})
}

func (s *Service) SetCommits(count protocol.CommitCount) {
	s.Apply(protocol.FactCommits{Commits: count})
}

func (s *Service) SessionEvent(id string, step protocol.SessionEvent) {
	s.publish(protocol.SideEvent{Value: protocol.SideEventSessionEvent{At: clock.NowMs(), ID: id, SessionEvent: step}})
}

func (s *Service) Notice(level protocol.NoticeLevel, text string) {
	s.publish(protocol.SideEvent{Value: protocol.SideEventNotice{At: clock.NowMs(), Level: level, Text: text}})
}

func (s *Service) Runtime(info protocol.RuntimeInfo) {
	s.publish(protocol.SideEvent{Value: protocol.SideEventRuntime{At: clock.NowMs(), Info: info}})
}

// Facts and Live subscribe to changes only; the full snapshot protocol stays in Events.
func (s *Service) Facts() (<-chan protocol.Fact, func())     { return s.facts.Subscribe() }
func (s *Service) Live() (<-chan protocol.LiveEvent, func()) { return s.live.Subscribe() }

func (s *Service) publish(event protocol.SideEvent) {
	s.events.Publish(event)
	if fact, ok := event.Value.(protocol.FactValue); ok {
		s.facts.Publish(protocol.Fact{Value: fact})
	}
	if live, ok := protocol.LiveEventOf(event); ok {
		s.live.Publish(live)
	}
}
