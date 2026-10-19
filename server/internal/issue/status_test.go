package issue

import (
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
)

// Where each status may go, sent or not: the owner never moves into in_progress or in_review.
func TestStatusMoves(t *testing.T) {
	type row struct {
		from protocol.IssueStatus
		sent bool
		to   []protocol.IssueStatus
	}
	todo, done, canceled, backlog := protocol.IssueStatusTodo, protocol.IssueStatusDone, protocol.IssueStatusCanceled, protocol.IssueStatusBacklog
	for _, r := range []row{
		{protocol.IssueStatusBacklog, false, []protocol.IssueStatus{todo, canceled}},
		{protocol.IssueStatusTodo, false, []protocol.IssueStatus{backlog, canceled}},
		{protocol.IssueStatusInProgress, true, []protocol.IssueStatus{canceled}},
		{protocol.IssueStatusInReview, true, []protocol.IssueStatus{todo, done, canceled}},
		{protocol.IssueStatusDone, true, []protocol.IssueStatus{todo}},
		{protocol.IssueStatusCanceled, true, []protocol.IssueStatus{todo}},
		{protocol.IssueStatusCanceled, false, []protocol.IssueStatus{backlog}},
	} {
		issue := protocol.Issue{Status: r.from, Sessions: []string{}}
		if r.sent {
			issue.Sessions = []string{"w1"}
		}
		testkit.Eq(t, statusMoves(issue), r.to, string(r.from))
		for _, to := range protocol.IssueStatusValues {
			if m, why := statusMove(issue, to); m == moveNone && why == "" {
				t.Errorf("%s → %s refused without a reason", r.from, to)
			}
		}
	}
	// An acceptance that must pass first: no harvest until it has.
	required := protocol.Issue{Status: protocol.IssueStatusInReview, Sessions: []string{"w1"}, Acceptance: protocol.AcceptanceRequired}
	testkit.Eq(t, statusMoves(required), []protocol.IssueStatus{todo, canceled}, "required, not yet passed")
	at := int64(1)
	required.AcceptedAt = &at
	testkit.Eq(t, statusMoves(required), []protocol.IssueStatus{todo, done, canceled}, "required and passed")
	// Being drafted: it can be dropped, not started until the draft is back.
	drafting := protocol.Issue{Status: protocol.IssueStatusBacklog, Sessions: []string{}, Drafting: &protocol.IssueDrafting{Session: "w2", Name: "试验田"}}
	testkit.Eq(t, statusMoves(drafting), []protocol.IssueStatus{canceled}, "drafting")
	manager, graph := protocol.ManagerAgent, protocol.IssueGraph{State: protocol.GraphStateDraft}
	for name, issue := range map[string]protocol.Issue{
		"the manager's":  {Status: protocol.IssueStatusInProgress, Assignee: &manager},
		"a task graph's": {Status: protocol.IssueStatusInReview, Graph: &graph},
	} {
		testkit.Eq(t, statusMoves(issue), []protocol.IssueStatus{}, name)
	}
}
