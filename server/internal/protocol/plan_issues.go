package protocol

import (
	"cmp"
	"slices"
	"strings"
)

func StepIssueID(plan, key string) string { return plan + "." + key }

func planClosed(s PlaybookState) *IssueClose {
	switch s {
	case PlaybookStateDone:
		return new(IssueCloseMerged)
	case PlaybookStateAbandoned:
		return new(IssueCloseDismissed)
	}
	return nil
}

func stepClosed(plan PlaybookState, n PlaybookNode) *IssueClose {
	switch {
	case n.State == NodeStateMerged:
		return new(IssueCloseMergedIntoPlan)
	case n.State == NodeStateSkipped, plan == PlaybookStateDone, plan == PlaybookStateAbandoned:
		return new(IssueCloseDismissed)
	}
	return nil
}

// What only the issues know (their runs, priority, when they were written down and closed) comes from before; one closing now closes at now.
func PlaybookIssues(pb Playbook, before []Issue, now int64) []Issue {
	was := map[string]Issue{}
	for _, t := range before {
		was[t.ID] = t
	}
	keep := func(t Issue, closed *IssueClose) Issue {
		t.Sessions, t.Priority, t.CreatedAt = []string{}, PriorityMedium, pb.CreatedAt
		if old, ok := was[t.ID]; ok {
			t.Sessions, t.Priority, t.CreatedAt, t.Status = old.Sessions, old.Priority, old.CreatedAt, old.Status
			if closed != nil && old.ClosedAt != nil {
				t.ClosedAt = old.ClosedAt
			}
		}
		if t.Sessions == nil {
			t.Sessions = []string{}
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
			ID: StepIssueID(pb.ID, n.ID), Title: n.Title, Description: n.Task, Project: &project, Assignee: n.Agent, Rank: int64(i),
			Parent: &parent, BlockedBy: blocked,
			Step: &IssueStep{
				Key: n.ID, State: n.State, Check: n.Check, Scope: n.Scope, Acceptance: n.Acceptance, Frozen: n.Frozen, Session: n.Session,
				Conclusion: n.Conclusion, Commits: n.Commits, Spent: n.Spent, Tries: n.Tries, Failures: n.Failures,
			},
		}, stepClosed(pb.State, n)))
	}
	return out
}

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
			ID: s.Key, Title: t.Title, Task: t.Description, Needs: needs, Agent: t.Assignee, Check: s.Check, Scope: s.Scope,
			Acceptance: s.Acceptance, Frozen: s.Frozen, State: s.State, Session: s.Session, Conclusion: s.Conclusion, Commits: s.Commits,
			Spent: s.Spent, Tries: s.Tries, Failures: s.Failures,
		})
	}
	for i, n := range pb.Nodes {
		if blocked := BlockedBy(pb, n); len(blocked) > 0 {
			pb.Nodes[i].BlockedBy = blocked
		}
		if IsSettled(n) {
			pb.Settled++
		}
	}
	pb.Layers, pb.AsksForYou, pb.Spent = LayersOf(pb.Nodes), AsksForYou(pb), PlaybookSpent(pb)
	return pb
}

func PlaybooksOf(state CoreState) []Playbook {
	out := []Playbook{}
	for _, t := range state.Issues {
		if t.Plan != nil {
			out = append(out, playbookFrom(t, state.Issues))
		}
	}
	slices.SortStableFunc(out, func(a, b Playbook) int { return cmp.Or(cmp.Compare(a.CreatedAt, b.CreatedAt), cmp.Compare(a.ID, b.ID)) })
	return out
}

func PlaybookOf(state CoreState, id string) *Playbook {
	for _, t := range state.Issues {
		if t.ID == id && t.Plan != nil {
			pb := playbookFrom(t, state.Issues)
			return &pb
		}
	}
	return nil
}
