package playbook

import (
	"context"
	"errors"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/session"
)

type failingPlanIssues struct {
	planIssues
	err error
}

func (f failingPlanIssues) PutPlaybook(protocol.Playbook) error { return f.err }

type observedPlanSessions struct {
	planSessions
	told, dismissed, hired int
}

func (s *observedPlanSessions) Tell(string, string) string { s.told++; return "" }
func (s *observedPlanSessions) Dismiss(string) bool        { s.dismissed++; return true }
func (s *observedPlanSessions) Hire(context.Context, protocol.Agent, string, string, session.HireOptions) session.Hired {
	s.hired++
	return session.Hired{}
}

func TestFailedPlanCommitStopsActions(t *testing.T) {
	for _, action := range []string{"pause", "resume", "abandon", "retry", "skip", "edit", "sendBack"} {
		t.Run(action, func(t *testing.T) {
			tf := newPlanTestFarm(t, t.TempDir(), nil, nil)
			p := tf.Playbook.playbooks
			pb := protocol.Playbook{ID: "p900", Title: "保存失败", Project: "test", State: protocol.PlaybookStateRunning, Parallel: 1,
				Nodes: []protocol.PlaybookNode{{ID: "a", Title: "步骤", Task: "做事", State: protocol.NodeStateFailed, Session: new("w900")}}}
			if action == "resume" {
				pb.State = protocol.PlaybookStatePaused
			}
			if err := tf.Issue.PutPlaybook(pb); err != nil {
				t.Fatal(err)
			}
			tf.Core.Apply(protocol.FactHired{Session: protocol.Session{ID: "w900", Name: "帮工", Phase: protocol.Phase{Value: protocol.PhaseResting{}}}})
			failure := errors.New("injected write failure")
			p.mu.Lock()
			real := p.issues
			p.issues = failingPlanIssues{real, failure}
			observed := &observedPlanSessions{planSessions: p.sessions}
			p.sessions = observed
			p.mu.Unlock()
			var err error
			switch action {
			case "pause":
				_, err = p.Act(pb.ID, protocol.PlaybookActionPause, protocol.PlaybookActorUser)
			case "resume":
				_, err = p.Act(pb.ID, protocol.PlaybookActionResume, protocol.PlaybookActorUser)
			case "abandon":
				_, err = p.Act(pb.ID, protocol.PlaybookActionAbandon, protocol.PlaybookActorUser)
			case "retry":
				_, err = p.NodeAct(pb.ID, "a", protocol.NodeActionRetry, protocol.PlaybookActorUser)
			case "skip":
				_, err = p.NodeAct(pb.ID, "a", protocol.NodeActionSkip, protocol.PlaybookActorUser)
			case "edit":
				_, err = p.edited(pb.ID, func(pb protocol.Playbook) editResult { pb.Title = "changed"; return editResult{OK: true, Playbook: pb} }, protocol.PlaybookActorUser)
			case "sendBack":
				err = p.sendBack(pb, pb.Nodes[0], "w900", "retry", "failed check")
			}
			if !errors.Is(err, failure) {
				t.Fatalf("error = %v", err)
			}
			if observed.told != 0 || observed.dismissed != 0 || observed.hired != 0 {
				t.Fatalf("side effects after failed save: %+v", observed)
			}
			after := p.get(pb.ID)
			if after.State != pb.State || after.Title != pb.Title || after.Nodes[0].State != pb.Nodes[0].State {
				t.Fatalf("state changed: %+v", after)
			}
			p.mu.Lock()
			p.issues = real
			p.mu.Unlock()
			if action == "pause" {
				if _, err := p.Act(pb.ID, protocol.PlaybookActionPause, protocol.PlaybookActorUser); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}
