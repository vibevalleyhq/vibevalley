package playbook

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

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/internal/worker"
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/str"
)

func planStep(id string, needs ...string) map[string]any {
	if needs == nil {
		needs = []string{}
	}
	return map[string]any{"id": id, "title": "步骤 " + id, "task": "写 steps/" + id + ".txt", "needs": needs, "agent": "lab", "check": "test -f steps/" + id + ".txt"}
}

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

type planFakeWorkers struct {
	f *world

	mu       sync.Mutex
	n        int
	last     map[string]string
	attempts map[string]int
	written  map[string]bool
	started  map[string]bool
	touched  map[string][]string
	told     map[string][]string
	release  chan struct{}
}

func newPlanFakeWorkers(f *world, release chan struct{}) *planFakeWorkers {
	return &planFakeWorkers{f: f, last: map[string]string{}, attempts: map[string]int{}, written: map[string]bool{}, started: map[string]bool{}, touched: map[string][]string{}, told: map[string][]string{}, release: release}
}

var planGoal = regexp.MustCompile(`要做的事：(\S+)`)

func (c *planFakeWorkers) work(h protocol.Worker, input string) (protocol.Outcome, string) {
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
		c.mu.Lock()
		c.touched[id] = []string{"steps/repro_test.txt"}
		c.mu.Unlock()
		return protocol.OutcomeCompleted, "结论：把测试改松了"
	case id == "flaky" && n == 1:
		return protocol.OutcomeCompleted, "结论：做完了"
	}
	c.mu.Lock()
	c.written[id] = true
	c.touched[id] = []string{"steps/" + id + ".txt"}
	c.mu.Unlock()
	return protocol.OutcomeCompleted, "结论：写好了 steps/" + id + ".txt"
}

func (c *planFakeWorkers) run(id, input string) {
	h := c.f.Core.Worker(id)
	if h == nil {
		return
	}
	outcome, said := c.work(*h, input)
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
	c.f.Core.Apply(protocol.FactReport{ID: id, Outcome: outcome, Summary: summary, Runs: 1})
}

func (c *planFakeWorkers) Hire(_ context.Context, agent protocol.Agent, task, project string, opt worker.HireOptions) worker.Hired {
	c.mu.Lock()
	c.n++
	id := fmt.Sprintf("w%d", c.n)
	c.mu.Unlock()
	wt := "/wt/" + id
	h := protocol.Worker{
		ID: id, Name: "帮工" + id, Agent: agent.ID, Runtime: agent.Runtime, Task: task, Project: &project, Worktree: &wt,
		HiredAt: clock.NowMs(), Phase: protocol.Phase{Value: protocol.PhaseWorking{Since: clock.NowMs()}}, Playbook: opt.Playbook,
	}
	c.f.Core.Apply(protocol.FactHired{Worker: h})
	if opt.Issue != "" {
		if err := c.f.Issue.Ran(opt.Issue, h); err != nil {
			panic(err)
		}
	}
	go c.run(id, task)
	return worker.Hired{Worker: &h}
}

func (c *planFakeWorkers) Tell(id, text string) string {
	c.mu.Lock()
	c.told[id] = append(c.told[id], text)
	c.mu.Unlock()
	c.f.Core.Apply(protocol.FactRun{ID: id})
	go c.run(id, text)
	return "说了"
}

func (c *planFakeWorkers) Dismiss(id string) bool {
	c.f.Core.Apply(protocol.FactLeft{ID: id})
	return true
}

func (c *planFakeWorkers) Find(id string) *worker.Roster {
	h := c.f.Core.Worker(id)
	if h == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return &worker.Roster{Worker: *h, LastText: c.last[id]}
}

func (c *planFakeWorkers) MergeInto(id, target string) ([]string, error) {
	return []string{"c0ffee-" + id}, nil
}

type planFakeProjects struct {
	workers  *planFakeWorkers
	mu       sync.Mutex
	branches []string
}

var planTestFile = regexp.MustCompile(`steps/(\w+)\.txt`)

func (p *planFakeProjects) Run(_ context.Context, cwd, command string) (bool, string) {
	p.workers.mu.Lock()
	defer p.workers.mu.Unlock()
	for _, m := range planTestFile.FindAllStringSubmatch(command, -1) {
		if !p.workers.written[m[1]] {
			return false, "steps/" + m[1] + ".txt: no such file"
		}
	}
	return true, ""
}

func (p *planFakeProjects) ChangedFiles(cwd, _ string) ([]string, error) {
	h := p.workers.f.Core.Worker(strings.TrimPrefix(cwd, "/wt/"))
	if h == nil || h.Playbook == nil || h.Playbook.Node == nil {
		return nil, nil
	}
	p.workers.mu.Lock()
	defer p.workers.mu.Unlock()
	return slices.Clone(p.workers.touched[*h.Playbook.Node]), nil
}

func (p *planFakeProjects) OpenBranch(project, branch string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.branches = append(p.branches, branch)
	return nil
}

func (p *planFakeProjects) MergeBranch(project, branch string) (string, error) {
	return "合进了 " + project + " 的 main", nil
}

func (p *planFakeProjects) BranchChanges(project, branch string) (protocol.Changes, error) {
	return protocol.Changes{Project: project, Base: "main", Branch: &branch}, nil
}

type planTestFarm struct {
	*world
	workers  *planFakeWorkers
	projects *planFakeProjects
	mu       sync.Mutex
	facts    []protocol.Playbook
	closing  sync.Once
}

func (tf *planTestFarm) Close() { tf.closing.Do(tf.world.Close) }

func newPlanTestFarm(t *testing.T, home string, release chan struct{}, before func(*world)) *planTestFarm {
	t.Helper()
	f, err := newWorldWith(fixture.Config(home, t.TempDir(), ""), nil)
	if err != nil {
		t.Fatal(err)
	}
	tf := &planTestFarm{world: f, workers: newPlanFakeWorkers(f, release)}
	tf.projects = &planFakeProjects{workers: tf.workers}
	f.Playbook.workers, f.Playbook.projects, f.Playbook.check = tf.workers, tf.projects, func(protocol.Agent) []protocol.AgentIssue { return nil }
	for _, a := range f.Agent.Agents() {
		a.Effort = ""
		if _, err := f.Agent.SaveAgent(a); err != nil {
			t.Fatal(err)
		}
	}
	if before != nil {
		before(f)
	}
	_, events, stop := f.Core.Events()
	go func() {
		for e := range events {
			if fact, ok := e.Value.(protocol.FactIssue); ok && (fact.Issue.Plan != nil || fact.Issue.Parent != nil) {
				id := fact.Issue.ID
				if fact.Issue.Parent != nil {
					id = *fact.Issue.Parent
				}
				if pb := protocol.PlaybookOf(f.Core.State(), id); pb != nil {
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
	return *testkit.Await(t, "playbook "+id+" gets there", func() (*protocol.Playbook, bool) {
		pb := protocol.PlaybookOf(tf.Core.State(), id)
		return pb, pb != nil && ready(*pb)
	})
}

var planIDIn = regexp.MustCompile(`（(p\d+)）`)

func (tf *planTestFarm) planned(t *testing.T, goal, project string) string {
	t.Helper()
	said, err := tf.Playbook.Plan(goal, project, "", protocol.PlaybookActorUser)
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
	said, err := tf.Playbook.Act(id, action, protocol.PlaybookActorUser)
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
	news, stopNews := tf.Playbook.News().Subscribe()
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
	if slices.ContainsFunc(tf.Core.State().Workers, func(h protocol.Worker) bool { return h.Playbook != nil && h.Playbook.ID == id }) {
		t.Fatal("the planner went home with the draft")
	}
	if got := <-news; !strings.HasPrefix(got, "【种植计划】"+id+" 拆好了") {
		t.Fatalf("news: %s", got)
	}
	check := "test -f steps/b.txt && test -f steps/c.txt && test -f steps/d.txt"
	if _, err := tf.Playbook.EditNode(id, "d", protocol.NodeEdit{Check: &check}, protocol.PlaybookActorManager); err != nil {
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
		if n.State != protocol.NodeStateMerged || len(n.Commits) == 0 || planStr(n.Conclusion) != "写好了 steps/"+n.ID+".txt" || n.Worker != nil {
			t.Fatalf("step %s: %+v", n.ID, n)
		}
	}
	if said := tf.act(t, id, protocol.PlaybookActionMerge); !strings.Contains(said, "合进了 diamond 的 main") {
		t.Fatal(said)
	}
	tf.until(t, id, func(pb protocol.Playbook) bool { return pb.State == protocol.PlaybookStateDone })

	history := tf.Playbook.Events(id)
	var plan []string
	for _, e := range history {
		if e.Node == nil {
			plan = append(plan, string(e.Kind)+"/"+string(e.Actor))
		}
	}
	if want := "planning/user drafted/system started/user ripe/system merged/user"; strings.Join(plan, " ") != want {
		t.Fatalf("plan history: %v", plan)
	}
	edit := history[slices.IndexFunc(history, func(e protocol.PlaybookEvent) bool { return e.Kind == protocol.PlaybookEventKindNodeEdited })]
	if planStr(edit.Node) != "d" || edit.Actor != protocol.PlaybookActorManager || len(edit.Changes) != 1 || edit.Changes[0].Field != "检查" {
		t.Fatalf("edit: %+v", edit)
	}
	testkit.Match(t, edit.Text, `^改了「.+」的检查$`, "in words, the step by its title")
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
	if merged.Worker == nil || len(merged.Commits) == 0 || planStr(merged.Detail) != "写好了 steps/a.txt" {
		t.Fatalf("merged: %+v", merged)
	}
	for i := 1; i < len(history); i++ {
		if history[i].Seq <= history[i-1].Seq {
			t.Fatal("not in order")
		}
	}
}

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
	tf.workers.mu.Lock()
	defer tf.workers.mu.Unlock()
	told := func(step string) string {
		for _, h := range tf.Core.State().Workers {
			if h.Playbook != nil && h.Playbook.Node != nil && *h.Playbook.Node == step {
				return strings.Join(tf.workers.told[h.ID], "\n")
			}
		}
		return strings.Join(tf.workers.told[map[string]string{"repro": "w2", "fix": "w3"}[step]], "\n")
	}
	if got := told("repro"); !strings.Contains(got, "现在就通过了") {
		t.Fatalf("repro was told: %s", got)
	}
	if got := told("fix"); !strings.Contains(got, "steps/repro_test.txt") || !strings.Contains(got, "冻结") {
		t.Fatalf("fix was told: %s", got)
	}
	task := nodeTask(ripe, fix)
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
	if !slices.ContainsFunc(tf.Playbook.Events(id), func(e protocol.PlaybookEvent) bool {
		return e.Kind == protocol.PlaybookEventKindNodeSentBack && planStr(e.Node) == "flaky" && e.Actor == protocol.PlaybookActorSystem &&
			strings.Contains(planStr(e.Detail), "没通过")
	}) {
		t.Fatal("why it was sent back is kept")
	}
	if planNode(stuck, "boom").Failures != 1 {
		t.Fatalf("boom failed once: %+v", planNode(stuck, "boom"))
	}
	if _, err := tf.Playbook.NodeAct(id, "boom", protocol.NodeActionRetry, protocol.PlaybookActorUser); err != nil {
		t.Fatal(err)
	}
	stuck = tf.until(t, id, func(pb protocol.Playbook) bool {
		return planState(pb, "boom") == protocol.NodeStateFailed && planNode(pb, "boom").Failures == 2
	})
	var inbox []string
	for _, c := range protocol.Inbox(tf.Core.State()) {
		inbox = append(inbox, c.ID)
	}
	if !slices.Contains(inbox, id+":failed:boom:2") {
		t.Fatalf("the second failure is in the inbox again: %v", inbox)
	}
	after := planNode(stuck, "after")
	if after.State != protocol.NodeStateWaiting || fmt.Sprint(protocol.BlockedBy(stuck, after)) != "[boom]" || stuck.State != protocol.PlaybookStateRunning {
		t.Fatalf("after: %+v, playbook %s", after, stuck.State)
	}
	if _, err := tf.Playbook.NodeAct(id, "nope", protocol.NodeActionSkip, protocol.PlaybookActorUser); err == nil || !strings.Contains(err.Error(), "没有「nope」") {
		t.Fatal(err)
	}
	skipped, err := tf.Playbook.NodeAct(id, "boom", protocol.NodeActionSkip, protocol.PlaybookActorUser)
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
	said := tf.act(t, id, protocol.PlaybookActionAbandon)
	gone := tf.until(t, id, func(pb protocol.Playbook) bool { return pb.State == protocol.PlaybookStateAbandoned })
	if gone.Branch == nil || !strings.Contains(said, "分支 "+*gone.Branch+" 留着") {
		t.Fatal(said)
	}
	if _, err := tf.Playbook.Act(id, protocol.PlaybookActionMerge, protocol.PlaybookActorUser); err == nil || !strings.Contains(err.Error(), "不能收获") {
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
	_, err := tf.Playbook.EditNode(id, "fixed", protocol.NodeEdit{Needs: []string{"fixed"}}, protocol.PlaybookActorUser)
	if err == nil || !strings.Contains(err.Error(), "不能等自己") {
		t.Fatal(err)
	}
	if _, err := tf.Playbook.Changes(id); err == nil || !strings.Contains(err.Error(), "没有分支") {
		t.Fatal(err)
	}
	tf.act(t, id, protocol.PlaybookActionAbandon)
	if _, err := tf.Playbook.Plan(" ", "x", "", protocol.PlaybookActorUser); err == nil {
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
	worker := planStr(planNode(working, "slow").Worker)
	first.Close()

	savedJSON := `{"hired":9,"hands":[{"id":"` + worker + `","place":{"project":"` + working.Project + `","cwd":"` + t.TempDir() + `"}}]}`
	if err := os.WriteFile(filepath.Join(home, "workers.json"), []byte(savedJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	second := newPlanTestFarm(t, home, release, nil)
	second.workers.attempts["slow"] = 1
	paused := second.until(t, id, func(pb protocol.Playbook) bool { return pb.State == protocol.PlaybookStatePaused })
	if !strings.Contains(planStr(paused.Note), "重启") {
		t.Fatal(planStr(paused.Note))
	}
	second.act(t, id, protocol.PlaybookActionResume)
	ripe := second.until(t, id, func(pb protocol.Playbook) bool { return pb.State == protocol.PlaybookStateRipe })
	if planState(ripe, "slow") != protocol.NodeStateMerged {
		t.Fatal(ripe)
	}
	if events := second.Playbook.Events(id); events[0].Kind != protocol.PlaybookEventKindPlanning {
		t.Fatal(events)
	}
}

func TestPlanChooseAgent(t *testing.T) {
	a := func(id, runtime string, tags ...string) protocol.Agent {
		return protocol.Agent{ID: id, Name: "名" + id, Runtime: runtime, Tags: tags}
	}
	cands := []worker.Candidate{{Agent: a("x", "pi", "测试"), Usable: true}, {Agent: a("y", "claude", "前端", "页面"), Usable: true}, {Agent: a("z", "codex"), Usable: false}}
	for _, c := range []struct{ task, named, want string }{
		{"改页面的前端", "", "y"},
		{"随便", "", "x"},
		{"随便", "z", "z"},
		{"随便", "名y", "y"},
		{"随便", "claude", "y"},
		{"随便", "codex", "x"},
	} {
		if got := worker.ChooseAgent(cands, c.task, c.named, ""); got == nil || got.ID != c.want {
			t.Errorf("%q named %q: %v, want %s", c.task, c.named, got, c.want)
		}
	}
	if worker.ChooseAgent(cands[2:], "x", "", "") != nil {
		t.Error("no usable agent")
	}
	if got := str.Clip("  一二三\n四五  ", 4); got != "一二三…" {
		t.Error(got)
	}
	task := worker.PlanningTask("做个打卡", "clock", []protocol.Agent{a("lab", "pi", "实验")})
	if !strings.Contains(task, "要做的事：做个打卡") || !strings.Contains(task, `"agent": "lab"`) || !strings.Contains(task, "  - lab：名lab，适合：（实验）") {
		t.Error(task)
	}
	if plan := parsePlan(task); !plan.OK || !protocol.IsAcceptance(plan.Nodes[0]) {
		t.Errorf("the example: %+v", plan)
	}
}

func TestPlanIsAParentIssue(t *testing.T) {
	tf := newPlanTestFarm(t, t.TempDir(), nil, nil)
	id := tf.planned(t, "菱形", "diamond")
	tf.until(t, id, func(pb protocol.Playbook) bool { return pb.State == protocol.PlaybookStateDraft })
	parent, err := tf.Issue.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	if parent.Plan == nil || parent.Title != "菱形" || len(parent.Workers) != 1 || parent.Status != protocol.IssueStatusInReview {
		t.Fatalf("the parent: %+v", parent)
	}
	d, err := tf.Issue.Get(protocol.StepIssueID(id, "d"))
	if err != nil {
		t.Fatal(err)
	}
	if *d.Parent != id || fmt.Sprint(d.BlockedBy) != fmt.Sprintf("[%s.b %s.c]", id, id) || d.Status != protocol.IssueStatusBacklog {
		t.Fatalf("a step: %+v", d)
	}
	var refused protocol.Refused
	if _, err := tf.Issue.Edit(d.ID, protocol.IssueUpdate{Title: new("改")}); !errors.As(err, &refused) {
		t.Fatalf("a step changed on the board: %v", err)
	}
	if _, err := tf.Issue.Start(context.Background(), d.ID, 0); !errors.As(err, &refused) {
		t.Fatalf("a step started on the board: %v", err)
	}
	tf.act(t, id, protocol.PlaybookActionStart)
	tf.until(t, id, func(pb protocol.Playbook) bool { return pb.State == protocol.PlaybookStateRipe })
	a, _ := tf.Issue.Get(protocol.StepIssueID(id, "a"))
	if len(a.Workers) != 1 || a.Closed == nil || *a.Closed != protocol.IssueCloseMergedIntoPlan {
		t.Fatalf("a step done: %+v", a)
	}
	if got, _ := tf.Issue.Get(a.Workers[0]); got.ID != a.ID {
		t.Fatalf("its worker's issue: %s", got.ID)
	}
	if _, err := tf.Issue.Reopen(context.Background(), a.ID, "", 0); !errors.As(err, &refused) {
		t.Fatalf("a step reopened on the board: %v", err)
	}
	tf.act(t, id, protocol.PlaybookActionMerge)
	testkit.Until(t, "the playbook closed, harvested", func() bool {
		got, err := tf.Issue.Get(id)
		return err == nil && got.Closed != nil && *got.Closed == protocol.IssueCloseMerged
	})
}
