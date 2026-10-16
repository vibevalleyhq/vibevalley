package protocol

import (
	"fmt"
	"testing"
)

func TestIssueStatus(t *testing.T) {
	farm := EmptyFarm()
	farm.Helpers = []Helper{
		{ID: "w1", Name: "w1", Agent: "lab", Runtime: "pi", Task: "…", Phase: Phase{PhaseWorking{Doing: Doing{Action: WorkerActionEditFile}}}},
		{ID: "w2", Name: "w2", Agent: "lab", Runtime: "pi", Task: "…", Phase: Phase{PhaseRipe{}}},
	}
	queued, closed, harvested := int64(5), int64(9), IssueCloseHarvested
	for _, c := range []struct {
		name  string
		issue Issue
		want  IssueStatus
	}{
		{"written down", Issue{ID: "t1", Runs: []string{}}, IssueStatusTodo},
		{"waiting for room", Issue{ID: "t2", Runs: []string{}, QueuedAt: &queued}, IssueStatusQueued},
		{"its run at work", Issue{ID: "t3", Runs: []string{"w1"}}, IssueStatusWorking},
		{"its turn over", Issue{ID: "t4", Runs: []string{"w2"}}, IssueStatusWaiting},
		{"the last run counts", Issue{ID: "t5", Runs: []string{"w0", "w1"}}, IssueStatusWorking},
		{"closed", Issue{ID: "t6", Runs: []string{"w0"}, ClosedAt: &closed, Closed: &harvested}, IssueStatusClosed},
		{"its run gone", Issue{ID: "t7", Runs: []string{"w0"}}, IssueStatusClosed},
	} {
		if got := IssueStatusOf(c.issue, farm); got != c.want {
			t.Errorf("%s: %s, want %s", c.name, got, c.want)
		}
	}
}

func TestIssuesInTheState(t *testing.T) {
	state := EmptyFarm()
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
	apply(FactIssue{Issue: Issue{ID: "t1", Title: "一", Rank: 2, CreatedAt: 1, Runs: []string{}}})
	apply(FactIssue{Issue: Issue{ID: "t2", Title: "二", Rank: 1, CreatedAt: 2, Runs: []string{}}})
	apply(FactIssue{Issue: Issue{ID: "t3", Title: "三", CreatedAt: 3, Runs: []string{"w1"}}})
	apply(FactIssue{Issue: Issue{ID: "t4", Title: "四", CreatedAt: 4, Runs: []string{"w2"}}})
	rulesEqual(t, ids(), []string{"t2", "t1", "t4", "t3"})
	rulesEqual(t, state.Issues[3].Status, IssueStatusClosed)
	apply(FactHired{Helper: Helper{ID: "w1", Name: "w1", Agent: "lab", Runtime: "pi", Task: "三", Phase: Phase{PhaseWorking{Doing: Doing{Action: WorkerActionEditFile}}}}})
	rulesEqual(t, state.Issues[3].Status, IssueStatusWorking)
	apply(FactReport{ID: "w1", Outcome: OutcomeCompleted, Summary: "好了"})
	rulesEqual(t, state.Issues[3].Status, IssueStatusWaiting)
	if _, changed := Reduce(state, Fact{FactIssue{Issue: state.Issues[0]}}); changed {
		t.Fatal("the same issue again")
	}
	apply(FactIssueGone{ID: "t1"})
	rulesEqual(t, ids(), []string{"t2", "t4", "t3"})
	for i := range KeepClosedIssues + 3 {
		at := int64(100 + i)
		apply(FactIssue{Issue: Issue{ID: fmt.Sprintf("c%d", i), Title: "关了", CreatedAt: at, Runs: []string{"w9"}, ClosedAt: &at}})
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
	rulesEqual(t, closed, KeepClosedIssues)
}

func TestIssueTitleAndJob(t *testing.T) {
	title, description := SplitJob("\n  写打卡  \n\n细节在 README\n还有测试\n")
	rulesEqual(t, [2]string{title, description}, [2]string{"写打卡", "细节在 README\n还有测试"})
	rulesEqual(t, IssueJob(Issue{Title: title, Description: description}), "写打卡\n\n细节在 README\n还有测试")
	rulesEqual(t, IssueJob(Issue{Title: "只有标题"}), "只有标题")
	title, description = SplitJob("  ")
	rulesEqual(t, [2]string{title, description}, [2]string{"", ""})
}
