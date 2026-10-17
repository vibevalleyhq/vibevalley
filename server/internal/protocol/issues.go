package protocol

import (
	"cmp"
	"fmt"
	"slices"
	"strings"
)

// A run gone without saying how closes the issue all the same. A playbook's issue stands as its plan does, a step's as the step does.
func IsForManager(t Issue) bool { return t.Assignee != nil && *t.Assignee == ManagerAgent }

// An issue for the manager is open only while the manager works on it.
func IssueStatusOf(t Issue, state CoreState) IssueStatus {
	if t.Closed != nil || t.ClosedAt != nil {
		return closedStatus(t.Closed)
	}
	if IsForManager(t) {
		return IssueStatusInProgress
	}
	if t.Plan != nil {
		switch t.Plan.State {
		case PlaybookStatePlanning, PlaybookStateRunning:
			return IssueStatusInProgress
		case PlaybookStateDraft, PlaybookStatePaused, PlaybookStateRipe:
			return IssueStatusInReview
		case PlaybookStateDone:
			return IssueStatusDone
		}
		return IssueStatusCanceled
	}
	if t.Step != nil {
		switch t.Step.State {
		case NodeStateWaiting:
			return IssueStatusBacklog
		case NodeStateFailed:
			return IssueStatusInReview
		case NodeStateWorking:
			if t.Step.Worker != nil {
				if h := WorkerOf(state, *t.Step.Worker); h != nil && IsBusy(*h) {
					return IssueStatusInProgress
				}
			}
			return IssueStatusInReview
		case NodeStateMerged:
			return IssueStatusDone
		}
		return IssueStatusCanceled
	}
	if n := len(t.Workers); n > 0 {
		h := WorkerOf(state, t.Workers[n-1])
		switch {
		case h == nil:
			return IssueStatusCanceled
		case IsBusy(*h):
			return IssueStatusInProgress
		default:
			return IssueStatusInReview
		}
	}
	if t.QueuedAt != nil {
		return IssueStatusTodo
	}
	return IssueStatusBacklog
}

// Done is what was asked for: merged, or answered by the manager. The rest, and a close that does not say how, is canceled.
func closedStatus(c *IssueClose) IssueStatus {
	if c != nil {
		switch *c {
		case IssueCloseMerged, IssueCloseMergedIntoPlan, IssueCloseAnswered:
			return IssueStatusDone
		}
	}
	return IssueStatusCanceled
}

const KeepClosedIssues = 50

func IssueOrder(a, b Issue) int {
	sentA, sentB := len(a.Workers) > 0, len(b.Workers) > 0
	switch {
	case !sentA && !sentB:
		return cmp.Or(cmp.Compare(a.Rank, b.Rank), cmp.Compare(a.CreatedAt, b.CreatedAt), cmp.Compare(a.ID, b.ID))
	case !sentA:
		return -1
	case !sentB:
		return 1
	}
	return cmp.Or(cmp.Compare(b.CreatedAt, a.CreatedAt), cmp.Compare(a.ID, b.ID))
}

// Keeps the latest KeepClosedIssues closed ones that are no one's sub-issue; a sub-issue stays and goes with its parent.
func withIssue(all []Issue, t Issue) []Issue {
	next := slices.DeleteFunc(slices.Clone(all), func(x Issue) bool { return x.ID == t.ID })
	next = append(next, t)
	var closed []Issue
	for _, x := range next {
		if x.ClosedAt != nil && x.Parent == nil {
			closed = append(closed, x)
		}
	}
	if len(closed) > KeepClosedIssues {
		slices.SortFunc(closed, func(a, b Issue) int { return cmp.Compare(*b.ClosedAt, *a.ClosedAt) })
		drop := map[string]bool{}
		for _, x := range closed[KeepClosedIssues:] {
			drop[x.ID] = true
		}
		next = slices.DeleteFunc(next, func(x Issue) bool { return drop[x.ID] || (x.Parent != nil && drop[*x.Parent]) })
	}
	slices.SortStableFunc(next, IssueOrder)
	return next
}

// The same slice when none changed.
func withIssueStatuses(state CoreState) CoreState {
	var next []Issue
	for i, t := range state.Issues {
		status := IssueStatusOf(t, state)
		if status == t.Status {
			continue
		}
		if next == nil {
			next = slices.Clone(state.Issues)
		}
		next[i].Status = status
	}
	if next != nil {
		state.Issues = next
	}
	return state
}

// What a worker is told when merging its base in would conflict: the owner's resolve, the plan sending a step back.
func ConflictTask(base string, files []string) string {
	return fmt.Sprintf("把 %s 合进你的分支时有冲突（%s）。请在你的分支上运行 git merge %s，把冲突解决掉，跑一遍测试，再提交。结论里说清楚每个冲突是怎么取舍的。", base, strings.Join(files, "、"), base)
}
