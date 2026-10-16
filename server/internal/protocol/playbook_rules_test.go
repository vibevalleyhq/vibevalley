package protocol

// The playbook rules (playbook.go), as the removed TypeScript server's playbook-rules.test.ts tested the TypeScript ones.

import (
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"
)

func rulesPtr[T any](v T) *T { return &v }

func rulesNode(id string, needs ...string) PlaybookNode {
	if needs == nil {
		needs = []string{}
	}
	return PlaybookNode{ID: id, Title: id, Task: "做 " + id, Needs: needs, State: NodeStateWaiting, Tries: 0}
}

func rulesDiamond() []PlaybookNode {
	return []PlaybookNode{rulesNode("a"), rulesNode("b", "a"), rulesNode("c", "a"), rulesNode("d", "b", "c")}
}

func rulesPlaybook(nodes []PlaybookNode, change ...func(*Playbook)) Playbook {
	pb := Playbook{ID: "p1", Title: "菱形", Goal: "做一个菱形", Project: "diamond", State: PlaybookStateRunning, Nodes: nodes, Parallel: 3, CreatedAt: 0}
	for _, c := range change {
		c(&pb)
	}
	return pb
}

func rulesState(s PlaybookState) func(*Playbook) { return func(pb *Playbook) { pb.State = s } }

func rulesWith(n PlaybookNode, change func(*PlaybookNode)) PlaybookNode {
	change(&n)
	return n
}

func rulesIDs(nodes []PlaybookNode) []string {
	out := []string{}
	for _, n := range nodes {
		out = append(out, n.ID)
	}
	return out
}

func rulesMatch(t *testing.T, text, pattern string) {
	t.Helper()
	if !regexp.MustCompile(pattern).MatchString(text) {
		t.Fatalf("%q does not match %s", text, pattern)
	}
}

func rulesEqual(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		g, _ := json.Marshal(got)
		w, _ := json.Marshal(want)
		t.Fatalf("\n got %s\nwant %s", g, w)
	}
}

func TestPlanProblems(t *testing.T) {
	rulesEqual(t, PlanProblems(rulesDiamond()), []string{})
	rulesEqual(t, PlanProblems(nil), []string{"计划里一步都没有"})
	join := func(nodes ...PlaybookNode) string { return strings.Join(PlanProblems(nodes), ",") }
	rulesMatch(t, join(rulesNode("a"), rulesNode("a")), `重复`)
	rulesMatch(t, join(rulesNode("第一步")), `不能当步骤 id`)
	rulesMatch(t, join(rulesNode("a", "zz")), `「a」要等的「zz」不存在`)
	rulesMatch(t, join(rulesNode("a", "a")), `不能等自己`)
	rulesMatch(t, join(rulesNode("a", "b"), rulesNode("b", "a"), rulesNode("c")), `成了一个圈：a、b`)
	many := []PlaybookNode{}
	for i := range MaxNodes + 1 {
		many = append(many, rulesNode("s"+string(rune('a'+i))))
	}
	rulesMatch(t, join(many...), `最多 12 步`)
	rulesMatch(t, join(rulesWith(rulesNode("a"), func(n *PlaybookNode) { n.Task = " " })), `没有工单`)
	// JavaScript's trim takes U+FEFF and leaves U+0085; and a step id is ASCII, case folding or not.
	rulesMatch(t, join(rulesWith(rulesNode("a"), func(n *PlaybookNode) { n.Task = "\ufeff" })), `没有工单`)
	rulesEqual(t, PlanProblems([]PlaybookNode{rulesWith(rulesNode("a"), func(n *PlaybookNode) { n.Task = "\u0085" })}), []string{})
	rulesMatch(t, join(rulesNode("ſ")), `不能当步骤 id`)
}

func TestLayersOf(t *testing.T) {
	rulesEqual(t, LayersOf(rulesDiamond()), [][]string{{"a"}, {"b", "c"}, {"d"}})
	rulesEqual(t, LayersOf([]PlaybookNode{rulesNode("x"), rulesNode("y", "x"), rulesNode("z", "x", "y")}), [][]string{{"x"}, {"y"}, {"z"}})
	rulesEqual(t, LayersOf(nil), [][]string{})
}

func TestReadyAndStartable(t *testing.T) {
	rulesEqual(t, rulesIDs(ReadyNodes(rulesPlaybook(rulesDiamond()))), []string{"a"})
	merged := func(n *PlaybookNode) { n.State = NodeStateMerged }
	aDone := rulesPlaybook(append([]PlaybookNode{rulesWith(rulesNode("a"), merged)}, rulesDiamond()[1:]...))
	rulesEqual(t, rulesIDs(ReadyNodes(aDone)), []string{"b", "c"})
	one := aDone
	one.Parallel = 1
	rulesEqual(t, rulesIDs(Startable(one)), []string{"b"})
	bWorking := rulesPlaybook([]PlaybookNode{rulesWith(rulesNode("a"), merged), rulesWith(rulesNode("b", "a"), func(n *PlaybookNode) { n.State = NodeStateWorking }), rulesNode("c", "a"), rulesNode("d", "b", "c")}, func(pb *Playbook) { pb.Parallel = 1 })
	rulesEqual(t, Startable(bWorking), []PlaybookNode{})
	skipped := rulesPlaybook([]PlaybookNode{rulesWith(rulesNode("a"), func(n *PlaybookNode) { n.State = NodeStateSkipped }), rulesNode("b", "a")})
	rulesEqual(t, rulesIDs(ReadyNodes(skipped)), []string{"b"})
	paused := aDone
	paused.State = PlaybookStatePaused
	rulesEqual(t, ReadyNodes(paused), []PlaybookNode{})
}

func TestParsePlan(t *testing.T) {
	report := strings.Join([]string{
		"先读了代码。",
		"```json\n{\"nodes\": []}\n```",
		"改一下：",
		"```json\n{\"title\": \"两步\", \"nodes\": [{\"id\": \"a\", \"task\": \"做 a\"}, {\"id\": \"b\", \"title\": \"第二步\", \"task\": \"做 b\", \"needs\": [\"a\"], \"check\": \"pnpm test\"}]}\n```",
		"结论：两步。",
	}, "\n\n")
	parsed := ParsePlan(report)
	if !parsed.OK {
		t.Fatal(parsed.Problems)
	}
	rulesEqual(t, *parsed.Title, "两步")
	b := rulesWith(rulesNode("b", "a"), func(n *PlaybookNode) { n.Title = "第二步"; n.Check = rulesPtr("pnpm test") })
	rulesEqual(t, parsed.Nodes, []PlaybookNode{rulesNode("a"), b})

	none := ParsePlan("我觉得分三步就行。")
	if none.OK {
		t.Fatal("none")
	}
	rulesMatch(t, strings.Join(none.Problems, ","), `json 代码块`)
	broken := ParsePlan("```json\n{\"nodes\": [\n```")
	if broken.OK {
		t.Fatal("broken")
	}
	rulesMatch(t, strings.Join(broken.Problems, ","), `json 读不了`)
	circle := ParsePlan("```json\n{\"nodes\": [{\"id\": \"a\", \"task\": \"x\", \"needs\": [\"b\"]}, {\"id\": \"b\", \"task\": \"y\", \"needs\": [\"a\"]}]}\n```")
	if circle.OK {
		t.Fatal("circle")
	}
	rulesMatch(t, strings.Join(circle.Problems, ","), `圈`)
	// The schema allows a missing field, never a null one.
	rulesMatch(t, strings.Join(ParsePlan("```json\n{\"title\": null, \"nodes\": [{\"id\": \"a\", \"task\": \"x\"}]}\n```").Problems, ","), `计划的格式不对`)
}

func TestEditNode(t *testing.T) {
	draft := rulesPlaybook(rulesDiamond(), rulesState(PlaybookStateDraft))
	edited := EditNode(draft, "b", NodeEdit{Task: rulesPtr("换个做法"), Agent: rulesPtr("lab"), Check: rulesPtr("pnpm test")})
	if !edited.OK {
		t.Fatal(edited.Problem)
	}
	b := rulesWith(rulesNode("b", "a"), func(n *PlaybookNode) { n.Task = "换个做法" })
	rulesEqual(t, edited.Playbook.Nodes[1], rulesWith(b, func(n *PlaybookNode) { n.Agent = rulesPtr("lab"); n.Check = rulesPtr("pnpm test") }))
	// Empty means none again.
	cleared := EditNode(edited.Playbook, "b", NodeEdit{Agent: rulesPtr(""), Check: rulesPtr("")})
	if !cleared.OK {
		t.Fatal(cleared.Problem)
	}
	rulesEqual(t, cleared.Playbook.Nodes[1], b)
	// A new step, and one that would make a circle.
	added := EditNode(draft, "docs", NodeEdit{Task: rulesPtr("补文档"), Needs: []string{"d"}})
	if !added.OK {
		t.Fatal(added.Problem)
	}
	rulesEqual(t, added.Playbook.Nodes[len(added.Playbook.Nodes)-1].ID, "docs")
	rulesEqual(t, len(draft.Nodes), 4)
	circle := EditNode(draft, "a", NodeEdit{Needs: []string{"d"}})
	if circle.OK {
		t.Fatal("circle")
	}
	rulesMatch(t, circle.Problem, `圈`)
	// Removing a step takes it out of what others wait for.
	removed := RemoveNode(draft, "c")
	if !removed.OK {
		t.Fatal(removed.Problem)
	}
	rulesEqual(t, NodeOf(removed.Playbook, "d").Needs, []string{"b"})

	running := rulesPlaybook(append([]PlaybookNode{rulesWith(rulesNode("a"), func(n *PlaybookNode) { n.State = NodeStateWorking; n.Helper = rulesPtr("w1") })}, rulesDiamond()[1:]...))
	busy := EditNode(running, "a", NodeEdit{Task: rulesPtr("别的")})
	if busy.OK {
		t.Fatal("busy")
	}
	rulesMatch(t, busy.Problem, `在做，不能改了`)
	if !EditNode(running, "d", NodeEdit{Task: rulesPtr("别的")}).OK {
		t.Fatal("d")
	}
	ripe := running
	ripe.State = PlaybookStateRipe
	if EditNode(ripe, "e", NodeEdit{Task: rulesPtr("再加一步")}).OK {
		t.Fatal("ripe")
	}
}

func TestNodeTask(t *testing.T) {
	pb := rulesPlaybook([]PlaybookNode{
		rulesWith(rulesNode("a"), func(n *PlaybookNode) {
			n.State = NodeStateMerged
			n.Conclusion = rulesPtr("表建好了")
			n.Commits = []string{"abc1234"}
		}),
		rulesWith(rulesNode("b"), func(n *PlaybookNode) { n.State = NodeStateSkipped }),
		rulesWith(rulesNode("c", "a", "b"), func(n *PlaybookNode) { n.Scope = []string{"src/api"}; n.Check = rulesPtr("pnpm test") }),
	})
	task := NodeTask(pb, pb.Nodes[2])
	rulesMatch(t, task, `种植计划「菱形」里的一步：c（步骤 c，第 3/3 步）`)
	rulesMatch(t, task, `整个计划要做的：做一个菱形`)
	rulesMatch(t, task, `- a（abc1234）：表建好了`)
	rulesMatch(t, task, `- b：跳过了，没有做`)
	rulesMatch(t, task, `只改这些地方：src/api`)
	rulesMatch(t, task, "`pnpm test`")
}

func TestPlaybookAsIssues(t *testing.T) {
	// A playbook and its issues: the parent, then a sub-issue a step, blocked by the steps it needs; and back.
	pb := rulesPlaybook(rulesDiamond(), func(pb *Playbook) {
		pb.Branch, pb.Note = rulesPtr("vibevalley/pb-p1"), rulesPtr("在做")
		pb.Nodes[0].State, pb.Nodes[0].Commits = NodeStateMerged, []string{"abc1234"}
		pb.Nodes[1].State, pb.Nodes[1].Helper, pb.Nodes[1].Tries = NodeStateWorking, rulesPtr("w2"), 1
	})
	issues := PlaybookIssues(pb, nil, 50)
	ids := []string{}
	for _, x := range issues {
		ids = append(ids, x.ID)
	}
	rulesEqual(t, ids, []string{"p1", "p1.a", "p1.b", "p1.c", "p1.d"})
	rulesEqual(t, issues[0].Plan.State, PlaybookStateRunning)
	rulesEqual(t, issues[4].BlockedBy, []string{"p1.b", "p1.c"})
	rulesEqual(t, *issues[1].Closed, IssueCloseMerged)
	rulesEqual(t, *issues[1].ClosedAt, int64(50))
	rulesEqual(t, issues[2].ClosedAt, (*int64)(nil))
	state := withPlaybooks(EmptyFarm(), pb)
	rulesEqual(t, *PlaybookOf(state, "p1"), pb)
	rulesEqual(t, PlaybooksOf(state), []Playbook{pb})
	// The statuses: the playbook at work; a step merged, one at work (its helper gone: waiting on you), two waiting their turn.
	statuses := []IssueStatus{}
	for _, id := range ids {
		statuses = append(statuses, issueIn(state, id).Status)
	}
	rulesEqual(t, statuses, []IssueStatus{IssueStatusWorking, IssueStatusClosed, IssueStatusWaiting, IssueStatusTodo, IssueStatusTodo})
	// What only the issues know stays; a step closed before keeps when it closed.
	before := slices.Clone(issues)
	for i := range before {
		if before[i].ID == "p1.b" {
			before[i].Runs = []string{"w2"}
		}
	}
	again := PlaybookIssues(pb, before, 90)
	rulesEqual(t, again[2].Runs, []string{"w2"})
	rulesEqual(t, *again[1].ClosedAt, int64(50))
	// Given up: every step closes with it.
	gone := pb
	gone.State = PlaybookStateAbandoned
	for _, x := range PlaybookIssues(gone, nil, 7) {
		if x.ClosedAt == nil {
			t.Fatalf("%s open", x.ID)
		}
	}
}

func TestClosedPlaybooksGoWithTheirSteps(t *testing.T) {
	state := withPlaybooks(EmptyFarm(), rulesPlaybook(rulesDiamond(), rulesState(PlaybookStateDone)))
	for i := range KeepClosedIssues {
		at := int64(100 + i)
		state, _ = Reduce(state, Fact{FactIssue{Issue: Issue{ID: fmt.Sprintf("c%d", i), Title: "关了", CreatedAt: at, Runs: []string{}, ClosedAt: &at}}})
	}
	rulesEqual(t, PlaybookOf(state, "p1"), (*Playbook)(nil))
	for _, x := range state.Issues {
		if x.Parent != nil {
			t.Fatalf("%s stayed without its parent", x.ID)
		}
	}
}

func TestPlaybookChanges(t *testing.T) {
	kinds := func(before *Playbook, after Playbook) []string {
		out := []string{}
		for _, c := range PlaybookChanges(before, after) {
			if c.Node != nil {
				out = append(out, *c.Node+":"+string(c.Kind))
			} else {
				out = append(out, string(c.Kind))
			}
		}
		return out
	}
	node := func(id string, change func(*PlaybookNode), needs ...string) PlaybookNode {
		return rulesWith(rulesNode(id, needs...), change)
	}
	planning := rulesPlaybook([]PlaybookNode{}, rulesState(PlaybookStatePlanning))
	rulesEqual(t, PlaybookChanges(nil, planning), []PlaybookChange{{Playbook: "p1", Kind: PlaybookEventKindPlanning, Detail: rulesPtr("做一个菱形")}})
	// A draft's steps come with it.
	draft := rulesPlaybook(rulesDiamond(), rulesState(PlaybookStateDraft))
	rulesEqual(t, kinds(&planning, draft), []string{"drafted"})
	// Looked over: a step changed, one added, one taken out; each field before and after.
	edited := rulesPlaybook(append(append([]PlaybookNode{node("a", func(n *PlaybookNode) { n.Task = "换个做法"; n.Check = rulesPtr("pnpm test") })}, rulesDiamond()[1:3]...), rulesNode("e", "a")), rulesState(PlaybookStateDraft))
	rulesEqual(t, kinds(&draft, edited), []string{"a:node_edited", "e:node_added", "d:node_removed"})
	rulesEqual(t, PlaybookChanges(&draft, edited)[0].Changes, []NodeFieldChange{{Field: "工单", From: "做 a", To: "换个做法"}, {Field: "检查", From: "", To: "pnpm test"}})

	rest := rulesDiamond()[1:]
	with := func(a PlaybookNode, change ...func(*Playbook)) Playbook {
		return rulesPlaybook(append([]PlaybookNode{a}, rest...), change...)
	}
	running := rulesPlaybook(rulesDiamond(), func(pb *Playbook) { pb.Branch = rulesPtr("vibevalley/pb-p1") })
	rulesEqual(t, PlaybookChanges(&draft, running), []PlaybookChange{{Playbook: "p1", Kind: PlaybookEventKindStarted, Detail: rulesPtr("vibevalley/pb-p1")}})
	aWorking := with(node("a", func(n *PlaybookNode) { n.State = NodeStateWorking; n.Helper = rulesPtr("w3") }))
	rulesEqual(t, PlaybookChanges(&running, aWorking), []PlaybookChange{{Playbook: "p1", Node: rulesPtr("a"), Kind: PlaybookEventKindNodeStarted, Helper: rulesPtr("w3")}})
	sentBack := with(node("a", func(n *PlaybookNode) { n.State = NodeStateWorking; n.Helper = rulesPtr("w3"); n.Tries = 1 }))
	rulesEqual(t, kinds(&aWorking, sentBack), []string{"a:node_sent_back"})
	merged := with(node("a", func(n *PlaybookNode) {
		n.State = NodeStateMerged
		n.Conclusion = rulesPtr("写好了")
		n.Commits = []string{"3f2a1bc"}
	}))
	rulesEqual(t, PlaybookChanges(&sentBack, merged), []PlaybookChange{{Playbook: "p1", Node: rulesPtr("a"), Kind: PlaybookEventKindNodeMerged, Helper: rulesPtr("w3"), Detail: rulesPtr("写好了"), Commits: []string{"3f2a1bc"}}})
	failed := with(node("a", func(n *PlaybookNode) {
		n.State = NodeStateFailed
		n.Helper = rulesPtr("w3")
		n.Conclusion = rulesPtr("测试没过")
	}))
	rulesEqual(t, kinds(&aWorking, failed), []string{"a:node_failed"})
	rulesEqual(t, kinds(&failed, aWorking), []string{"a:node_retried"})
	rulesEqual(t, kinds(&failed, running), []string{"a:node_retried"})
	rulesEqual(t, kinds(&aWorking, running), []string{"a:node_requeued"})
	rulesEqual(t, kinds(&failed, with(node("a", func(n *PlaybookNode) { n.State = NodeStateSkipped }))), []string{"a:node_skipped"})

	change := func(pb Playbook, c func(*Playbook)) Playbook {
		c(&pb)
		return pb
	}
	rulesEqual(t, kinds(&running, change(running, func(pb *Playbook) { pb.Note = rulesPtr("「a」先等着：地满了") })), []string{"noted"})
	rulesEqual(t, kinds(&running, change(running, func(pb *Playbook) { pb.State = PlaybookStatePaused; pb.Note = rulesPtr("暂停了") })), []string{"paused"})
	paused := change(running, rulesState(PlaybookStatePaused))
	rulesEqual(t, kinds(&paused, running), []string{"resumed"})
	rulesEqual(t, kinds(&running, change(running, rulesState(PlaybookStateRipe))), []string{"ripe"})
	ripe := change(running, rulesState(PlaybookStateRipe))
	rulesEqual(t, kinds(&ripe, change(running, rulesState(PlaybookStateDone))), []string{"harvested"})
	// An abandoned playbook's steps stop with it.
	rulesEqual(t, kinds(&aWorking, change(running, func(pb *Playbook) { pb.State = PlaybookStateAbandoned; pb.Note = rulesPtr("放弃了") })), []string{"abandoned"})
	rulesEqual(t, kinds(&running, running), []string{})
}

func TestPlaybookEventText(t *testing.T) {
	titleOf := func(id string) string {
		if id == "a" {
			return "数据层"
		}
		return id
	}
	rulesEqual(t, PlaybookEventText(PlaybookChange{Kind: PlaybookEventKindNodeMerged, Node: rulesPtr("a"), Commits: []string{"3f2a1bc"}, Detail: rulesPtr("写好了")}, titleOf), "「数据层」合进了计划分支（3f2a1bc）：写好了")
	rulesEqual(t, PlaybookEventText(PlaybookChange{Kind: PlaybookEventKindNodeEdited, Node: rulesPtr("a"), Changes: []NodeFieldChange{{Field: "工单", From: "x", To: "y"}}}, titleOf), "改了「数据层」的工单")
	rulesEqual(t, PlaybookEventText(PlaybookChange{Kind: PlaybookEventKindNodeRemoved, Node: rulesPtr("zz"), Detail: rulesPtr("旧的一步")}, nil), "删了一步「旧的一步」")
	rulesEqual(t, PlaybookEventText(PlaybookChange{Kind: PlaybookEventKindStarted, Detail: rulesPtr("vibevalley/pb-p1")}, nil), "开工了，分支 vibevalley/pb-p1")
}

func TestNextPlaybookIDReadsLikeNumber(t *testing.T) {
	ids := func(list ...string) []string { return list }
	rulesEqual(t, NextPlaybookID(ids()), "p1")
	rulesEqual(t, NextPlaybookID(ids("p3", "px", "p 7 ", "p-9")), "p8")
	rulesEqual(t, NextPlaybookID(ids("p0x10")), "p17")
	rulesEqual(t, NextPlaybookID(ids("p1.5")), "p2.5")
	rulesEqual(t, NextPlaybookID(ids("pInfinity")), "pInfinity")
	rulesEqual(t, NextPlaybookID(ids("p1e21")), "p1e+21")
	rulesEqual(t, NextPlaybookID(ids("pinf", "p1_0", "p0x1p4")), "p1")
}
