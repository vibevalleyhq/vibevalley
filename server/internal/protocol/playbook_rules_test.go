package protocol

import (
	"fmt"
	"slices"
	"strings"
	"testing"

	"vibevalley/internal/testkit"
	"vibevalley/pkg/x/ptr"
)

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

func TestPlanProblems(t *testing.T) {
	testkit.Eq(t, PlanProblems(rulesDiamond()), []string{})
	testkit.Eq(t, PlanProblems(nil), []string{"计划里一步都没有"})
	join := func(nodes ...PlaybookNode) string { return strings.Join(PlanProblems(nodes), ",") }
	testkit.Match(t, join(rulesNode("a"), rulesNode("a")), `重复`)
	testkit.Match(t, join(rulesNode("第一步")), `不能当步骤 id`)
	testkit.Match(t, join(rulesNode("a", "zz")), `「a」要等的「zz」不存在`)
	testkit.Match(t, join(rulesNode("a", "a")), `不能等自己`)
	testkit.Match(t, join(rulesNode("a", "b"), rulesNode("b", "a"), rulesNode("c")), `成了一个圈：a、b`)
	many := []PlaybookNode{}
	for i := range MaxNodes + 1 {
		many = append(many, rulesNode("s"+string(rune('a'+i))))
	}
	testkit.Match(t, join(many...), `最多 12 步`)
	testkit.Match(t, join(rulesWith(rulesNode("a"), func(n *PlaybookNode) { n.Task = " " })), `没有工单`)
	// JavaScript's trim takes U+FEFF and leaves U+0085; and a step id is ASCII, case folding or not.
	testkit.Match(t, join(rulesWith(rulesNode("a"), func(n *PlaybookNode) { n.Task = "\ufeff" })), `没有工单`)
	testkit.Eq(t, PlanProblems([]PlaybookNode{rulesWith(rulesNode("a"), func(n *PlaybookNode) { n.Task = "\u0085" })}), []string{})
	testkit.Match(t, join(rulesNode("ſ")), `不能当步骤 id`)
}

func TestLayersOf(t *testing.T) {
	testkit.Eq(t, LayersOf(rulesDiamond()), [][]string{{"a"}, {"b", "c"}, {"d"}})
	testkit.Eq(t, LayersOf([]PlaybookNode{rulesNode("x"), rulesNode("y", "x"), rulesNode("z", "x", "y")}), [][]string{{"x"}, {"y"}, {"z"}})
	testkit.Eq(t, LayersOf(nil), [][]string{})
}

func TestPlaybookAsIssues(t *testing.T) {
	pb := rulesPlaybook(rulesDiamond(), func(pb *Playbook) {
		pb.Branch, pb.Note = ptr.To("vibevalley/pb-p1"), ptr.To("在做")
		pb.Nodes[0].State, pb.Nodes[0].Commits = NodeStateMerged, []string{"abc1234"}
		pb.Nodes[1].State, pb.Nodes[1].Session, pb.Nodes[1].Tries = NodeStateWorking, ptr.To("w2"), 1
	})
	issues := PlaybookIssues(pb, nil, 50)
	ids := []string{}
	for _, x := range issues {
		ids = append(ids, x.ID)
	}
	testkit.Eq(t, ids, []string{"p1", "p1.a", "p1.b", "p1.c", "p1.d"})
	testkit.Eq(t, issues[0].Plan.State, PlaybookStateRunning)
	testkit.Eq(t, issues[4].BlockedBy, []string{"p1.b", "p1.c"})
	testkit.Eq(t, *issues[1].Closed, IssueCloseMergedIntoPlan)
	testkit.Eq(t, *issues[1].ClosedAt, int64(50))
	testkit.Eq(t, issues[2].ClosedAt, (*int64)(nil))
	state := withPlaybooks(EmptyCoreState(), pb)
	read := pb
	read.Nodes = slices.Clone(pb.Nodes)
	read.Nodes[3].BlockedBy = []string{"b", "c"}
	read.Layers, read.Settled = [][]string{{"a"}, {"b", "c"}, {"d"}}, 1
	testkit.Eq(t, *PlaybookOf(state, "p1"), read, "read back, with what follows from it")
	testkit.Eq(t, PlaybooksOf(state), []Playbook{read})
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
	again := PlaybookIssues(pb, before, 90)
	testkit.Eq(t, again[2].Sessions, []string{"w2"})
	testkit.Eq(t, *again[1].ClosedAt, int64(50))
	gone := pb
	gone.State = PlaybookStateAbandoned
	for _, x := range PlaybookIssues(gone, nil, 7) {
		if x.ClosedAt == nil {
			t.Fatalf("%s open", x.ID)
		}
	}
}

func TestClosedPlaybooksGoWithTheirSteps(t *testing.T) {
	state := withPlaybooks(EmptyCoreState(), rulesPlaybook(rulesDiamond(), rulesState(PlaybookStateDone)))
	for i := range KeepClosedIssues {
		at := int64(100 + i)
		state, _ = Reduce(state, Fact{FactIssue{Issue: Issue{ID: fmt.Sprintf("c%d", i), Title: "关了", CreatedAt: at, Sessions: []string{}, ClosedAt: &at}}})
	}
	testkit.Eq(t, PlaybookOf(state, "p1"), (*Playbook)(nil))
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
	testkit.Eq(t, PlaybookChanges(nil, planning), []PlaybookChange{{Playbook: "p1", Kind: PlaybookEventKindPlanning, Detail: ptr.To("做一个菱形")}})
	draft := rulesPlaybook(rulesDiamond(), rulesState(PlaybookStateDraft))
	testkit.Eq(t, kinds(&planning, draft), []string{"drafted"})
	edited := rulesPlaybook(append(append([]PlaybookNode{node("a", func(n *PlaybookNode) { n.Task = "换个做法"; n.Check = ptr.To("pnpm test") })}, rulesDiamond()[1:3]...), rulesNode("e", "a")), rulesState(PlaybookStateDraft))
	testkit.Eq(t, kinds(&draft, edited), []string{"a:node_edited", "e:node_added", "d:node_removed"})
	testkit.Eq(t, PlaybookChanges(&draft, edited)[0].Changes, []NodeFieldChange{{Field: "工单", From: "做 a", To: "换个做法"}, {Field: "检查", From: "", To: "pnpm test"}})

	rest := rulesDiamond()[1:]
	with := func(a PlaybookNode, change ...func(*Playbook)) Playbook {
		return rulesPlaybook(append([]PlaybookNode{a}, rest...), change...)
	}
	running := rulesPlaybook(rulesDiamond(), func(pb *Playbook) { pb.Branch = ptr.To("vibevalley/pb-p1") })
	testkit.Eq(t, PlaybookChanges(&draft, running), []PlaybookChange{{Playbook: "p1", Kind: PlaybookEventKindStarted, Detail: ptr.To("vibevalley/pb-p1")}})
	aWorking := with(node("a", func(n *PlaybookNode) { n.State = NodeStateWorking; n.Session = ptr.To("w3") }))
	testkit.Eq(t, PlaybookChanges(&running, aWorking), []PlaybookChange{{Playbook: "p1", Node: ptr.To("a"), Kind: PlaybookEventKindNodeStarted, Session: ptr.To("w3")}})
	sentBack := with(node("a", func(n *PlaybookNode) { n.State = NodeStateWorking; n.Session = ptr.To("w3"); n.Tries = 1 }))
	testkit.Eq(t, kinds(&aWorking, sentBack), []string{"a:node_sent_back"})
	merged := with(node("a", func(n *PlaybookNode) {
		n.State = NodeStateMerged
		n.Conclusion = ptr.To("写好了")
		n.Commits = []string{"3f2a1bc"}
	}))
	testkit.Eq(t, PlaybookChanges(&sentBack, merged), []PlaybookChange{{Playbook: "p1", Node: ptr.To("a"), Kind: PlaybookEventKindNodeMerged, Session: ptr.To("w3"), Detail: ptr.To("写好了"), Commits: []string{"3f2a1bc"}}})
	failed := with(node("a", func(n *PlaybookNode) {
		n.State = NodeStateFailed
		n.Session = ptr.To("w3")
		n.Conclusion = ptr.To("测试没过")
	}))
	testkit.Eq(t, kinds(&aWorking, failed), []string{"a:node_failed"})
	testkit.Eq(t, kinds(&failed, aWorking), []string{"a:node_retried"})
	testkit.Eq(t, kinds(&failed, running), []string{"a:node_retried"})
	testkit.Eq(t, kinds(&aWorking, running), []string{"a:node_requeued"})
	testkit.Eq(t, kinds(&failed, with(node("a", func(n *PlaybookNode) { n.State = NodeStateSkipped }))), []string{"a:node_skipped"})

	change := func(pb Playbook, c func(*Playbook)) Playbook {
		c(&pb)
		return pb
	}
	testkit.Eq(t, kinds(&running, change(running, func(pb *Playbook) { pb.Note = ptr.To("「a」先等着：地满了") })), []string{"noted"})
	testkit.Eq(t, kinds(&running, change(running, func(pb *Playbook) { pb.State = PlaybookStatePaused; pb.Note = ptr.To("暂停了") })), []string{"paused"})
	paused := change(running, rulesState(PlaybookStatePaused))
	testkit.Eq(t, kinds(&paused, running), []string{"resumed"})
	testkit.Eq(t, kinds(&running, change(running, rulesState(PlaybookStateRipe))), []string{"ripe"})
	ripe := change(running, rulesState(PlaybookStateRipe))
	testkit.Eq(t, kinds(&ripe, change(running, rulesState(PlaybookStateDone))), []string{"merged"})
	testkit.Eq(t, kinds(&aWorking, change(running, func(pb *Playbook) { pb.State = PlaybookStateAbandoned; pb.Note = ptr.To("放弃了") })), []string{"abandoned"})
	testkit.Eq(t, kinds(&running, running), []string{})
}

func TestPlaybookEventText(t *testing.T) {
	titleOf := func(id string) string {
		if id == "a" {
			return "数据层"
		}
		return id
	}
	testkit.Eq(t, PlaybookEventText(PlaybookChange{Kind: PlaybookEventKindNodeMerged, Node: ptr.To("a"), Commits: []string{"3f2a1bc"}, Detail: ptr.To("写好了")}, titleOf), "「数据层」合进了计划分支（3f2a1bc）：写好了")
	testkit.Eq(t, PlaybookEventText(PlaybookChange{Kind: PlaybookEventKindNodeEdited, Node: ptr.To("a"), Changes: []NodeFieldChange{{Field: "工单", From: "x", To: "y"}}}, titleOf), "改了「数据层」的工单")
	testkit.Eq(t, PlaybookEventText(PlaybookChange{Kind: PlaybookEventKindNodeRemoved, Node: ptr.To("zz"), Detail: ptr.To("旧的一步")}, nil), "删了一步「旧的一步」")
	testkit.Eq(t, PlaybookEventText(PlaybookChange{Kind: PlaybookEventKindStarted, Detail: ptr.To("vibevalley/pb-p1")}, nil), "开工了，分支 vibevalley/pb-p1")
}
