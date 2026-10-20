package protocol

import (
	"cmp"
	"slices"
	"strings"
)

func TaskIssueID(graph, key string) string { return graph + "." + key }

func graphClosed(s GraphState) *IssueClose {
	switch s {
	case GraphStateDone:
		return new(IssueCloseMerged)
	case GraphStateAbandoned:
		return new(IssueCloseDismissed)
	}
	return nil
}

func taskClosed(graph GraphState, n Task) *IssueClose {
	switch {
	case n.State == TaskStateMerged:
		return new(IssueCloseMergedIntoGraph)
	case n.State == TaskStateSkipped, graph == GraphStateDone, graph == GraphStateAbandoned:
		return new(IssueCloseDismissed)
	}
	return nil
}

// What only the issues know (their runs, priority, when they were written down and closed) comes from before; one closing now closes at now.
func GraphIssues(graph TaskGraph, before []Issue, now int64) []Issue {
	was := map[string]Issue{}
	for _, t := range before {
		was[t.ID] = t
	}
	keep := func(t Issue, closed *IssueClose) Issue {
		t.Sessions, t.Priority, t.CreatedAt = []string{}, PriorityMedium, graph.CreatedAt
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
	project := graph.Project
	// A helper's issue split under it keeps who it was given to.
	var assignee *string
	if old, ok := was[graph.ID]; ok {
		assignee = old.Assignee
	}
	out := []Issue{keep(Issue{
		ID: graph.ID, Title: graph.Title, Description: graph.Goal, Project: &project, Assignee: assignee,
		Graph: &IssueGraph{State: graph.State, Branch: graph.Branch, Parallel: graph.Parallel, Note: graph.Note},
	}, graphClosed(graph.State))}
	for i, n := range graph.Tasks {
		var blocked []string
		for _, need := range n.Needs {
			blocked = append(blocked, TaskIssueID(graph.ID, need))
		}
		parent := graph.ID
		out = append(out, keep(Issue{
			ID: TaskIssueID(graph.ID, n.ID), Title: n.Title, Description: n.Brief, Project: &project, Assignee: n.Agent, Rank: int64(i),
			Parent: &parent, BlockedBy: blocked,
			Task: &IssueTask{
				Key: n.ID, State: n.State, Check: n.Check, Scope: n.Scope, Acceptance: n.Acceptance, Frozen: n.Frozen, Session: n.Session,
				Conclusion: n.Conclusion, Commits: n.Commits, Spent: n.Spent, Tries: n.Tries, Failures: n.Failures,
			},
		}, taskClosed(graph.State, n)))
	}
	return out
}

func graphFrom(parent Issue, issues []Issue) TaskGraph {
	task := parent.Graph
	graph := TaskGraph{
		ID: parent.ID, Title: parent.Title, Goal: parent.Description, State: task.State, Branch: task.Branch, Parallel: task.Parallel,
		Note: task.Note, CreatedAt: parent.CreatedAt, Tasks: []Task{},
	}
	if parent.Project != nil {
		graph.Project = *parent.Project
	}
	var steps []Issue
	for _, t := range issues {
		if t.Parent != nil && *t.Parent == parent.ID && t.Task != nil {
			steps = append(steps, t)
		}
	}
	slices.SortStableFunc(steps, func(a, b Issue) int { return cmp.Or(cmp.Compare(a.Rank, b.Rank), cmp.Compare(a.ID, b.ID)) })
	for _, t := range steps {
		s := t.Task
		needs := []string{}
		for _, b := range t.BlockedBy {
			needs = append(needs, strings.TrimPrefix(b, parent.ID+"."))
		}
		graph.Tasks = append(graph.Tasks, Task{
			ID: s.Key, Title: t.Title, Brief: t.Description, Needs: needs, Agent: t.Assignee, Check: s.Check, Scope: s.Scope,
			Acceptance: s.Acceptance, Frozen: s.Frozen, State: s.State, Session: s.Session, Conclusion: s.Conclusion, Commits: s.Commits,
			Spent: s.Spent, Tries: s.Tries, Failures: s.Failures,
		})
	}
	for i, n := range graph.Tasks {
		if blocked := BlockedBy(graph, n); len(blocked) > 0 {
			graph.Tasks[i].BlockedBy = blocked
		}
		if IsSettled(n) {
			graph.Settled++
		}
	}
	graph.Layers, graph.AsksForYou, graph.Spent = LayersOf(graph.Tasks), AsksForYou(graph), GraphSpent(graph)
	return graph
}

func GraphsOf(state CoreState) []TaskGraph {
	out := []TaskGraph{}
	for _, t := range state.Issues {
		if t.Graph != nil {
			out = append(out, graphFrom(t, state.Issues))
		}
	}
	slices.SortStableFunc(out, func(a, b TaskGraph) int {
		return cmp.Or(cmp.Compare(a.CreatedAt, b.CreatedAt), cmp.Compare(a.ID, b.ID))
	})
	return out
}

func GraphOf(state CoreState, id string) *TaskGraph {
	for _, t := range state.Issues {
		if t.ID == id && t.Graph != nil {
			graph := graphFrom(t, state.Issues)
			return &graph
		}
	}
	return nil
}
