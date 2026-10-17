package playbook

import (
	"strings"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/pkg/x/ptr"
)

func rulesNode(id string, needs ...string) protocol.PlaybookNode {
	if needs == nil {
		needs = []string{}
	}
	return protocol.PlaybookNode{ID: id, Title: id, Task: "做 " + id, Needs: needs, State: protocol.NodeStateWaiting, Tries: 0}
}

func rulesDiamond() []protocol.PlaybookNode {
	return []protocol.PlaybookNode{rulesNode("a"), rulesNode("b", "a"), rulesNode("c", "a"), rulesNode("d", "b", "c")}
}

func rulesPlaybook(nodes []protocol.PlaybookNode, change ...func(*protocol.Playbook)) protocol.Playbook {
	pb := protocol.Playbook{ID: "p1", Title: "菱形", Goal: "做一个菱形", Project: "diamond", State: protocol.PlaybookStateRunning, Nodes: nodes, Parallel: 3, CreatedAt: 0}
	for _, c := range change {
		c(&pb)
	}
	return pb
}

func rulesState(s protocol.PlaybookState) func(*protocol.Playbook) {
	return func(pb *protocol.Playbook) { pb.State = s }
}

func rulesWith(n protocol.PlaybookNode, change func(*protocol.PlaybookNode)) protocol.PlaybookNode {
	change(&n)
	return n
}

func rulesIDs(nodes []protocol.PlaybookNode) []string {
	out := []string{}
	for _, n := range nodes {
		out = append(out, n.ID)
	}
	return out
}

func TestReadyAndStartable(t *testing.T) {
	testkit.Eq(t, rulesIDs(protocol.ReadyNodes(rulesPlaybook(rulesDiamond()))), []string{"a"})
	merged := func(n *protocol.PlaybookNode) { n.State = protocol.NodeStateMerged }
	aDone := rulesPlaybook(append([]protocol.PlaybookNode{rulesWith(rulesNode("a"), merged)}, rulesDiamond()[1:]...))
	testkit.Eq(t, rulesIDs(protocol.ReadyNodes(aDone)), []string{"b", "c"})
	one := aDone
	one.Parallel = 1
	testkit.Eq(t, rulesIDs(startable(one)), []string{"b"})
	bWorking := rulesPlaybook([]protocol.PlaybookNode{rulesWith(rulesNode("a"), merged), rulesWith(rulesNode("b", "a"), func(n *protocol.PlaybookNode) { n.State = protocol.NodeStateWorking }), rulesNode("c", "a"), rulesNode("d", "b", "c")}, func(pb *protocol.Playbook) { pb.Parallel = 1 })
	testkit.Eq(t, startable(bWorking), []protocol.PlaybookNode{})
	skipped := rulesPlaybook([]protocol.PlaybookNode{rulesWith(rulesNode("a"), func(n *protocol.PlaybookNode) { n.State = protocol.NodeStateSkipped }), rulesNode("b", "a")})
	testkit.Eq(t, rulesIDs(protocol.ReadyNodes(skipped)), []string{"b"})
	paused := aDone
	paused.State = protocol.PlaybookStatePaused
	testkit.Eq(t, protocol.ReadyNodes(paused), []protocol.PlaybookNode{})
}

func TestParsePlan(t *testing.T) {
	report := strings.Join([]string{
		"先读了代码。",
		"```json\n{\"nodes\": []}\n```",
		"改一下：",
		"```json\n{\"title\": \"两步\", \"nodes\": [{\"id\": \"a\", \"task\": \"做 a\"}, {\"id\": \"b\", \"title\": \"第二步\", \"task\": \"做 b\", \"needs\": [\"a\"], \"check\": \"pnpm test\"}]}\n```",
		"结论：两步。",
	}, "\n\n")
	parsed := parsePlan(report)
	if !parsed.OK {
		t.Fatal(parsed.Problems)
	}
	testkit.Eq(t, *parsed.Title, "两步")
	b := rulesWith(rulesNode("b", "a"), func(n *protocol.PlaybookNode) { n.Title = "第二步"; n.Check = ptr.To("pnpm test") })
	testkit.Eq(t, parsed.Nodes, []protocol.PlaybookNode{rulesNode("a"), b})

	none := parsePlan("我觉得分三步就行。")
	if none.OK {
		t.Fatal("none")
	}
	testkit.Match(t, strings.Join(none.Problems, ","), `json 代码块`)
	broken := parsePlan("```json\n{\"nodes\": [\n```")
	if broken.OK {
		t.Fatal("broken")
	}
	testkit.Match(t, strings.Join(broken.Problems, ","), `json 读不了`)
	circle := parsePlan("```json\n{\"nodes\": [{\"id\": \"a\", \"task\": \"x\", \"needs\": [\"b\"]}, {\"id\": \"b\", \"task\": \"y\", \"needs\": [\"a\"]}]}\n```")
	if circle.OK {
		t.Fatal("circle")
	}
	testkit.Match(t, strings.Join(circle.Problems, ","), `圈`)
	// The schema allows a missing field, never a null one.
	testkit.Match(t, strings.Join(parsePlan("```json\n{\"title\": null, \"nodes\": [{\"id\": \"a\", \"task\": \"x\"}]}\n```").Problems, ","), `计划的格式不对`)
}

func TestEditNode(t *testing.T) {
	draft := rulesPlaybook(rulesDiamond(), rulesState(protocol.PlaybookStateDraft))
	edited := editNode(draft, "b", protocol.NodeEdit{Task: ptr.To("换个做法"), Agent: ptr.To("lab"), Check: ptr.To("pnpm test")})
	if !edited.OK {
		t.Fatal(edited.Problem)
	}
	b := rulesWith(rulesNode("b", "a"), func(n *protocol.PlaybookNode) { n.Task = "换个做法" })
	testkit.Eq(t, edited.Playbook.Nodes[1], rulesWith(b, func(n *protocol.PlaybookNode) { n.Agent = ptr.To("lab"); n.Check = ptr.To("pnpm test") }))
	cleared := editNode(edited.Playbook, "b", protocol.NodeEdit{Agent: ptr.To(""), Check: ptr.To("")})
	if !cleared.OK {
		t.Fatal(cleared.Problem)
	}
	testkit.Eq(t, cleared.Playbook.Nodes[1], b)
	added := editNode(draft, "docs", protocol.NodeEdit{Task: ptr.To("补文档"), Needs: []string{"d"}})
	if !added.OK {
		t.Fatal(added.Problem)
	}
	testkit.Eq(t, added.Playbook.Nodes[len(added.Playbook.Nodes)-1].ID, "docs")
	testkit.Eq(t, len(draft.Nodes), 4)
	circle := editNode(draft, "a", protocol.NodeEdit{Needs: []string{"d"}})
	if circle.OK {
		t.Fatal("circle")
	}
	testkit.Match(t, circle.Problem, `圈`)
	removed := removeNode(draft, "c")
	if !removed.OK {
		t.Fatal(removed.Problem)
	}
	testkit.Eq(t, protocol.NodeOf(removed.Playbook, "d").Needs, []string{"b"})

	running := rulesPlaybook(append([]protocol.PlaybookNode{rulesWith(rulesNode("a"), func(n *protocol.PlaybookNode) { n.State = protocol.NodeStateWorking; n.Worker = ptr.To("w1") })}, rulesDiamond()[1:]...))
	busy := editNode(running, "a", protocol.NodeEdit{Task: ptr.To("别的")})
	if busy.OK {
		t.Fatal("busy")
	}
	testkit.Match(t, busy.Problem, `在做，不能改了`)
	if !editNode(running, "d", protocol.NodeEdit{Task: ptr.To("别的")}).OK {
		t.Fatal("d")
	}
	ripe := running
	ripe.State = protocol.PlaybookStateRipe
	if editNode(ripe, "e", protocol.NodeEdit{Task: ptr.To("再加一步")}).OK {
		t.Fatal("ripe")
	}
}

func TestNodeTask(t *testing.T) {
	pb := rulesPlaybook([]protocol.PlaybookNode{
		rulesWith(rulesNode("a"), func(n *protocol.PlaybookNode) {
			n.State = protocol.NodeStateMerged
			n.Conclusion = ptr.To("表建好了")
			n.Commits = []string{"abc1234"}
		}),
		rulesWith(rulesNode("b"), func(n *protocol.PlaybookNode) { n.State = protocol.NodeStateSkipped }),
		rulesWith(rulesNode("c", "a", "b"), func(n *protocol.PlaybookNode) { n.Scope = []string{"src/api"}; n.Check = ptr.To("pnpm test") }),
	})
	task := nodeTask(pb, pb.Nodes[2])
	testkit.Match(t, task, `种植计划「菱形」里的一步：c（步骤 c，第 3/3 步）`)
	testkit.Match(t, task, `整个计划要做的：做一个菱形`)
	testkit.Match(t, task, `- a（abc1234）：表建好了`)
	testkit.Match(t, task, `- b：跳过了，没有做`)
	testkit.Match(t, task, `只改这些地方：src/api`)
	testkit.Match(t, task, "`pnpm test`")
}
