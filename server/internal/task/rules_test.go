package task

import (
	"strings"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/pkg/x/ptr"
)

func rulesTask(id string, needs ...string) protocol.Task {
	if needs == nil {
		needs = []string{}
	}
	return protocol.Task{ID: id, Title: id, Brief: "做 " + id, Needs: needs, State: protocol.TaskStateWaiting, Tries: 0}
}

func rulesDiamond() []protocol.Task {
	return []protocol.Task{rulesTask("a"), rulesTask("b", "a"), rulesTask("c", "a"), rulesTask("d", "b", "c")}
}

func rulesGraph(nodes []protocol.Task, change ...func(*protocol.TaskGraph)) protocol.TaskGraph {
	graph := protocol.TaskGraph{ID: "p1", Title: "菱形", Goal: "做一个菱形", Project: "diamond", State: protocol.GraphStateRunning, Tasks: nodes, Parallel: 3, CreatedAt: 0}
	for _, c := range change {
		c(&graph)
	}
	return graph
}

func rulesState(s protocol.GraphState) func(*protocol.TaskGraph) {
	return func(graph *protocol.TaskGraph) { graph.State = s }
}

func rulesWith(n protocol.Task, change func(*protocol.Task)) protocol.Task {
	change(&n)
	return n
}

func rulesIDs(nodes []protocol.Task) []string {
	out := []string{}
	for _, n := range nodes {
		out = append(out, n.ID)
	}
	return out
}

func TestReadyAndStartable(t *testing.T) {
	testkit.Eq(t, rulesIDs(protocol.ReadyTasks(rulesGraph(rulesDiamond()))), []string{"a"})
	merged := func(n *protocol.Task) { n.State = protocol.TaskStateMerged }
	aDone := rulesGraph(append([]protocol.Task{rulesWith(rulesTask("a"), merged)}, rulesDiamond()[1:]...))
	testkit.Eq(t, rulesIDs(protocol.ReadyTasks(aDone)), []string{"b", "c"})
	one := aDone
	one.Parallel = 1
	testkit.Eq(t, rulesIDs(startable(one)), []string{"b"})
	bWorking := rulesGraph([]protocol.Task{rulesWith(rulesTask("a"), merged), rulesWith(rulesTask("b", "a"), func(n *protocol.Task) { n.State = protocol.TaskStateWorking }), rulesTask("c", "a"), rulesTask("d", "b", "c")}, func(graph *protocol.TaskGraph) { graph.Parallel = 1 })
	testkit.Eq(t, startable(bWorking), []protocol.Task{})
	skipped := rulesGraph([]protocol.Task{rulesWith(rulesTask("a"), func(n *protocol.Task) { n.State = protocol.TaskStateSkipped }), rulesTask("b", "a")})
	testkit.Eq(t, rulesIDs(protocol.ReadyTasks(skipped)), []string{"b"})
	paused := aDone
	paused.State = protocol.GraphStatePaused
	testkit.Eq(t, protocol.ReadyTasks(paused), []protocol.Task{})
}

func TestParseTask(t *testing.T) {
	report := strings.Join([]string{
		"先读了代码。",
		"```json\n{\"tasks\": []}\n```",
		"改一下：",
		"```json\n{\"title\": \"两步\", \"tasks\": [{\"id\": \"a\", \"brief\": \"做 a\"}, {\"id\": \"b\", \"title\": \"第二步\", \"brief\": \"做 b\", \"needs\": [\"a\"], \"check\": \"pnpm test\"}]}\n```",
		"结论：两步。",
	}, "\n\n")
	parsed := parseSplit(report)
	if !parsed.OK {
		t.Fatal(parsed.Problems)
	}
	testkit.Eq(t, *parsed.Title, "两步")
	b := rulesWith(rulesTask("b", "a"), func(n *protocol.Task) { n.Title = "第二步"; n.Check = ptr.To("pnpm test") })
	testkit.Eq(t, parsed.Tasks, []protocol.Task{rulesTask("a"), b})

	none := parseSplit("我觉得分三步就行。")
	if none.OK {
		t.Fatal("none")
	}
	testkit.Match(t, strings.Join(none.Problems, ","), `json 代码块`)
	broken := parseSplit("```json\n{\"tasks\": [\n```")
	if broken.OK {
		t.Fatal("broken")
	}
	testkit.Match(t, strings.Join(broken.Problems, ","), `json 读不了`)
	circle := parseSplit("```json\n{\"tasks\": [{\"id\": \"a\", \"brief\": \"x\", \"needs\": [\"b\"]}, {\"id\": \"b\", \"brief\": \"y\", \"needs\": [\"a\"]}]}\n```")
	if circle.OK {
		t.Fatal("circle")
	}
	testkit.Match(t, strings.Join(circle.Problems, ","), `圈`)
	// The schema allows a missing field, never a null one.
	testkit.Match(t, strings.Join(parseSplit("```json\n{\"title\": null, \"tasks\": [{\"id\": \"a\", \"brief\": \"x\"}]}\n```").Problems, ","), `计划的格式不对`)
}

func TestEditNode(t *testing.T) {
	draft := rulesGraph(rulesDiamond(), rulesState(protocol.GraphStateDraft))
	edited := editTask(draft, "b", protocol.TaskEdit{Brief: ptr.To("换个做法"), Agent: ptr.To("lab"), Check: ptr.To("pnpm test")})
	if !edited.OK {
		t.Fatal(edited.Problem)
	}
	b := rulesWith(rulesTask("b", "a"), func(n *protocol.Task) { n.Brief = "换个做法" })
	testkit.Eq(t, edited.TaskGraph.Tasks[1], rulesWith(b, func(n *protocol.Task) { n.Agent = ptr.To("lab"); n.Check = ptr.To("pnpm test") }))
	cleared := editTask(edited.TaskGraph, "b", protocol.TaskEdit{Agent: ptr.To(""), Check: ptr.To("")})
	if !cleared.OK {
		t.Fatal(cleared.Problem)
	}
	testkit.Eq(t, cleared.TaskGraph.Tasks[1], b)
	added := editTask(draft, "docs", protocol.TaskEdit{Brief: ptr.To("补文档"), Needs: []string{"d"}})
	if !added.OK {
		t.Fatal(added.Problem)
	}
	testkit.Eq(t, added.TaskGraph.Tasks[len(added.TaskGraph.Tasks)-1].ID, "docs")
	testkit.Eq(t, len(draft.Tasks), 4)
	circle := editTask(draft, "a", protocol.TaskEdit{Needs: []string{"d"}})
	if circle.OK {
		t.Fatal("circle")
	}
	testkit.Match(t, circle.Problem, `圈`)
	removed := removeTask(draft, "c")
	if !removed.OK {
		t.Fatal(removed.Problem)
	}
	testkit.Eq(t, protocol.TaskOf(removed.TaskGraph, "d").Needs, []string{"b"})

	running := rulesGraph(append([]protocol.Task{rulesWith(rulesTask("a"), func(n *protocol.Task) { n.State = protocol.TaskStateWorking; n.Session = ptr.To("w1") })}, rulesDiamond()[1:]...))
	busy := editTask(running, "a", protocol.TaskEdit{Brief: ptr.To("别的")})
	if busy.OK {
		t.Fatal("busy")
	}
	testkit.Match(t, busy.Problem, `在做，不能改了`)
	if !editTask(running, "d", protocol.TaskEdit{Brief: ptr.To("别的")}).OK {
		t.Fatal("d")
	}
	ripe := running
	ripe.State = protocol.GraphStateRipe
	if editTask(ripe, "e", protocol.TaskEdit{Brief: ptr.To("再加一步")}).OK {
		t.Fatal("ripe")
	}
}

func TestNodeTask(t *testing.T) {
	graph := rulesGraph([]protocol.Task{
		rulesWith(rulesTask("a"), func(n *protocol.Task) {
			n.State = protocol.TaskStateMerged
			n.Conclusion = ptr.To("表建好了")
			n.Commits = []string{"abc1234"}
		}),
		rulesWith(rulesTask("b"), func(n *protocol.Task) { n.State = protocol.TaskStateSkipped }),
		rulesWith(rulesTask("c", "a", "b"), func(n *protocol.Task) { n.Scope = []string{"src/api"}; n.Check = ptr.To("pnpm test") }),
	})
	task := taskBrief(graph, graph.Tasks[2])
	testkit.Match(t, task, `种植计划「菱形」里的一步：c（步骤 c，第 3/3 步）`)
	testkit.Match(t, task, `整个计划要做的：做一个菱形`)
	testkit.Match(t, task, `- a（abc1234）：表建好了`)
	testkit.Match(t, task, `- b：跳过了，没有做`)
	testkit.Match(t, task, `只改这些地方：src/api`)
	testkit.Match(t, task, "`pnpm test`")
}
