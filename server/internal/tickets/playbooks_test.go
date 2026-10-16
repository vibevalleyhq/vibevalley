package tickets

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"go.uber.org/fx"

	"vibevalley/internal/base"
	"vibevalley/internal/farmtest"
	"vibevalley/internal/game"
	"vibevalley/internal/protocol"
	"vibevalley/internal/runs"
)

// Playbooks (ported from the service's part of the TypeScript server's playbooks.test.ts, removed): a planner that answers with a plan, steps that
// finish, fail, fail their check or take their time; a diamond run with b and c at once; a restart. The crew and the
// projects are stand-ins: a turn is a script, a merge gives back a commit, a check passes once its step wrote its
// file. What the crew and git do themselves is theirs to test.

func planStep(id string, needs ...string) map[string]any {
	if needs == nil {
		needs = []string{}
	}
	return map[string]any{"id": id, "title": "步骤 " + id, "task": "写 steps/" + id + ".txt", "needs": needs, "agent": "lab", "check": "test -f steps/" + id + ".txt"}
}

// planPlans is the plan the scripted planner gives for each goal.
var planPlans = map[string]any{
	"菱形":   map[string]any{"title": "菱形", "nodes": []any{planStep("a"), planStep("b", "a"), planStep("c", "a"), planStep("d", "b", "c")}},
	"有坏步":  map[string]any{"title": "有坏步", "nodes": []any{func() map[string]any { s := planStep("boom"); delete(s, "check"); return s }(), planStep("flaky"), planStep("after", "boom")}},
	"先给个圈": map[string]any{"nodes": []any{planStep("x", "y"), planStep("y", "x")}},
	"慢":    map[string]any{"title": "慢", "nodes": []any{planStep("slow")}},
	"验收先行": map[string]any{"title": "验收先行", "nodes": []any{
		map[string]any{"id": "repro", "title": "复现", "task": "写一个现在会失败的测试", "needs": []string{}, "agent": "lab", "check": "test -f steps/fix.txt", "acceptance": true},
		map[string]any{"id": "fix", "title": "修", "task": "修好它", "needs": []string{"repro"}, "agent": "lab"},
	}},
}

// planFakeCrew runs helpers' turns as a script, through the same facts the crew applies.
type planFakeCrew struct {
	f *world

	mu       sync.Mutex
	n        int
	last     map[string]string
	attempts map[string]int
	written  map[string]bool
	started  map[string]bool
	// touched is the files each step's work changed, by step; told what each helper was told after its job.
	touched map[string][]string
	told    map[string][]string
	release chan struct{}
}

func newPlanFakeCrew(f *world, release chan struct{}) *planFakeCrew {
	return &planFakeCrew{f: f, last: map[string]string{}, attempts: map[string]int{}, written: map[string]bool{}, started: map[string]bool{}, touched: map[string][]string{}, told: map[string][]string{}, release: release}
}

var planGoal = regexp.MustCompile(`要做的事：(\S+)`)

// turn is one turn of a helper: what it said, and how it ended.
func (c *planFakeCrew) turn(h protocol.Helper, input string) (protocol.Outcome, string) {
	if h.Playbook == nil || h.Playbook.Node == nil {
		var plan any
		if strings.Contains(input, "计划有问题") {
			plan = map[string]any{"title": "改好了", "nodes": []any{planStep("fixed")}}
		} else if m := planGoal.FindStringSubmatch(input); m != nil {
			plan = planPlans[m[1]]
		}
		body, _ := json.MarshalIndent(plan, "", "  ")
		return protocol.OutcomeCompleted, "读完了。\n\n```json\n" + string(body) + "\n```\n\n结论：拆好了。"
	}
	id := *h.Playbook.Node
	c.mu.Lock()
	c.attempts[id]++
	n := c.attempts[id]
	c.started[id] = true
	c.mu.Unlock()
	switch {
	case id == "boom":
		return protocol.OutcomeFailed, "provider said no"
	case id == "slow" && n == 1:
		<-c.release
		return protocol.OutcomeInterrupted, ""
	case id == "b" || id == "c":
		// b and c wait (a few seconds at most) until both have started: run side by side, they always overlap.
		for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
			c.mu.Lock()
			both := c.started["b"] && c.started["c"]
			c.mu.Unlock()
			if both {
				break
			}
		}
	case id == "repro" && n == 1:
		// It fixes the bug along with the test: its acceptance passes already, and it is sent back.
		c.mu.Lock()
		c.written["fix"], c.touched[id] = true, []string{"steps/fix.txt", "steps/repro_test.txt"}
		c.mu.Unlock()
		return protocol.OutcomeCompleted, "结论：写了测试，顺手修好了"
	case id == "repro":
		c.mu.Lock()
		delete(c.written, "fix")
		c.touched[id] = []string{"steps/repro_test.txt"}
		c.mu.Unlock()
		return protocol.OutcomeCompleted, "结论：steps/repro_test.txt 现在会失败"
	case id == "fix" && n == 1:
		// It loosens the frozen test instead of fixing the code: sent back.
		c.mu.Lock()
		c.touched[id] = []string{"steps/repro_test.txt"}
		c.mu.Unlock()
		return protocol.OutcomeCompleted, "结论：把测试改松了"
	case id == "flaky" && n == 1:
		// It says it is done without writing anything: its check fails and it is sent back.
		return protocol.OutcomeCompleted, "结论：做完了"
	}
	c.mu.Lock()
	c.written[id] = true
	c.touched[id] = []string{"steps/" + id + ".txt"}
	c.mu.Unlock()
	return protocol.OutcomeCompleted, "结论：写好了 steps/" + id + ".txt"
}

func (c *planFakeCrew) run(id, input string) {
	h := c.f.Site.Helper(id)
	if h == nil {
		return
	}
	outcome, said := c.turn(*h, input)
	c.mu.Lock()
	c.last[id] = said
	c.mu.Unlock()
	summary := said
	if i := strings.LastIndex(said, "结论："); i >= 0 {
		summary = said[i+len("结论："):]
	}
	if outcome == protocol.OutcomeFailed {
		summary = said
	}
	c.f.Site.Apply(protocol.FactReport{ID: id, Outcome: outcome, Summary: summary, Turns: 1})
}

func (c *planFakeCrew) Hire(_ context.Context, agent protocol.AgentProfile, task, project string, opt base.HireOptions) base.Hired {
	c.mu.Lock()
	c.n++
	id := fmt.Sprintf("w%d", c.n)
	c.mu.Unlock()
	wt := "/wt/" + id
	h := protocol.Helper{
		ID: id, Name: "帮工" + id, Agent: agent.ID, Runtime: agent.Runtime, Task: task, Project: &project, Worktree: &wt,
		HiredAt: base.NowMs(), Phase: protocol.Phase{Value: protocol.PhaseWorking{Since: base.NowMs()}}, Playbook: opt.Playbook,
	}
	c.f.Site.Apply(protocol.FactHired{Helper: h})
	if opt.Issue != "" {
		if err := c.f.Issues.Ran(opt.Issue, h); err != nil {
			panic(err)
		}
	}
	go c.run(id, task)
	return base.Hired{Helper: &h}
}

func (c *planFakeCrew) Tell(id, text string) string {
	c.mu.Lock()
	c.told[id] = append(c.told[id], text)
	c.mu.Unlock()
	c.f.Site.Apply(protocol.FactTurn{ID: id})
	go c.run(id, text)
	return "说了"
}

func (c *planFakeCrew) Dismiss(id string) bool {
	c.f.Site.Apply(protocol.FactLeft{ID: id})
	return true
}

func (c *planFakeCrew) Find(id string) *base.Roster {
	h := c.f.Site.Helper(id)
	if h == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return &base.Roster{Helper: *h, LastText: c.last[id]}
}

func (c *planFakeCrew) HarvestInto(id, target string) ([]string, error) {
	return []string{"c0ffee-" + id}, nil
}

// planFakeProjects: a check passes when the files it tests for were written; branches are only named.
type planFakeProjects struct {
	crew     *planFakeCrew
	mu       sync.Mutex
	branches []string
}

var planTestFile = regexp.MustCompile(`steps/(\w+)\.txt`)

func (p *planFakeProjects) Run(_ context.Context, cwd, command string) (bool, string) {
	p.crew.mu.Lock()
	defer p.crew.mu.Unlock()
	for _, m := range planTestFile.FindAllStringSubmatch(command, -1) {
		if !p.crew.written[m[1]] {
			return false, "steps/" + m[1] + ".txt: no such file"
		}
	}
	return true, ""
}

// ChangedFiles is what the step of the helper working in cwd (/wt/<id>) touched.
func (p *planFakeProjects) ChangedFiles(cwd, _ string) ([]string, error) {
	h := p.crew.f.Site.Helper(strings.TrimPrefix(cwd, "/wt/"))
	if h == nil || h.Playbook == nil || h.Playbook.Node == nil {
		return nil, nil
	}
	p.crew.mu.Lock()
	defer p.crew.mu.Unlock()
	return slices.Clone(p.crew.touched[*h.Playbook.Node]), nil
}

func (p *planFakeProjects) OpenBranch(project, branch string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.branches = append(p.branches, branch)
	return nil
}

func (p *planFakeProjects) HarvestBranch(project, branch string) (string, error) {
	return "合进了 " + project + " 的 main", nil
}

func (p *planFakeProjects) BranchChanges(project, branch string) (protocol.Changes, error) {
	return protocol.Changes{Project: project, Base: "main", Branch: &branch}, nil
}

func planRuntime(id string) *protocol.RuntimeInfo {
	return &protocol.RuntimeInfo{
		ID: id, Installation: protocol.Installation{Value: protocol.InstallationAvailable{Via: protocol.ViaBundled, Command: id}},
		Settings: protocol.RuntimeSettings{Enabled: true},
	}
}

type planTestFarm struct {
	*world
	crew     *planFakeCrew
	projects *planFakeProjects
	mu       sync.Mutex
	facts    []protocol.Playbook
	closing  sync.Once
}

func (tf *planTestFarm) Close() { tf.closing.Do(tf.world.Close) }

// newPlanTestFarm starts a farm at home with the stand-ins; before runs after it is built, before it starts.
func newPlanTestFarm(t *testing.T, home string, release chan struct{}, before func(*world)) *planTestFarm {
	t.Helper()
	// With the game's ledger, which the plans' coins go in.
	f, err := newWorldWith(base.Config{Home: home, WorkRoot: t.TempDir()}, []base.Layer{game.Module}, fx.Invoke(func(*game.Ledger) {}))
	if err != nil {
		t.Fatal(err)
	}
	tf := &planTestFarm{world: f, crew: newPlanFakeCrew(f, release)}
	tf.projects = &planFakeProjects{crew: tf.crew}
	f.Playbooks.crew, f.Playbooks.projects, f.Playbooks.runtime = tf.crew, tf.projects, planRuntime
	for _, a := range f.Store.Agents() {
		a.Effort = ""
		if _, err := f.Store.SaveAgent(a); err != nil {
			t.Fatal(err)
		}
	}
	if before != nil {
		before(f)
	}
	_, events, stop := f.Site.Events()
	go func() {
		for e := range events {
			// A playbook changes as its issues do: the parent, or one of its steps.
			if fact, ok := e.Value.(protocol.FactIssue); ok && (fact.Issue.Plan != nil || fact.Issue.Parent != nil) {
				id := fact.Issue.ID
				if fact.Issue.Parent != nil {
					id = *fact.Issue.Parent
				}
				if pb := protocol.PlaybookOf(f.Site.State(), id); pb != nil {
					tf.mu.Lock()
					tf.facts = append(tf.facts, *pb)
					tf.mu.Unlock()
				}
			}
		}
	}()
	if err := f.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stop()
		tf.Close()
	})
	return tf
}

func (tf *planTestFarm) until(t *testing.T, id string, ready func(protocol.Playbook) bool) protocol.Playbook {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if pb := protocol.PlaybookOf(tf.Site.State(), id); pb != nil && ready(*pb) {
			return *pb
		}
	}
	body, _ := json.MarshalIndent(protocol.PlaybookOf(tf.Site.State(), id), "", " ")
	t.Fatalf("playbook %s never got there: %s", id, body)
	return protocol.Playbook{}
}

var planIDIn = regexp.MustCompile(`（(p\d+)）`)

func (tf *planTestFarm) planned(t *testing.T, goal, project string) string {
	t.Helper()
	said, err := tf.Playbooks.Plan(goal, project, "", protocol.PlaybookActorUser)
	if err != nil {
		t.Fatal(err)
	}
	m := planIDIn.FindStringSubmatch(said)
	if m == nil {
		t.Fatal(said)
	}
	return m[1]
}

func (tf *planTestFarm) act(t *testing.T, id string, action protocol.PlaybookAction) string {
	t.Helper()
	said, err := tf.Playbooks.Act(id, action, protocol.PlaybookActorUser)
	if err != nil {
		t.Fatal(err)
	}
	return said
}

func planNode(pb protocol.Playbook, id string) protocol.PlaybookNode {
	if n := protocol.NodeOf(pb, id); n != nil {
		return *n
	}
	return protocol.PlaybookNode{}
}

func planState(pb protocol.Playbook, id string) protocol.NodeState { return planNode(pb, id).State }

func TestPlanDiamond(t *testing.T) {
	tf := newPlanTestFarm(t, t.TempDir(), nil, nil)
	news, stopNews := tf.Playbooks.News().Subscribe()
	defer stopNews()
	id := tf.planned(t, "菱形", "diamond")
	draft := tf.until(t, id, func(pb protocol.Playbook) bool { return pb.State == protocol.PlaybookStateDraft })
	var shape [][2]any
	for _, n := range draft.Nodes {
		shape = append(shape, [2]any{n.ID, strings.Join(n.Needs, ",")})
	}
	if fmt.Sprint(shape) != "[[a ] [b a] [c a] [d b,c]]" {
		t.Fatalf("draft: %v", shape)
	}
	if slices.ContainsFunc(tf.Site.State().Helpers, func(h protocol.Helper) bool { return h.Playbook != nil && h.Playbook.ID == id }) {
		t.Fatal("the planner went home with the draft")
	}
	if got := <-news; !strings.HasPrefix(got, "【种植计划】"+id+" 拆好了") {
		t.Fatalf("news: %s", got)
	}
	check := "test -f steps/b.txt && test -f steps/c.txt && test -f steps/d.txt"
	if _, err := tf.Playbooks.EditNode(id, "d", protocol.NodeEdit{Check: &check}, protocol.PlaybookActorForeman); err != nil {
		t.Fatal(err)
	}

	if said := tf.act(t, id, protocol.PlaybookActionStart); !strings.Contains(said, "开工了，分支 vibevalley/pb-"+id+"-") {
		t.Fatal(said)
	}
	ripe := tf.until(t, id, func(pb protocol.Playbook) bool { return pb.State == protocol.PlaybookStateRipe })
	tf.mu.Lock()
	states := slices.DeleteFunc(slices.Clone(tf.facts), func(pb protocol.Playbook) bool { return pb.ID != id })
	tf.mu.Unlock()
	if !slices.ContainsFunc(states, func(pb protocol.Playbook) bool {
		return planState(pb, "b") == protocol.NodeStateWorking && planState(pb, "c") == protocol.NodeStateWorking
	}) {
		t.Fatal("b and c worked at the same time")
	}
	i := slices.IndexFunc(states, func(pb protocol.Playbook) bool { return planState(pb, "d") == protocol.NodeStateWorking })
	if i < 0 || planState(states[i], "b") != protocol.NodeStateMerged || planState(states[i], "c") != protocol.NodeStateMerged {
		t.Fatal("d started after b and c were merged")
	}
	for _, n := range ripe.Nodes {
		if n.State != protocol.NodeStateMerged || len(n.Commits) == 0 || planStr(n.Conclusion) != "写好了 steps/"+n.ID+".txt" || n.Helper != nil {
			t.Fatalf("step %s: %+v", n.ID, n)
		}
	}
	if said := tf.act(t, id, protocol.PlaybookActionHarvest); !strings.Contains(said, "合进了 diamond 的 main") {
		t.Fatal(said)
	}
	tf.until(t, id, func(pb protocol.Playbook) bool { return pb.State == protocol.PlaybookStateDone })

	// Its history: who did what, in order, each step's way from start to merge.
	history := tf.Playbooks.Events(id)
	var plan []string
	for _, e := range history {
		if e.Node == nil {
			plan = append(plan, string(e.Kind)+"/"+string(e.Actor))
		}
	}
	if want := "planning/user drafted/farm started/user ripe/farm harvested/user"; strings.Join(plan, " ") != want {
		t.Fatalf("plan history: %v", plan)
	}
	edit := history[slices.IndexFunc(history, func(e protocol.PlaybookEvent) bool { return e.Kind == protocol.PlaybookEventKindNodeEdited })]
	if planStr(edit.Node) != "d" || edit.Actor != protocol.PlaybookActorForeman || len(edit.Changes) != 1 || edit.Changes[0].Field != "检查" {
		t.Fatalf("edit: %+v", edit)
	}
	for _, step := range []string{"a", "b", "c", "d"} {
		var way []string
		for _, e := range history {
			if planStr(e.Node) == step && e.Kind != protocol.PlaybookEventKindNodeEdited {
				way = append(way, string(e.Kind))
			}
		}
		if strings.Join(way, " ") != "node_started node_merged" {
			t.Fatalf("step %s: %v", step, way)
		}
	}
	merged := history[slices.IndexFunc(history, func(e protocol.PlaybookEvent) bool {
		return planStr(e.Node) == "a" && e.Kind == protocol.PlaybookEventKindNodeMerged
	})]
	if merged.Helper == nil || len(merged.Commits) == 0 || planStr(merged.Detail) != "写好了 steps/a.txt" {
		t.Fatalf("merged: %+v", merged)
	}
	for i := 1; i < len(history); i++ {
		if history[i].Seq <= history[i-1].Seq {
			t.Fatal("not in order")
		}
	}
	// A plan drafted and a playbook harvested are on the ledger.
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		kinds := planLedgerKinds(t, tf.world)
		if slices.Contains(kinds, "planned") && slices.Contains(kinds, "playbook") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("ledger: %v", kinds)
		}
	}
}

// An acceptance step first: the farm, not the helpers, judges it. Fixed along with its test, it caught nothing and goes
// back; failing, it is merged and its test frozen. The fix that loosens the frozen test goes back; the one that
// fixes the code passes the acceptance and the playbook is ripe.
func TestPlanAcceptanceFirst(t *testing.T) {
	tf := newPlanTestFarm(t, t.TempDir(), nil, nil)
	id := tf.planned(t, "验收先行", "bug")
	draft := tf.until(t, id, func(pb protocol.Playbook) bool { return pb.State == protocol.PlaybookStateDraft })
	if !protocol.IsAcceptance(planNode(draft, "repro")) || protocol.IsAcceptance(planNode(draft, "fix")) {
		t.Fatalf("draft: %+v", draft.Nodes)
	}
	tf.act(t, id, protocol.PlaybookActionStart)
	ripe := tf.until(t, id, func(pb protocol.Playbook) bool { return pb.State == protocol.PlaybookStateRipe })

	repro, fix := planNode(ripe, "repro"), planNode(ripe, "fix")
	if fmt.Sprint(repro.Frozen) != "[steps/repro_test.txt]" || fix.Frozen != nil {
		t.Fatalf("frozen: %v, %v", repro.Frozen, fix.Frozen)
	}
	if repro.Tries != 1 || fix.Tries != 1 {
		t.Fatalf("tries: repro %d, fix %d", repro.Tries, fix.Tries)
	}
	tf.crew.mu.Lock()
	defer tf.crew.mu.Unlock()
	told := func(step string) string {
		for _, h := range tf.Site.State().Helpers {
			if h.Playbook != nil && h.Playbook.Node != nil && *h.Playbook.Node == step {
				return strings.Join(tf.crew.told[h.ID], "\n")
			}
		}
		// Merged helpers have left: their words are under their ids, w2 the first step's (w1 planned).
		return strings.Join(tf.crew.told[map[string]string{"repro": "w2", "fix": "w3"}[step]], "\n")
	}
	if got := told("repro"); !strings.Contains(got, "现在就通过了") {
		t.Fatalf("repro was told: %s", got)
	}
	if got := told("fix"); !strings.Contains(got, "steps/repro_test.txt") || !strings.Contains(got, "冻结") {
		t.Fatalf("fix was told: %s", got)
	}
	task := protocol.NodeTask(ripe, fix)
	if !strings.Contains(task, "冻结的，不能改：steps/repro_test.txt") || !strings.Contains(task, "收尾的一步") {
		t.Fatalf("fix's task: %s", task)
	}
}

func TestPlanFailingStep(t *testing.T) {
	tf := newPlanTestFarm(t, t.TempDir(), nil, nil)
	id := tf.planned(t, "有坏步", "shaky")
	tf.until(t, id, func(pb protocol.Playbook) bool { return pb.State == protocol.PlaybookStateDraft })
	tf.act(t, id, protocol.PlaybookActionStart)
	stuck := tf.until(t, id, func(pb protocol.Playbook) bool {
		return planState(pb, "boom") == protocol.NodeStateFailed && planState(pb, "flaky") == protocol.NodeStateMerged
	})
	if planNode(stuck, "boom").Tries != protocol.AutoRetries {
		t.Fatalf("boom: sent back by itself, then left for you: %+v", planNode(stuck, "boom"))
	}
	if planNode(stuck, "flaky").Tries != 1 {
		t.Fatalf("flaky: its check failed once: %+v", planNode(stuck, "flaky"))
	}
	if !slices.ContainsFunc(tf.Playbooks.Events(id), func(e protocol.PlaybookEvent) bool {
		return e.Kind == protocol.PlaybookEventKindNodeSentBack && planStr(e.Node) == "flaky" && e.Actor == protocol.PlaybookActorFarm &&
			strings.Contains(planStr(e.Detail), "没通过")
	}) {
		t.Fatal("why it was sent back is kept")
	}
	if planNode(stuck, "boom").Failures != 1 {
		t.Fatalf("boom failed once: %+v", planNode(stuck, "boom"))
	}
	// Retried, it fails again: its tries start over, its failures do not, and the second failure is a call of its own.
	if _, err := tf.Playbooks.NodeAct(id, "boom", protocol.NodeActionRetry, protocol.PlaybookActorUser); err != nil {
		t.Fatal(err)
	}
	stuck = tf.until(t, id, func(pb protocol.Playbook) bool {
		return planState(pb, "boom") == protocol.NodeStateFailed && planNode(pb, "boom").Failures == 2
	})
	var inbox []string
	for _, c := range protocol.Inbox(tf.Site.State()) {
		inbox = append(inbox, c.ID)
	}
	if !slices.Contains(inbox, id+":failed:boom:2") {
		t.Fatalf("the second failure is in the inbox again: %v", inbox)
	}
	after := planNode(stuck, "after")
	if after.State != protocol.NodeStateWaiting || fmt.Sprint(protocol.BlockedBy(stuck, after)) != "[boom]" || stuck.State != protocol.PlaybookStateRunning {
		t.Fatalf("after: %+v, playbook %s", after, stuck.State)
	}
	// Skipping a working step is refused; a failed one may be.
	if _, err := tf.Playbooks.NodeAct(id, "nope", protocol.NodeActionSkip, protocol.PlaybookActorUser); err == nil || !strings.Contains(err.Error(), "没有「nope」") {
		t.Fatal(err)
	}
	skipped, err := tf.Playbooks.NodeAct(id, "boom", protocol.NodeActionSkip, protocol.PlaybookActorUser)
	if err != nil || !strings.Contains(skipped, "跳过了") {
		t.Fatal(skipped, err)
	}
	ripe := tf.until(t, id, func(pb protocol.Playbook) bool { return pb.State == protocol.PlaybookStateRipe })
	var states []string
	for _, n := range ripe.Nodes {
		states = append(states, string(n.State))
	}
	if strings.Join(states, " ") != "skipped merged merged" {
		t.Fatal(states)
	}
	// Given up: its branch stays.
	said := tf.act(t, id, protocol.PlaybookActionAbandon)
	gone := tf.until(t, id, func(pb protocol.Playbook) bool { return pb.State == protocol.PlaybookStateAbandoned })
	if gone.Branch == nil || !strings.Contains(said, "分支 "+*gone.Branch+" 留着") {
		t.Fatal(said)
	}
	if _, err := tf.Playbooks.Act(id, protocol.PlaybookActionHarvest, protocol.PlaybookActorUser); err == nil || !strings.Contains(err.Error(), "不能收获") {
		t.Fatal(err)
	}
}

func TestPlanSentBackOnce(t *testing.T) {
	tf := newPlanTestFarm(t, t.TempDir(), nil, nil)
	id := tf.planned(t, "先给个圈", "circle")
	draft := tf.until(t, id, func(pb protocol.Playbook) bool { return pb.State == protocol.PlaybookStateDraft })
	if draft.Title != "改好了" || len(draft.Nodes) != 1 || draft.Nodes[0].ID != "fixed" {
		t.Fatalf("draft: %+v", draft)
	}
	_, err := tf.Playbooks.EditNode(id, "fixed", protocol.NodeEdit{Needs: []string{"fixed"}}, protocol.PlaybookActorUser)
	if err == nil || !strings.Contains(err.Error(), "不能等自己") {
		t.Fatal(err)
	}
	if _, err := tf.Playbooks.Changes(id); err == nil || !strings.Contains(err.Error(), "没有分支") {
		t.Fatal(err)
	}
	tf.act(t, id, protocol.PlaybookActionAbandon)
	if _, err := tf.Playbooks.Plan(" ", "x", "", protocol.PlaybookActorUser); err == nil {
		t.Fatal("an empty goal is refused")
	}
}

func TestPlanRestart(t *testing.T) {
	home := t.TempDir()
	release := make(chan struct{})
	defer close(release)
	first := newPlanTestFarm(t, home, release, nil)
	id := first.planned(t, "慢", "slowpoke")
	first.until(t, id, func(pb protocol.Playbook) bool { return pb.State == protocol.PlaybookStateDraft })
	first.act(t, id, protocol.PlaybookActionStart)
	working := first.until(t, id, func(pb protocol.Playbook) bool { return planState(pb, "slow") == protocol.NodeStateWorking })
	helper := planStr(planNode(working, "slow").Helper)
	first.Close()

	// The crew brings back only helpers it kept in crew.json, in a folder that is still there; one that was working
	// comes back resting, its turn over.
	crewJSON := `{"hired":9,"hands":[{"id":"` + helper + `","place":{"project":"` + working.Project + `","cwd":"` + t.TempDir() + `"}}]}`
	if err := os.WriteFile(filepath.Join(home, "crew.json"), []byte(crewJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	second := newPlanTestFarm(t, home, release, nil)
	second.crew.attempts["slow"] = 1
	paused := second.until(t, id, func(pb protocol.Playbook) bool { return pb.State == protocol.PlaybookStatePaused })
	if !strings.Contains(planStr(paused.Note), "重启") {
		t.Fatal(planStr(paused.Note))
	}
	second.act(t, id, protocol.PlaybookActionResume)
	ripe := second.until(t, id, func(pb protocol.Playbook) bool { return pb.State == protocol.PlaybookStateRipe })
	if planState(ripe, "slow") != protocol.NodeStateMerged {
		t.Fatal(ripe)
	}
	// The history came through the restart.
	if events := second.Playbooks.Events(id); events[0].Kind != protocol.PlaybookEventKindPlanning {
		t.Fatal(events)
	}
}

func TestPlanChooseAgent(t *testing.T) {
	a := func(id, runtime string, tags ...string) protocol.AgentProfile {
		return protocol.AgentProfile{ID: id, Name: "名" + id, Runtime: runtime, Tags: tags}
	}
	cands := []runs.Candidate{{Agent: a("x", "pi", "测试"), Usable: true}, {Agent: a("y", "claude", "前端", "页面"), Usable: true}, {Agent: a("z", "codex"), Usable: false}}
	for _, c := range []struct{ task, named, want string }{
		{"改页面的前端", "", "y"},
		{"随便", "", "x"},
		{"随便", "z", "z"},
		{"随便", "名y", "y"},
		{"随便", "claude", "y"},
		{"随便", "codex", "x"},
	} {
		if got := runs.ChooseAgent(cands, c.task, c.named, ""); got == nil || got.ID != c.want {
			t.Errorf("%q named %q: %v, want %s", c.task, c.named, got, c.want)
		}
	}
	if runs.ChooseAgent(cands[2:], "x", "", "") != nil {
		t.Error("no usable agent")
	}
	if got := base.ClipLine("  一二三\n四五  ", 4); got != "一二三…" {
		t.Error(got)
	}
	task := runs.PlanningTask("做个打卡", "clock", []protocol.AgentProfile{a("lab", "pi", "实验")})
	if !strings.Contains(task, "要做的事：做个打卡") || !strings.Contains(task, `"agent": "lab"`) || !strings.Contains(task, "  - lab：名lab，适合：（实验）") {
		t.Error(task)
	}
	// The example the planner is shown is a plan the farm takes, its acceptance step first.
	if plan := protocol.ParsePlan(task); !plan.OK || !protocol.IsAcceptance(plan.Nodes[0]) {
		t.Errorf("the example: %+v", plan)
	}
}

// A playbook is a parent issue, its planner a run of it; each step a sub-issue blocked by the steps it needs, its
// helpers runs of it. The board does not change them; they close as the playbook does.
func TestPlanIsAParentIssue(t *testing.T) {
	tf := newPlanTestFarm(t, t.TempDir(), nil, nil)
	id := tf.planned(t, "菱形", "diamond")
	tf.until(t, id, func(pb protocol.Playbook) bool { return pb.State == protocol.PlaybookStateDraft })
	parent, err := tf.Issues.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	if parent.Plan == nil || parent.Title != "菱形" || len(parent.Runs) != 1 || parent.Status != protocol.IssueStatusWaiting {
		t.Fatalf("the parent: %+v", parent)
	}
	d, err := tf.Issues.Get(protocol.StepIssueID(id, "d"))
	if err != nil {
		t.Fatal(err)
	}
	if *d.Parent != id || fmt.Sprint(d.BlockedBy) != fmt.Sprintf("[%s.b %s.c]", id, id) || d.Status != protocol.IssueStatusTodo {
		t.Fatalf("a step: %+v", d)
	}
	var refused protocol.FarmRefused
	if _, err := tf.Issues.Edit(d.ID, protocol.IssueRequest{Title: "改"}); !errors.As(err, &refused) {
		t.Fatalf("a step changed on the board: %v", err)
	}
	if _, err := tf.Dispatch.Start(context.Background(), d.ID, 0); !errors.As(err, &refused) {
		t.Fatalf("a step started on the board: %v", err)
	}
	tf.act(t, id, protocol.PlaybookActionStart)
	tf.until(t, id, func(pb protocol.Playbook) bool { return pb.State == protocol.PlaybookStateRipe })
	a, _ := tf.Issues.Get(protocol.StepIssueID(id, "a"))
	if len(a.Runs) != 1 || a.Closed == nil || *a.Closed != protocol.IssueCloseMerged {
		t.Fatalf("a step done: %+v", a)
	}
	if got, _ := tf.Issues.Get(a.Runs[0]); got.ID != a.ID {
		t.Fatalf("its helper's issue: %s", got.ID)
	}
	if _, err := tf.Dispatch.Reopen(context.Background(), a.ID, "", 0); !errors.As(err, &refused) {
		t.Fatalf("a step reopened on the board: %v", err)
	}
	tf.act(t, id, protocol.PlaybookActionHarvest)
	farmtest.Until(t, "the playbook closed, harvested", func() bool {
		got, err := tf.Issues.Get(id)
		return err == nil && got.Closed != nil && *got.Closed == protocol.IssueCloseHarvested
	})
}

// Playbooks from before they were issues come over from farm.json: their issues made, the runs of the issues their
// planner and steps worked moved onto them, farm.json as it was kept beside it.
func TestPlanAdoptsPlaybooksOfBefore(t *testing.T) {
	home := t.TempDir()
	pb := protocol.Playbook{
		ID: "p4", Title: "旧计划", Goal: "做旧的", Project: "old", State: protocol.PlaybookStateRipe, Parallel: 2, CreatedAt: 1000,
		Nodes: []protocol.PlaybookNode{{ID: "a", Title: "一", Task: "做一", Needs: []string{}, State: protocol.NodeStateMerged, Commits: []string{"abc"}}},
	}
	body, _ := json.Marshal(map[string]any{"call": "idle", "foreman": "idle", "helpers": []any{}, "reports": []any{}, "playbooks": []any{pb}})
	if err := os.WriteFile(filepath.Join(home, "farm.json"), body, 0o644); err != nil {
		t.Fatal(err)
	}
	db, err := base.OpenDB(filepath.Join(home, "farm.db"))
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`insert into issue (id, title, description, created_at, playbook) values ('tplan', '拆', '', 1, '{"id":"p4"}'), ('tstep', '一', '', 2, '{"id":"p4","node":"a"}')`,
		`insert into issue_run (run, issue, started_at) values ('w1', 'tplan', 1), ('w2', 'tstep', 2)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()
	tf := newPlanTestFarm(t, home, nil, nil)
	got := protocol.PlaybookOf(tf.Site.State(), "p4")
	if got == nil || got.State != protocol.PlaybookStateRipe || planState(*got, "a") != protocol.NodeStateMerged {
		t.Fatalf("the playbook: %+v", got)
	}
	parent, _ := tf.Issues.Get("w1")
	step, _ := tf.Issues.Get("w2")
	if parent.ID != "p4" || step.ID != "p4.a" {
		t.Fatalf("the runs moved: %s, %s", parent.ID, step.ID)
	}
	if _, err := tf.Issues.Get("tplan"); err == nil {
		t.Fatal("the planner's issue of before stayed")
	}
	if _, err := os.Stat(filepath.Join(home, "farm.json.playbooks")); err != nil {
		t.Fatal("farm.json as it was")
	}
	if next, _ := tf.Issues.NextPlaybookID(); next != "p5" {
		t.Fatalf("next: %s", next)
	}
}

// planLedgerKinds is the kinds of what is on the ledger, in order.
func planLedgerKinds(t *testing.T, f *world) []string {
	t.Helper()
	rows, err := f.DB.Query("select kind from ledger order by seq")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var k string
		rows.Scan(&k)
		out = append(out, k)
	}
	return out
}
