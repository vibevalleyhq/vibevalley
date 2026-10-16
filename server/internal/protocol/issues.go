package protocol

import (
	"cmp"
	"slices"
	"strings"
)

// IssueStatusOf is where an issue stands (docs/concepts.md): closed once it closed; else by its last run, at work
// (working) or with its turn over and waiting for the person (waiting); with no run on the farm, waiting for room
// (queued) or just written down (todo). A run gone without saying how closes it all the same.
//
// A playbook's issue stands as its plan does: being planned or worked, waiting on the person (a draft, paused, all
// done), or over. A step's stands as the step does: waiting its turn (todo), at work by its helper, failed and waiting
// on the person, or settled.
func IssueStatusOf(t Issue, state FarmState) IssueStatus {
	if t.Closed != nil || t.ClosedAt != nil {
		return IssueStatusClosed
	}
	if t.Plan != nil {
		switch t.Plan.State {
		case PlaybookStatePlanning, PlaybookStateRunning:
			return IssueStatusWorking
		case PlaybookStateDraft, PlaybookStatePaused, PlaybookStateRipe:
			return IssueStatusWaiting
		}
		return IssueStatusClosed
	}
	if t.Step != nil {
		switch t.Step.State {
		case NodeStateWaiting:
			return IssueStatusTodo
		case NodeStateFailed:
			return IssueStatusWaiting
		case NodeStateWorking:
			if t.Step.Helper != nil {
				if h := HelperOf(state, *t.Step.Helper); h != nil && IsBusy(*h) {
					return IssueStatusWorking
				}
			}
			return IssueStatusWaiting
		}
		return IssueStatusClosed
	}
	if n := len(t.Runs); n > 0 {
		h := HelperOf(state, t.Runs[n-1])
		switch {
		case h == nil:
			return IssueStatusClosed
		case IsBusy(*h):
			return IssueStatusWorking
		default:
			return IssueStatusWaiting
		}
	}
	if t.QueuedAt != nil {
		return IssueStatusQueued
	}
	return IssueStatusTodo
}

// KeepClosedIssues is how many closed issues the state keeps, the latest closed, each with its sub-issues; the board
// asks for older ones.
const KeepClosedIssues = 50

// IssueJob is what a run of the issue is told: its title, then its description.
func IssueJob(t Issue) string {
	if t.Description == "" {
		return t.Title
	}
	return t.Title + "\n\n" + t.Description
}

// SplitJob is a job written in one piece as an issue's title (its first line that says something) and description
// (what comes after it).
func SplitJob(job string) (title, description string) {
	lines := strings.Split(strings.ReplaceAll(job, "\r\n", "\n"), "\n")
	for i, line := range lines {
		if t := strings.TrimSpace(line); t != "" {
			return t, strings.TrimSpace(strings.Join(lines[i+1:], "\n"))
		}
	}
	return "", ""
}

// IssueOrder is the board's order: the issues not sent yet by rank, then the rest newest first.
func IssueOrder(a, b Issue) int {
	sentA, sentB := len(a.Runs) > 0, len(b.Runs) > 0
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

// withIssue is the issues with t put in (or in place of the one of its id), in the board's order, keeping the latest
// KeepClosedIssues closed ones that are no one's sub-issue; a sub-issue stays and goes with its parent.
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

// withIssueStatuses is the state with every issue's status as its runs on the farm make it now; the same slice when
// none changed.
func withIssueStatuses(state FarmState) FarmState {
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
