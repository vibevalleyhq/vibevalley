package protocol

import (
	"fmt"
	"slices"
	"strings"
	"testing"

	"vibevalley/internal/testkit"
	"vibevalley/pkg/x/ptr"
)

func rulesTask(id string, needs ...string) Task {
	if needs == nil {
		needs = []string{}
	}
	return Task{ID: id, Title: id, Brief: "做 " + id, Needs: needs, State: TaskStateWaiting, Tries: 0}
}

func rulesDiamond() []Task {
	return []Task{rulesTask("a"), rulesTask("b", "a"), rulesTask("c", "a"), rulesTask("d", "b", "c")}
}

func rulesGraph(tasks []Task, change ...func(*TaskGraph)) TaskGraph {
	graph := TaskGraph{ID: "p1", Title: "菱形", Goal: "做一个菱形", Project: "diamond", State: GraphStateRunning, Tasks: tasks, Parallel: 3, CreatedAt: 0}
	for _, c := range change {
		c(&graph)
	}
	return graph
}

func rulesState(s GraphState) func(*TaskGraph) { return func(graph *TaskGraph) { graph.State = s } }

func rulesWith(n Task, change func(*Task)) Task {
	change(&n)
	return n
}

func rulesIDs(tasks []Task) []string {
	out := []string{}
	for _, n := range tasks {
		out = append(out, n.ID)
	}
	return out
}

func TestTaskProblems(t *testing.T) {
	testkit.Eq(t, GraphProblems(rulesDiamond()), []string{})
	testkit.Eq(t, GraphProblems(nil), []string{"计划里一步都没有"})
	join := func(tasks ...Task) string { return strings.Join(GraphProblems(tasks), ",") }
	testkit.Match(t, join(rulesTask("a"), rulesTask("a")), `重复`)
	testkit.Match(t, join(rulesTask("第一步")), `不能当步骤 id`)
	testkit.Match(t, join(rulesTask("a", "zz")), `「a」要等的「zz」不存在`)
	testkit.Match(t, join(rulesTask("a", "a")), `不能等自己`)
	testkit.Match(t, join(rulesTask("a", "b"), rulesTask("b", "a"), rulesTask("c")), `成了一个圈：a、b`)
	many := []Task{}
	for i := range MaxTasks + 1 {
		many = append(many, rulesTask("s"+string(rune('a'+i))))
	}
	testkit.Match(t, join(many...), `最多 12 步`)
	testkit.Match(t, join(rulesWith(rulesTask("a"), func(n *Task) { n.Brief = " " })), `没有工单`)
	// JavaScript's trim takes U+FEFF and leaves U+0085; and a step id is ASCII, case folding or not.
	testkit.Match(t, join(rulesWith(rulesTask("a"), func(n *Task) { n.Brief = "\ufeff" })), `没有工单`)
	testkit.Eq(t, GraphProblems([]Task{rulesWith(rulesTask("a"), func(n *Task) { n.Brief = "\u0085" })}), []string{})
	testkit.Match(t, join(rulesTask("ſ")), `不能当步骤 id`)
}

func TestLayersOf(t *testing.T) {
	testkit.Eq(t, LayersOf(rulesDiamond()), [][]string{{"a"}, {"b", "c"}, {"d"}})
	testkit.Eq(t, LayersOf([]Task{rulesTask("x"), rulesTask("y", "x"), rulesTask("z", "x", "y")}), [][]string{{"x"}, {"y"}, {"z"}})
	testkit.Eq(t, LayersOf(nil), [][]string{})
}

func TestTaskAsIssues(t *testing.T) {
	graph := rulesGraph(rulesDiamond(), func(graph *TaskGraph) {
		graph.Branch, graph.Note = ptr.To("vibevalley/task-p1"), ptr.To("在做")
		graph.Tasks[0].State, graph.Tasks[0].Commits = TaskStateMerged, []string{"abc1234"}
		graph.Tasks[1].State, graph.Tasks[1].Session, graph.Tasks[1].Tries = TaskStateWorking, ptr.To("w2"), 1
	})
	issues := GraphIssues(graph, nil, 50)
	ids := []string{}
	for _, x := range issues {
		ids = append(ids, x.ID)
	}
	testkit.Eq(t, ids, []string{"p1", "p1.a", "p1.b", "p1.c", "p1.d"})
	testkit.Eq(t, issues[0].Graph.State, GraphStateRunning)
	testkit.Eq(t, issues[4].BlockedBy, []string{"p1.b", "p1.c"})
	testkit.Eq(t, *issues[1].Closed, IssueCloseMergedIntoGraph)
	testkit.Eq(t, *issues[1].ClosedAt, int64(50))
	testkit.Eq(t, issues[2].ClosedAt, (*int64)(nil))
	state := withGraphs(EmptyCoreState(), graph)
	read := graph
	read.Tasks = slices.Clone(graph.Tasks)
	read.Tasks[3].BlockedBy = []string{"b", "c"}
	read.Layers, read.Settled = [][]string{{"a"}, {"b", "c"}, {"d"}}, 1
	testkit.Eq(t, *GraphOf(state, "p1"), read, "read back, with what follows from it")
	testkit.Eq(t, GraphsOf(state), []TaskGraph{read})
	statuses := []IssueStatus{}
	for _, id := range ids {
		statuses = append(statuses, issueIn(state, id).Status)
	}
	testkit.Eq(t, statuses, []IssueStatus{IssueStatusInProgress, IssueStatusDone, IssueStatusInReview, IssueStatusBacklog, IssueStatusBacklog})
	before := slices.Clone(issues)
	for i := range before {
		if before[i].ID == "p1.b" {
			before[i].Sessions = []string{"w2"}
		}
	}
	again := GraphIssues(graph, before, 90)
	testkit.Eq(t, again[2].Sessions, []string{"w2"})
	testkit.Eq(t, *again[1].ClosedAt, int64(50))
	gone := graph
	gone.State = GraphStateAbandoned
	for _, x := range GraphIssues(gone, nil, 7) {
		if x.ClosedAt == nil {
			t.Fatalf("%s open", x.ID)
		}
	}
}

func TestClosedGraphsGoWithTheirTasks(t *testing.T) {
	state := withGraphs(EmptyCoreState(), rulesGraph(rulesDiamond(), rulesState(GraphStateDone)))
	for i := range KeepClosedIssues {
		at := int64(100 + i)
		state, _ = Reduce(state, Fact{FactIssue{Issue: Issue{ID: fmt.Sprintf("c%d", i), Title: "关了", CreatedAt: at, Sessions: []string{}, ClosedAt: &at}}})
	}
	testkit.Eq(t, GraphOf(state, "p1"), (*TaskGraph)(nil))
	for _, x := range state.Issues {
		if x.Parent != nil {
			t.Fatalf("%s stayed without its parent", x.ID)
		}
	}
}

func TestTaskChanges(t *testing.T) {
	kinds := func(before *TaskGraph, after TaskGraph) []string {
		out := []string{}
		for _, c := range GraphChanges(before, after) {
			if c.Task != nil {
				out = append(out, *c.Task+":"+string(c.Kind))
			} else {
				out = append(out, string(c.Kind))
			}
		}
		return out
	}
	node := func(id string, change func(*Task), needs ...string) Task {
		return rulesWith(rulesTask(id, needs...), change)
	}
	splitting := rulesGraph([]Task{}, rulesState(GraphStateSplitting))
	testkit.Eq(t, GraphChanges(nil, splitting), []GraphChange{{Graph: "p1", Kind: GraphEventKindSplitting, Detail: ptr.To("做一个菱形")}})
	draft := rulesGraph(rulesDiamond(), rulesState(GraphStateDraft))
	testkit.Eq(t, kinds(&splitting, draft), []string{"drafted"})
	edited := rulesGraph(append(append([]Task{node("a", func(n *Task) { n.Brief = "换个做法"; n.Check = ptr.To("pnpm test") })}, rulesDiamond()[1:3]...), rulesTask("e", "a")), rulesState(GraphStateDraft))
	testkit.Eq(t, kinds(&draft, edited), []string{"a:task_edited", "e:task_added", "d:task_removed"})
	testkit.Eq(t, GraphChanges(&draft, edited)[0].Changes, []TaskFieldChange{{Field: "工单", From: "做 a", To: "换个做法"}, {Field: "检查", From: "", To: "pnpm test"}})

	rest := rulesDiamond()[1:]
	with := func(a Task, change ...func(*TaskGraph)) TaskGraph {
		return rulesGraph(append([]Task{a}, rest...), change...)
	}
	running := rulesGraph(rulesDiamond(), func(graph *TaskGraph) { graph.Branch = ptr.To("vibevalley/task-p1") })
	testkit.Eq(t, GraphChanges(&draft, running), []GraphChange{{Graph: "p1", Kind: GraphEventKindStarted, Detail: ptr.To("vibevalley/task-p1")}})
	aWorking := with(node("a", func(n *Task) { n.State = TaskStateWorking; n.Session = ptr.To("w3") }))
	testkit.Eq(t, GraphChanges(&running, aWorking), []GraphChange{{Graph: "p1", Task: ptr.To("a"), Kind: GraphEventKindTaskStarted, Session: ptr.To("w3")}})
	sentBack := with(node("a", func(n *Task) { n.State = TaskStateWorking; n.Session = ptr.To("w3"); n.Tries = 1 }))
	testkit.Eq(t, kinds(&aWorking, sentBack), []string{"a:task_sent_back"})
	merged := with(node("a", func(n *Task) {
		n.State = TaskStateMerged
		n.Conclusion = ptr.To("写好了")
		n.Commits = []string{"3f2a1bc"}
	}))
	testkit.Eq(t, GraphChanges(&sentBack, merged), []GraphChange{{Graph: "p1", Task: ptr.To("a"), Kind: GraphEventKindTaskMerged, Session: ptr.To("w3"), Detail: ptr.To("写好了"), Commits: []string{"3f2a1bc"}}})
	failed := with(node("a", func(n *Task) {
		n.State = TaskStateFailed
		n.Session = ptr.To("w3")
		n.Conclusion = ptr.To("测试没过")
	}))
	testkit.Eq(t, kinds(&aWorking, failed), []string{"a:task_failed"})
	testkit.Eq(t, kinds(&failed, aWorking), []string{"a:task_retried"})
	testkit.Eq(t, kinds(&failed, running), []string{"a:task_retried"})
	testkit.Eq(t, kinds(&aWorking, running), []string{"a:task_requeued"})
	testkit.Eq(t, kinds(&failed, with(node("a", func(n *Task) { n.State = TaskStateSkipped }))), []string{"a:task_skipped"})

	change := func(graph TaskGraph, c func(*TaskGraph)) TaskGraph {
		c(&graph)
		return graph
	}
	testkit.Eq(t, kinds(&running, change(running, func(graph *TaskGraph) { graph.Note = ptr.To("「a」先等着：地满了") })), []string{"noted"})
	testkit.Eq(t, kinds(&running, change(running, func(graph *TaskGraph) { graph.State = GraphStatePaused; graph.Note = ptr.To("暂停了") })), []string{"paused"})
	paused := change(running, rulesState(GraphStatePaused))
	testkit.Eq(t, kinds(&paused, running), []string{"resumed"})
	testkit.Eq(t, kinds(&running, change(running, rulesState(GraphStateRipe))), []string{"ripe"})
	ripe := change(running, rulesState(GraphStateRipe))
	testkit.Eq(t, kinds(&ripe, change(running, rulesState(GraphStateDone))), []string{"merged"})
	testkit.Eq(t, kinds(&aWorking, change(running, func(graph *TaskGraph) { graph.State = GraphStateAbandoned; graph.Note = ptr.To("放弃了") })), []string{"abandoned"})
	testkit.Eq(t, kinds(&running, running), []string{})
}

func TestTaskEventText(t *testing.T) {
	titleOf := func(id string) string {
		if id == "a" {
			return "数据层"
		}
		return id
	}
	testkit.Eq(t, GraphEventText(GraphChange{Kind: GraphEventKindTaskMerged, Task: ptr.To("a"), Commits: []string{"3f2a1bc"}, Detail: ptr.To("写好了")}, titleOf), "「数据层」合进了计划分支（3f2a1bc）：写好了")
	testkit.Eq(t, GraphEventText(GraphChange{Kind: GraphEventKindTaskEdited, Task: ptr.To("a"), Changes: []TaskFieldChange{{Field: "工单", From: "x", To: "y"}}}, titleOf), "改了「数据层」的工单")
	testkit.Eq(t, GraphEventText(GraphChange{Kind: GraphEventKindTaskRemoved, Task: ptr.To("zz"), Detail: ptr.To("旧的一步")}, nil), "删了一步「旧的一步」")
	testkit.Eq(t, GraphEventText(GraphChange{Kind: GraphEventKindStarted, Detail: ptr.To("vibevalley/task-p1")}, nil), "开工了，分支 vibevalley/task-p1")
}
