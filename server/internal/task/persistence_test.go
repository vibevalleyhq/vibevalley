package task

import (
	"context"
	"errors"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/session"
)

type failingTaskIssues struct {
	taskIssues
	err error
}

func (f failingTaskIssues) PutTask(protocol.TaskGraph) error { return f.err }

type observedTaskSessions struct {
	taskSessions
	told, dismissed, hired int
}

func (s *observedTaskSessions) Tell(string, string) string { s.told++; return "" }
func (s *observedTaskSessions) Dismiss(string) bool        { s.dismissed++; return true }
func (s *observedTaskSessions) Hire(context.Context, protocol.Agent, string, string, session.HireOptions) session.Hired {
	s.hired++
	return session.Hired{}
}

func TestFailedTaskCommitStopsActions(t *testing.T) {
	for _, action := range []string{"pause", "resume", "abandon", "retry", "skip", "edit", "sendBack"} {
		t.Run(action, func(t *testing.T) {
			tf := newTaskTestWorld(t, t.TempDir(), nil, nil)
			p := tf.Task.tasks
			graph := protocol.TaskGraph{ID: "p900", Title: "保存失败", Project: "test", State: protocol.GraphStateRunning, Parallel: 1,
				Tasks: []protocol.Task{{ID: "a", Title: "步骤", Brief: "做事", State: protocol.TaskStateFailed, Session: new("w900")}}}
			if action == "resume" {
				graph.State = protocol.GraphStatePaused
			}
			if err := tf.Issue.PutTask(graph); err != nil {
				t.Fatal(err)
			}
			tf.Core.Apply(protocol.FactHired{Session: protocol.Session{ID: "w900", Name: "帮工", Phase: protocol.Phase{Value: protocol.PhaseResting{}}}})
			failure := errors.New("injected write failure")
			p.mu.Lock()
			real := p.issues
			p.issues = failingTaskIssues{real, failure}
			observed := &observedTaskSessions{taskSessions: p.sessions}
			p.sessions = observed
			p.mu.Unlock()
			var err error
			switch action {
			case "pause":
				_, err = p.Act(graph.ID, protocol.GraphActionPause, protocol.GraphActorUser)
			case "resume":
				_, err = p.Act(graph.ID, protocol.GraphActionResume, protocol.GraphActorUser)
			case "abandon":
				_, err = p.Act(graph.ID, protocol.GraphActionAbandon, protocol.GraphActorUser)
			case "retry":
				_, err = p.TaskAct(graph.ID, "a", protocol.TaskActionRetry, protocol.GraphActorUser)
			case "skip":
				_, err = p.TaskAct(graph.ID, "a", protocol.TaskActionSkip, protocol.GraphActorUser)
			case "edit":
				_, err = p.edited(graph.ID, func(graph protocol.TaskGraph) editResult {
					graph.Title = "changed"
					return editResult{OK: true, TaskGraph: graph}
				}, protocol.GraphActorUser)
			case "sendBack":
				err = p.sendBack(graph, graph.Tasks[0], "w900", "retry", "failed check")
			}
			if !errors.Is(err, failure) {
				t.Fatalf("error = %v", err)
			}
			if observed.told != 0 || observed.dismissed != 0 || observed.hired != 0 {
				t.Fatalf("side effects after failed save: %+v", observed)
			}
			after := p.get(graph.ID)
			if after.State != graph.State || after.Title != graph.Title || after.Tasks[0].State != graph.Tasks[0].State {
				t.Fatalf("state changed: %+v", after)
			}
			p.mu.Lock()
			p.issues = real
			p.mu.Unlock()
			if action == "pause" {
				if _, err := p.Act(graph.ID, protocol.GraphActionPause, protocol.GraphActorUser); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}
