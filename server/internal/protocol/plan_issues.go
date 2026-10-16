package protocol

// A playbook (种植计划) is a parent issue with a plan (Issue.Plan); its steps are its sub-issues, each with its Step,
// waiting for the sub-issues it is blocked by (Issue.BlockedBy). The playbook rules (playbook.go) read a playbook as
// one piece: PlaybooksOf puts it together from the issues, PlaybookIssues takes it apart again.

import (
	"cmp"
	"slices"
	"strings"
)

// StepIssueID is the id of the sub-issue that is step key of playbook plan.
func StepIssueID(plan, key string) string { return plan + "." + key }

// planClosed is how a playbook's issue closes in state s; nil while it is open.
func planClosed(s PlaybookState) *IssueClose {
	switch s {
	case PlaybookStateDone:
		return new(IssueCloseHarvested)
	case PlaybookStateAbandoned:
		return new(IssueCloseDismissed)
	}
	return nil
}

// stepClosed is how a step's sub-issue closes: merged into the playbook's branch, skipped, or with its playbook given
// up; nil while it is open.
func stepClosed(plan PlaybookState, n PlaybookNode) *IssueClose {
	switch {
	case n.State == NodeStateMerged:
		return new(IssueCloseMerged)
	case n.State == NodeStateSkipped, plan == PlaybookStateDone, plan == PlaybookStateAbandoned:
		return new(IssueCloseDismissed)
	}
	return nil
}

// PlaybookIssues is pb as issues: its parent, then a sub-issue for each step in plan order. What only the issues know
// (their runs, priority, when they were written down and when they closed) comes from before, the same issues as they
// were; one closing now closes at now.
func PlaybookIssues(pb Playbook, before []Issue, now int64) []Issue {
	was := map[string]Issue{}
	for _, t := range before {
		was[t.ID] = t
	}
	keep := func(t Issue, closed *IssueClose) Issue {
		t.Runs, t.Priority, t.CreatedAt = []string{}, PriorityNormal, pb.CreatedAt
		if old, ok := was[t.ID]; ok {
			t.Runs, t.Priority, t.CreatedAt, t.Status = old.Runs, old.Priority, old.CreatedAt, old.Status
			if closed != nil && old.ClosedAt != nil {
				t.ClosedAt = old.ClosedAt
			}
		}
		if t.Runs == nil {
			t.Runs = []string{}
		}
		t.Closed = closed
		if closed != nil && t.ClosedAt == nil {
			t.ClosedAt = &now
		}
		return t
	}
	project := pb.Project
	out := []Issue{keep(Issue{
		ID: pb.ID, Title: pb.Title, Description: pb.Goal, Project: &project,
		Plan: &IssuePlan{State: pb.State, Branch: pb.Branch, Parallel: pb.Parallel, Note: pb.Note},
	}, planClosed(pb.State))}
	for i, n := range pb.Nodes {
		var blocked []string
		for _, need := range n.Needs {
			blocked = append(blocked, StepIssueID(pb.ID, need))
		}
		parent := pb.ID
		out = append(out, keep(Issue{
			ID: StepIssueID(pb.ID, n.ID), Title: n.Title, Description: n.Task, Project: &project, Agent: n.Agent, Rank: int64(i),
			Parent: &parent, BlockedBy: blocked,
			Step: &IssueStep{
				Key: n.ID, State: n.State, Check: n.Check, Scope: n.Scope, Acceptance: n.Acceptance, Frozen: n.Frozen, Helper: n.Helper,
				Conclusion: n.Conclusion, Commits: n.Commits, Spent: n.Spent, Tries: n.Tries, Failures: n.Failures,
			},
		}, stepClosed(pb.State, n)))
	}
	return out
}

// playbookFrom is the playbook parent is, with its steps among issues.
func playbookFrom(parent Issue, issues []Issue) Playbook {
	plan := parent.Plan
	pb := Playbook{
		ID: parent.ID, Title: parent.Title, Goal: parent.Description, State: plan.State, Branch: plan.Branch, Parallel: plan.Parallel,
		Note: plan.Note, CreatedAt: parent.CreatedAt, Nodes: []PlaybookNode{},
	}
	if parent.Project != nil {
		pb.Project = *parent.Project
	}
	var steps []Issue
	for _, t := range issues {
		if t.Parent != nil && *t.Parent == parent.ID && t.Step != nil {
			steps = append(steps, t)
		}
	}
	slices.SortStableFunc(steps, func(a, b Issue) int { return cmp.Or(cmp.Compare(a.Rank, b.Rank), cmp.Compare(a.ID, b.ID)) })
	for _, t := range steps {
		s := t.Step
		needs := []string{}
		for _, b := range t.BlockedBy {
			needs = append(needs, strings.TrimPrefix(b, parent.ID+"."))
		}
		pb.Nodes = append(pb.Nodes, PlaybookNode{
			ID: s.Key, Title: t.Title, Task: t.Description, Needs: needs, Agent: t.Agent, Check: s.Check, Scope: s.Scope,
			Acceptance: s.Acceptance, Frozen: s.Frozen, State: s.State, Helper: s.Helper, Conclusion: s.Conclusion, Commits: s.Commits,
			Spent: s.Spent, Tries: s.Tries, Failures: s.Failures,
		})
	}
	return pb
}

// PlaybooksOf is every playbook in the state, oldest first.
func PlaybooksOf(state FarmState) []Playbook {
	out := []Playbook{}
	for _, t := range state.Issues {
		if t.Plan != nil {
			out = append(out, playbookFrom(t, state.Issues))
		}
	}
	slices.SortStableFunc(out, func(a, b Playbook) int { return cmp.Or(cmp.Compare(a.CreatedAt, b.CreatedAt), cmp.Compare(a.ID, b.ID)) })
	return out
}

// PlaybookOf is the playbook id in the state; nil when it is not there.
func PlaybookOf(state FarmState, id string) *Playbook {
	for _, t := range state.Issues {
		if t.ID == id && t.Plan != nil {
			pb := playbookFrom(t, state.Issues)
			return &pb
		}
	}
	return nil
}
