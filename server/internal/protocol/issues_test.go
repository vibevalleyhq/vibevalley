package protocol

import (
	"fmt"
	"testing"

	"vibevalley/internal/testkit"
)

func TestIssueStatus(t *testing.T) {
	farm := EmptyCoreState()
	farm.Sessions = []Session{
		{ID: "w1", Name: "w1", Agent: "lab", Runtime: "pi", Brief: "…", Phase: Phase{PhaseWorking{Doing: Doing{Action: SessionActionEditFile}}}},
		{ID: "w2", Name: "w2", Agent: "lab", Runtime: "pi", Brief: "…", Phase: Phase{PhaseRipe{}}},
	}
	queued, closed := int64(5), int64(9)
	closedAs := func(c IssueClose) Issue {
		return Issue{ID: "t6", Sessions: []string{"w0"}, ClosedAt: &closed, Closed: &c}
	}
	for _, c := range []struct {
		name  string
		issue Issue
		want  IssueStatus
	}{
		{"written down", Issue{ID: "t1", Sessions: []string{}}, IssueStatusBacklog},
		{"waiting for room", Issue{ID: "t2", Sessions: []string{}, QueuedAt: &queued}, IssueStatusTodo},
		{"its run at work", Issue{ID: "t3", Sessions: []string{"w1"}}, IssueStatusInProgress},
		{"its turn over", Issue{ID: "t4", Sessions: []string{"w2"}}, IssueStatusInReview},
		{"the last run counts", Issue{ID: "t5", Sessions: []string{"w0", "w1"}}, IssueStatusInProgress},
		{"merged", closedAs(IssueCloseMerged), IssueStatusDone},
		{"merged into its task", closedAs(IssueCloseMergedIntoGraph), IssueStatusDone},
		{"answered by the manager", closedAs(IssueCloseAnswered), IssueStatusDone},
		{"dismissed", closedAs(IssueCloseDismissed), IssueStatusCanceled},
		{"lost", closedAs(IssueCloseLost), IssueStatusCanceled},
		{"closed without saying how", Issue{ID: "t6", Sessions: []string{"w0"}, ClosedAt: &closed}, IssueStatusCanceled},
		{"its run gone", Issue{ID: "t7", Sessions: []string{"w0"}}, IssueStatusCanceled},
		{"a task merged", Issue{ID: "p1", Sessions: []string{}, Graph: &IssueGraph{State: GraphStateDone}}, IssueStatusDone},
		{"a task abandoned", Issue{ID: "p1", Sessions: []string{}, Graph: &IssueGraph{State: GraphStateAbandoned}}, IssueStatusCanceled},
		{"a step merged", Issue{ID: "p1.a", Sessions: []string{}, Task: &IssueTask{State: TaskStateMerged}}, IssueStatusDone},
		{"a step skipped", Issue{ID: "p1.a", Sessions: []string{}, Task: &IssueTask{State: TaskStateSkipped}}, IssueStatusCanceled},
	} {
		if got := IssueStatusOf(c.issue, farm); got != c.want {
			t.Errorf("%s: %s, want %s", c.name, got, c.want)
		}
	}
}

func TestIssuesInTheState(t *testing.T) {
	state := EmptyCoreState()
	apply := func(f FactValue) {
		t.Helper()
		next, _ := Reduce(state, Fact{f})
		state = next
	}
	ids := func() []string {
		out := []string{}
		for _, x := range state.Issues {
			out = append(out, x.ID)
		}
		return out
	}
	apply(FactIssue{Issue: Issue{ID: "t1", Title: "一", Rank: 2, CreatedAt: 1, Sessions: []string{}}})
	apply(FactIssue{Issue: Issue{ID: "t2", Title: "二", Rank: 1, CreatedAt: 2, Sessions: []string{}}})
	apply(FactIssue{Issue: Issue{ID: "t3", Title: "三", CreatedAt: 3, Sessions: []string{"w1"}}})
	apply(FactIssue{Issue: Issue{ID: "t4", Title: "四", CreatedAt: 4, Sessions: []string{"w2"}}})
	testkit.Eq(t, ids(), []string{"t2", "t1", "t4", "t3"})
	testkit.Eq(t, state.Issues[3].Status, IssueStatusCanceled)
	apply(FactHired{Session: Session{ID: "w1", Name: "w1", Agent: "lab", Runtime: "pi", Brief: "三", Phase: Phase{PhaseWorking{Doing: Doing{Action: SessionActionEditFile}}}}})
	testkit.Eq(t, state.Issues[3].Status, IssueStatusInProgress)
	apply(FactReport{ID: "w1", Outcome: OutcomeCompleted, Summary: "好了"})
	testkit.Eq(t, state.Issues[3].Status, IssueStatusInReview)
	if _, changed := Reduce(state, Fact{FactIssue{Issue: state.Issues[0]}}); changed {
		t.Fatal("the same issue again")
	}
	apply(FactIssueGone{ID: "t1"})
	testkit.Eq(t, ids(), []string{"t2", "t4", "t3"})
	for i := range KeepClosedIssues + 3 {
		at := int64(100 + i)
		apply(FactIssue{Issue: Issue{ID: fmt.Sprintf("c%d", i), Title: "关了", CreatedAt: at, Sessions: []string{"w9"}, ClosedAt: &at}})
	}
	closed := 0
	for _, x := range state.Issues {
		if x.ClosedAt != nil {
			closed++
			if *x.ClosedAt < 103 {
				t.Fatalf("an old one stayed: %s", x.ID)
			}
		}
	}
	testkit.Eq(t, closed, KeepClosedIssues)
}
