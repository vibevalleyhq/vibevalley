package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/pkg/x/ptr"
)

func TestStartedAgainFromStateJSON(t *testing.T) {
	home := t.TempDir()
	was := protocol.EmptyCoreState()
	was.Call, was.CallReason, was.Manager = protocol.CallStateLive, ptr.To("挂了"), protocol.ManagerStateSpeaking
	was.Sessions = []protocol.Session{{ID: "w1", Name: "帮工", Agent: "lab", Runtime: "pi", Task: "写", Phase: protocol.Phase{Value: protocol.PhaseRipe{}}}}
	was.Progress = ptr.To(protocol.EmptyProgress())
	was.Schedules = []protocol.Schedule{{ID: "x1", Name: "日报"}}
	was.Issues = []protocol.Issue{{ID: "i1"}}
	body, _ := json.Marshal(was)
	if err := os.WriteFile(filepath.Join(home, "state.json"), body, 0o644); err != nil {
		t.Fatal(err)
	}
	s := New(home)
	got := s.State()
	testkit.Eq(t, [3]any{got.Call, got.CallReason, got.Manager}, [3]any{protocol.CallStateIdle, (*string)(nil), protocol.ManagerStateIdle}, "idle again")
	testkit.Eq(t, [3]bool{got.Progress == nil, got.Schedules == nil, got.Issues == nil}, [3]bool{true, true, true}, "the database's parts come from the database")
	testkit.Eq(t, len(got.Sessions), 1, "the sessions stay")
	testkit.Eq(t, got.Sessions[0].Play != nil, true, "at their stations")
}

func TestApplyStampsAndKeepsNoNewsBack(t *testing.T) {
	home := t.TempDir()
	s := New(home)
	_, events, stop := s.Events()
	defer stop()
	s.Apply(protocol.FactHired{Session: protocol.Session{ID: "w1", Name: "帮工", Agent: "lab", Runtime: "pi", Task: "写", Phase: protocol.Phase{Value: protocol.PhaseArriving{}}}})
	<-events
	s.SetManager(protocol.ManagerStateThinking)
	select {
	case e := <-events:
		f, ok := e.Value.(protocol.FactManager)
		testkit.Eq(t, ok && f.State == protocol.ManagerStateThinking && f.At > 0, true, "sent with its time", e)
	case <-time.After(time.Second):
		t.Fatal("no news")
	}
	s.SetManager(protocol.ManagerStateThinking)
	s.Apply(protocol.FactProgress{Progress: protocol.EmptyProgress()})
	<-events
	testkit.Settle()
	select {
	case e := <-events:
		t.Fatalf("the same again was sent: %+v", e)
	default:
	}

	s.Close()
	var kept map[string]any
	body, _ := os.ReadFile(filepath.Join(home, "state.json"))
	if err := json.Unmarshal(body, &kept); err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, kept["manager"], "thinking", "written on close")
	testkit.Eq(t, kept["progress"], nil, "progress is the ledger's")
	if strings.Contains(string(body), "phaseText") || strings.Contains(string(body), "whenText") {
		t.Fatal("the words are the frame's, never kept")
	}
}

func TestStatesGatherABurstIntoOneFrame(t *testing.T) {
	s := New(t.TempDir())
	done := make(chan struct{})
	defer close(done)
	frames := s.States(done)
	first := <-frames
	testkit.Eq(t, first.State.Manager, protocol.ManagerStateIdle, "the state as it is, at once")
	s.SetManager(protocol.ManagerStateSpeaking)
	s.SetCommits(protocol.CommitCount{Total: 2})
	next := <-frames
	testkit.Eq(t, [2]any{next.State.Manager, next.State.Commits.Total}, [2]any{protocol.ManagerStateSpeaking, int64(2)}, "both in one frame")
	select {
	case f := <-frames:
		t.Fatalf("a second frame for the same burst: %+v", f.State)
	case <-time.After(2 * stateEvery):
	}
}

func TestContinuousFactsStillReachDisk(t *testing.T) {
	home := t.TempDir()
	s := New(home)
	defer s.Close()
	tick := time.NewTicker(25 * time.Millisecond)
	defer tick.Stop()
	deadline := time.After(3 * saveAfter)
	var n int64
	for {
		select {
		case <-tick.C:
			n++
			s.SetCommits(protocol.CommitCount{Total: n})
			body, err := os.ReadFile(filepath.Join(home, "state.json"))
			if err == nil {
				var kept protocol.CoreState
				if err := json.Unmarshal(body, &kept); err != nil {
					t.Fatal(err)
				}
				if kept.Commits.Total > 0 {
					return
				}
			}
		case <-deadline:
			t.Fatal("continuous activity postponed persistence indefinitely")
		}
	}
}
