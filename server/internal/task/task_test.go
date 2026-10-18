package task

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
	"vibevalley/internal/runtime"
	"vibevalley/internal/session"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/str"
)

func draftTask(id string, needs ...string) map[string]any {
	if needs == nil {
		needs = []string{}
	}
	return map[string]any{"id": id, "title": "步骤 " + id, "brief": "写 steps/" + id + ".txt", "needs": needs, "agent": "lab", "check": "test -f steps/" + id + ".txt"}
}

var taskList = map[string]any{
	"菱形":   map[string]any{"title": "菱形", "tasks": []any{draftTask("a"), draftTask("b", "a"), draftTask("c", "a"), draftTask("d", "b", "c")}},
	"有坏步":  map[string]any{"title": "有坏步", "tasks": []any{func() map[string]any { s := draftTask("boom"); delete(s, "check"); return s }(), draftTask("flaky"), draftTask("after", "boom")}},
	"先给个圈": map[string]any{"tasks": []any{draftTask("x", "y"), draftTask("y", "x")}},
	"慢":    map[string]any{"title": "慢", "tasks": []any{draftTask("slow")}},
	"验收先行": map[string]any{"title": "验收先行", "tasks": []any{
		map[string]any{"id": "repro", "title": "复现", "brief": "写一个现在会失败的测试", "needs": []string{}, "agent": "lab", "check": "test -f steps/fix.txt", "acceptance": true},
		map[string]any{"id": "fix", "title": "修", "brief": "修好它", "needs": []string{"repro"}, "agent": "lab"},
	}},
}

type taskFakeSessions struct {
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

func newTaskFakeSessions(f *world, release chan struct{}) *taskFakeSessions {
	return &taskFakeSessions{f: f, last: map[string]string{}, attempts: map[string]int{}, written: map[string]bool{}, started: map[string]bool{}, touched: map[string][]string{}, told: map[string][]string{}, release: release}
}

var taskGoal = regexp.MustCompile(`要做的事：(\S+)`)

func (c *taskFakeSessions) work(h protocol.Session, input string) (protocol.Outcome, string) {
	if h.Graph == nil || h.Graph.Task == nil {
		var task any
		if strings.Contains(input, "计划有问题") {
			task = map[string]any{"title": "改好了", "tasks": []any{draftTask("fixed")}}
		} else if m := taskGoal.FindStringSubmatch(input); m != nil {
			task = taskList[m[1]]
		}
		body, _ := json.MarshalIndent(task, "", "  ")
		return protocol.OutcomeCompleted, "读完了。\n\n```json\n" + string(body) + "\n```\n\n结论：拆好了。"
	}
	id := *h.Graph.Task
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

func (c *taskFakeSessions) run(id, input string) {
	h := c.f.Core.Session(id)
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

func (c *taskFakeSessions) Hire(_ context.Context, agent protocol.Agent, task, project string, opt session.HireOptions) session.Hired {
	c.mu.Lock()
	c.n++
	id := fmt.Sprintf("w%d", c.n)
	c.mu.Unlock()
	wt := "/wt/" + id
	h := protocol.Session{
		ID: id, Name: "帮工" + id, Agent: agent.ID, Runtime: agent.Runtime, Brief: task, Project: &project, Worktree: &wt,
		HiredAt: clock.NowMs(), Phase: protocol.Phase{Value: protocol.PhaseWorking{Since: clock.NowMs()}}, Graph: opt.TaskGraph,
	}
	c.f.Core.Apply(protocol.FactHired{Session: h})
	if opt.Issue != "" {
		if err := c.f.Issue.Ran(opt.Issue, h); err != nil {
			panic(err)
		}
	}
	go c.run(id, task)
	return session.Hired{Session: &h}
}

func (c *taskFakeSessions) Tell(id, text string) string {
	c.mu.Lock()
	c.told[id] = append(c.told[id], text)
	c.mu.Unlock()
	c.f.Core.Apply(protocol.FactRun{ID: id})
	go c.run(id, text)
	return "说了"
}

func (c *taskFakeSessions) Dismiss(id string) bool {
	c.f.Core.Apply(protocol.FactLeft{ID: id})
	return true
}

func (c *taskFakeSessions) Find(id string) *session.Roster {
	h := c.f.Core.Session(id)
	if h == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return &session.Roster{Session: *h, LastText: c.last[id]}
}

func (c *taskFakeSessions) MergeInto(id, target string) ([]string, error) {
	return []string{"c0ffee-" + id}, nil
}

type taskFakeProjects struct {
	sessions *taskFakeSessions
	mu       sync.Mutex
	branches []string
}

var taskTestFile = regexp.MustCompile(`steps/(\w+)\.txt`)

func (p *taskFakeProjects) Run(_ context.Context, cwd, command string) (bool, string) {
	p.sessions.mu.Lock()
	defer p.sessions.mu.Unlock()
	for _, m := range taskTestFile.FindAllStringSubmatch(command, -1) {
		if !p.sessions.written[m[1]] {
			return false, "steps/" + m[1] + ".txt: no such file"
		}
	}
	return true, ""
}

func (p *taskFakeProjects) ChangedFiles(cwd, _ string) ([]string, error) {
	h := p.sessions.f.Core.Session(strings.TrimPrefix(cwd, "/wt/"))
	if h == nil || h.Graph == nil || h.Graph.Task == nil {
		return nil, nil
	}
	p.sessions.mu.Lock()
	defer p.sessions.mu.Unlock()
	return slices.Clone(p.sessions.touched[*h.Graph.Task]), nil
}

func (p *taskFakeProjects) OpenBranch(project, branch string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.branches = append(p.branches, branch)
	return nil
}

func (p *taskFakeProjects) MergeBranch(project, branch string) (string, error) {
	return "合进了 " + project + " 的 main", nil
}

func (p *taskFakeProjects) BranchChanges(project, branch string) (protocol.Changes, error) {
	return protocol.Changes{Project: project, Base: "main", Branch: &branch}, nil
}

type taskTestFarm struct {
	*world
	sessions *taskFakeSessions
	projects *taskFakeProjects
	mu       sync.Mutex
	facts    []protocol.TaskGraph
	closing  sync.Once
}

func (tf *taskTestFarm) Close() { tf.closing.Do(tf.world.Close) }

func newTaskTestFarm(t *testing.T, home string, release chan struct{}, before func(*world)) *taskTestFarm {
	t.Helper()
	f, err := newWorldWith(fixture.Config(home, t.TempDir(), ""), nil)
	if err != nil {
		t.Fatal(err)
	}
	tf := &taskTestFarm{world: f, sessions: newTaskFakeSessions(f, release)}
	tf.projects = &taskFakeProjects{sessions: tf.sessions}
	f.Task.sessions, f.Task.projects, f.Task.check = tf.sessions, tf.projects, func(a protocol.Agent) runtime.Assessment { return runtime.Assessment{Agent: a} }
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
			if fact, ok := e.Value.(protocol.FactIssue); ok && (fact.Issue.Graph != nil || fact.Issue.Parent != nil) {
				id := fact.Issue.ID
				if fact.Issue.Parent != nil {
					id = *fact.Issue.Parent
				}
				if graph := protocol.GraphOf(f.Core.State(), id); graph != nil {
					tf.mu.Lock()
					tf.facts = append(tf.facts, *graph)
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

func (tf *taskTestFarm) until(t *testing.T, id string, ready func(protocol.TaskGraph) bool) protocol.TaskGraph {
	t.Helper()
	return *testkit.Await(t, "task "+id+" gets there", func() (*protocol.TaskGraph, bool) {
		graph := protocol.GraphOf(tf.Core.State(), id)
		return graph, graph != nil && ready(*graph)
	})
}

var taskIDIn = regexp.MustCompile(`（(p\d+)）`)

func (tf *taskTestFarm) split(t *testing.T, goal, project string) string {
	t.Helper()
	said, err := tf.Task.Split(goal, project, "", protocol.GraphActorUser)
	if err != nil {
		t.Fatal(err)
	}
	m := taskIDIn.FindStringSubmatch(said)
	if m == nil {
		t.Fatal(said)
	}
	return m[1]
}

func (tf *taskTestFarm) act(t *testing.T, id string, action protocol.GraphAction) string {
	t.Helper()
	said, err := tf.Task.Act(id, action, protocol.GraphActorUser)
	if err != nil {
		t.Fatal(err)
	}
	return said
}

func taskIn(graph protocol.TaskGraph, id string) protocol.Task {
	if n := protocol.TaskOf(graph, id); n != nil {
		return *n
	}
	return protocol.Task{}
}

func taskState(graph protocol.TaskGraph, id string) protocol.TaskState {
	return taskIn(graph, id).State
}

func TestTaskDiamond(t *testing.T) {
	tf := newTaskTestFarm(t, t.TempDir(), nil, nil)
	news, stopNews := tf.Task.News().Subscribe()
	defer stopNews()
	id := tf.split(t, "菱形", "diamond")
	draft := tf.until(t, id, func(graph protocol.TaskGraph) bool {
		return graph.State == protocol.GraphStateDraft && !slices.ContainsFunc(tf.Core.State().Sessions, func(h protocol.Session) bool {
			return h.Graph != nil && h.Graph.ID == id
		})
	})
	var shape [][2]any
	for _, n := range draft.Tasks {
		shape = append(shape, [2]any{n.ID, strings.Join(n.Needs, ",")})
	}
	if fmt.Sprint(shape) != "[[a ] [b a] [c a] [d b,c]]" {
		t.Fatalf("draft: %v", shape)
	}
	if slices.ContainsFunc(tf.Core.State().Sessions, func(h protocol.Session) bool { return h.Graph != nil && h.Graph.ID == id }) {
		t.Fatal("the splitter went home with the draft")
	}
	if got := <-news; !strings.HasPrefix(got, "【种植计划】"+id+" 拆好了") {
		t.Fatalf("news: %s", got)
	}
	check := "test -f steps/b.txt && test -f steps/c.txt && test -f steps/d.txt"
	if _, err := tf.Task.EditTask(id, "d", protocol.TaskEdit{Check: &check}, protocol.GraphActorManager); err != nil {
		t.Fatal(err)
	}

	if said := tf.act(t, id, protocol.GraphActionStart); !strings.Contains(said, "开工了，分支 vibevalley/task-"+id+"-") {
		t.Fatal(said)
	}
	ripe := tf.until(t, id, func(graph protocol.TaskGraph) bool { return graph.State == protocol.GraphStateRipe })
	tf.mu.Lock()
	states := slices.DeleteFunc(slices.Clone(tf.facts), func(graph protocol.TaskGraph) bool { return graph.ID != id })
	tf.mu.Unlock()
	if !slices.ContainsFunc(states, func(graph protocol.TaskGraph) bool {
		return taskState(graph, "b") == protocol.TaskStateWorking && taskState(graph, "c") == protocol.TaskStateWorking
	}) {
		t.Fatal("b and c worked at the same time")
	}
	i := slices.IndexFunc(states, func(graph protocol.TaskGraph) bool { return taskState(graph, "d") == protocol.TaskStateWorking })
	if i < 0 || taskState(states[i], "b") != protocol.TaskStateMerged || taskState(states[i], "c") != protocol.TaskStateMerged {
		t.Fatal("d started after b and c were merged")
	}
	for _, n := range ripe.Tasks {
		if n.State != protocol.TaskStateMerged || len(n.Commits) == 0 || taskStr(n.Conclusion) != "写好了 steps/"+n.ID+".txt" || n.Session != nil {
			t.Fatalf("step %s: %+v", n.ID, n)
		}
	}
	if said := tf.act(t, id, protocol.GraphActionMerge); !strings.Contains(said, "合进了 diamond 的 main") {
		t.Fatal(said)
	}
	tf.until(t, id, func(graph protocol.TaskGraph) bool { return graph.State == protocol.GraphStateDone })

	history := tf.Task.Events(id)
	var task []string
	for _, e := range history {
		if e.Task == nil {
			task = append(task, string(e.Kind)+"/"+string(e.Actor))
		}
	}
	if want := "splitting/user drafted/system started/user ripe/system merged/user"; strings.Join(task, " ") != want {
		t.Fatalf("task history: %v", task)
	}
	edit := history[slices.IndexFunc(history, func(e protocol.GraphEvent) bool { return e.Kind == protocol.GraphEventKindTaskEdited })]
	if taskStr(edit.Task) != "d" || edit.Actor != protocol.GraphActorManager || edit.ActorText != "管家" || len(edit.Changes) != 1 || edit.Changes[0].Field != "检查" {
		t.Fatalf("edit: %+v", edit)
	}
	testkit.Match(t, edit.Text, `^改了「.+」的检查$`, "in words, the step by its title")
	for _, step := range []string{"a", "b", "c", "d"} {
		var way []string
		for _, e := range history {
			if taskStr(e.Task) == step && e.Kind != protocol.GraphEventKindTaskEdited {
				way = append(way, string(e.Kind))
			}
		}
		if strings.Join(way, " ") != "task_started task_merged" {
			t.Fatalf("step %s: %v", step, way)
		}
	}
	merged := history[slices.IndexFunc(history, func(e protocol.GraphEvent) bool {
		return taskStr(e.Task) == "a" && e.Kind == protocol.GraphEventKindTaskMerged
	})]
	if merged.Session == nil || len(merged.Commits) == 0 || taskStr(merged.Detail) != "写好了 steps/a.txt" {
		t.Fatalf("merged: %+v", merged)
	}
	for i := 1; i < len(history); i++ {
		if history[i].ID <= history[i-1].ID {
			t.Fatal("not in order")
		}
	}
}

func TestTaskAcceptanceFirst(t *testing.T) {
	tf := newTaskTestFarm(t, t.TempDir(), nil, nil)
	id := tf.split(t, "验收先行", "bug")
	draft := tf.until(t, id, func(graph protocol.TaskGraph) bool { return graph.State == protocol.GraphStateDraft })
	if !protocol.IsAcceptance(taskIn(draft, "repro")) || protocol.IsAcceptance(taskIn(draft, "fix")) {
		t.Fatalf("draft: %+v", draft.Tasks)
	}
	tf.act(t, id, protocol.GraphActionStart)
	ripe := tf.until(t, id, func(graph protocol.TaskGraph) bool { return graph.State == protocol.GraphStateRipe })

	repro, fix := taskIn(ripe, "repro"), taskIn(ripe, "fix")
	if fmt.Sprint(repro.Frozen) != "[steps/repro_test.txt]" || fix.Frozen != nil {
		t.Fatalf("frozen: %v, %v", repro.Frozen, fix.Frozen)
	}
	if repro.Tries != 1 || fix.Tries != 1 {
		t.Fatalf("tries: repro %d, fix %d", repro.Tries, fix.Tries)
	}
	tf.sessions.mu.Lock()
	defer tf.sessions.mu.Unlock()
	told := func(step string) string {
		for _, h := range tf.Core.State().Sessions {
			if h.Graph != nil && h.Graph.Task != nil && *h.Graph.Task == step {
				return strings.Join(tf.sessions.told[h.ID], "\n")
			}
		}
		return strings.Join(tf.sessions.told[map[string]string{"repro": "w2", "fix": "w3"}[step]], "\n")
	}
	if got := told("repro"); !strings.Contains(got, "现在就通过了") {
		t.Fatalf("repro was told: %s", got)
	}
	if got := told("fix"); !strings.Contains(got, "steps/repro_test.txt") || !strings.Contains(got, "冻结") {
		t.Fatalf("fix was told: %s", got)
	}
	task := taskBrief(ripe, fix)
	if !strings.Contains(task, "冻结的，不能改：steps/repro_test.txt") || !strings.Contains(task, "收尾的一步") {
		t.Fatalf("fix's task: %s", task)
	}
}

func TestGraphFailingTask(t *testing.T) {
	tf := newTaskTestFarm(t, t.TempDir(), nil, nil)
	id := tf.split(t, "有坏步", "shaky")
	tf.until(t, id, func(graph protocol.TaskGraph) bool { return graph.State == protocol.GraphStateDraft })
	tf.act(t, id, protocol.GraphActionStart)
	stuck := tf.until(t, id, func(graph protocol.TaskGraph) bool {
		return taskState(graph, "boom") == protocol.TaskStateFailed && taskState(graph, "flaky") == protocol.TaskStateMerged
	})
	if taskIn(stuck, "boom").Tries != protocol.AutoRetries {
		t.Fatalf("boom: sent back by itself, then left for you: %+v", taskIn(stuck, "boom"))
	}
	if taskIn(stuck, "flaky").Tries != 1 {
		t.Fatalf("flaky: its check failed once: %+v", taskIn(stuck, "flaky"))
	}
	if !slices.ContainsFunc(tf.Task.Events(id), func(e protocol.GraphEvent) bool {
		return e.Kind == protocol.GraphEventKindTaskSentBack && taskStr(e.Task) == "flaky" && e.Actor == protocol.GraphActorSystem &&
			strings.Contains(taskStr(e.Detail), "没通过")
	}) {
		t.Fatal("why it was sent back is kept")
	}
	if taskIn(stuck, "boom").Failures != 1 {
		t.Fatalf("boom failed once: %+v", taskIn(stuck, "boom"))
	}
	if _, err := tf.Task.TaskAct(id, "boom", protocol.TaskActionRetry, protocol.GraphActorUser); err != nil {
		t.Fatal(err)
	}
	stuck = tf.until(t, id, func(graph protocol.TaskGraph) bool {
		return taskState(graph, "boom") == protocol.TaskStateFailed && taskIn(graph, "boom").Failures == 2
	})
	var inbox []string
	for _, c := range protocol.Inbox(tf.Core.State()) {
		inbox = append(inbox, c.ID)
	}
	if !slices.Contains(inbox, id+":failed:boom:2") {
		t.Fatalf("the second failure is in the inbox again: %v", inbox)
	}
	after := taskIn(stuck, "after")
	if after.State != protocol.TaskStateWaiting || fmt.Sprint(protocol.BlockedBy(stuck, after)) != "[boom]" || stuck.State != protocol.GraphStateRunning {
		t.Fatalf("after: %+v, task %s", after, stuck.State)
	}
	if _, err := tf.Task.TaskAct(id, "nope", protocol.TaskActionSkip, protocol.GraphActorUser); err == nil || !strings.Contains(err.Error(), "没有「nope」") {
		t.Fatal(err)
	}
	skipped, err := tf.Task.TaskAct(id, "boom", protocol.TaskActionSkip, protocol.GraphActorUser)
	if err != nil || !strings.Contains(skipped, "跳过了") {
		t.Fatal(skipped, err)
	}
	ripe := tf.until(t, id, func(graph protocol.TaskGraph) bool { return graph.State == protocol.GraphStateRipe })
	var states []string
	for _, n := range ripe.Tasks {
		states = append(states, string(n.State))
	}
	if strings.Join(states, " ") != "skipped merged merged" {
		t.Fatal(states)
	}
	said := tf.act(t, id, protocol.GraphActionAbandon)
	gone := tf.until(t, id, func(graph protocol.TaskGraph) bool { return graph.State == protocol.GraphStateAbandoned })
	if gone.Branch == nil || !strings.Contains(said, "分支 "+*gone.Branch+" 留着") {
		t.Fatal(said)
	}
	if _, err := tf.Task.Act(id, protocol.GraphActionMerge, protocol.GraphActorUser); err == nil || !strings.Contains(err.Error(), "不能收获") {
		t.Fatal(err)
	}
}

func TestTaskSentBackOnce(t *testing.T) {
	tf := newTaskTestFarm(t, t.TempDir(), nil, nil)
	id := tf.split(t, "先给个圈", "circle")
	draft := tf.until(t, id, func(graph protocol.TaskGraph) bool { return graph.State == protocol.GraphStateDraft })
	if draft.Title != "改好了" || len(draft.Tasks) != 1 || draft.Tasks[0].ID != "fixed" {
		t.Fatalf("draft: %+v", draft)
	}
	_, err := tf.Task.EditTask(id, "fixed", protocol.TaskEdit{Needs: []string{"fixed"}}, protocol.GraphActorUser)
	if err == nil || !strings.Contains(err.Error(), "不能等自己") {
		t.Fatal(err)
	}
	if _, err := tf.Task.Changes(id); err == nil || !strings.Contains(err.Error(), "没有分支") {
		t.Fatal(err)
	}
	tf.act(t, id, protocol.GraphActionAbandon)
	if _, err := tf.Task.Split(" ", "x", "", protocol.GraphActorUser); err == nil {
		t.Fatal("an empty goal is refused")
	}
}

func TestTaskRestart(t *testing.T) {
	home := t.TempDir()
	release := make(chan struct{})
	defer close(release)
	first := newTaskTestFarm(t, home, release, nil)
	id := first.split(t, "慢", "slowpoke")
	first.until(t, id, func(graph protocol.TaskGraph) bool { return graph.State == protocol.GraphStateDraft })
	first.act(t, id, protocol.GraphActionStart)
	working := first.until(t, id, func(graph protocol.TaskGraph) bool { return taskState(graph, "slow") == protocol.TaskStateWorking })
	session := taskStr(taskIn(working, "slow").Session)
	first.Close()

	savedJSON := `{"hired":9,"hands":[{"id":"` + session + `","place":{"project":"` + working.Project + `","cwd":"` + t.TempDir() + `"}}]}`
	if err := os.WriteFile(filepath.Join(home, "sessions.json"), []byte(savedJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	second := newTaskTestFarm(t, home, release, nil)
	second.sessions.attempts["slow"] = 1
	paused := second.until(t, id, func(graph protocol.TaskGraph) bool { return graph.State == protocol.GraphStatePaused })
	if !strings.Contains(taskStr(paused.Note), "重启") {
		t.Fatal(taskStr(paused.Note))
	}
	second.act(t, id, protocol.GraphActionResume)
	ripe := second.until(t, id, func(graph protocol.TaskGraph) bool { return graph.State == protocol.GraphStateRipe })
	if taskState(ripe, "slow") != protocol.TaskStateMerged {
		t.Fatal(ripe)
	}
	if events := second.Task.Events(id); events[0].Kind != protocol.GraphEventKindSplitting {
		t.Fatal(events)
	}
}

func TestTaskChooseAgent(t *testing.T) {
	a := func(id, runtime string, tags ...string) protocol.Agent {
		return protocol.Agent{ID: id, Name: "名" + id, Runtime: runtime, Tags: tags}
	}
	cands := []session.Candidate{{Agent: a("x", "pi", "测试"), Usable: true}, {Agent: a("y", "claude", "前端", "页面"), Usable: true}, {Agent: a("z", "codex"), Usable: false}}
	for _, c := range []struct{ task, named, want string }{
		{"改页面的前端", "", "y"},
		{"随便", "", "x"},
		{"随便", "z", "z"},
		{"随便", "名y", "y"},
		{"随便", "claude", "y"},
		{"随便", "codex", "x"},
	} {
		if got := session.ChooseAgent(cands, c.task, c.named, ""); got == nil || got.ID != c.want {
			t.Errorf("%q named %q: %v, want %s", c.task, c.named, got, c.want)
		}
	}
	if session.ChooseAgent(cands[2:], "x", "", "") != nil {
		t.Error("no usable agent")
	}
	if got := str.Clip("  一二三\n四五  ", 4); got != "一二三…" {
		t.Error(got)
	}
	task := session.SplitBrief("做个打卡", "clock", []protocol.Agent{a("lab", "pi", "实验")})
	if !strings.Contains(task, "要做的事：做个打卡") || !strings.Contains(task, `"agent": "lab"`) || !strings.Contains(task, "  - lab：名lab，适合的活：实验") {
		t.Error(task)
	}
	if task := parseSplit(task); !task.OK || !protocol.IsAcceptance(task.Tasks[0]) {
		t.Errorf("the example: %+v", task)
	}
}

func TestTaskIsAParentIssue(t *testing.T) {
	tf := newTaskTestFarm(t, t.TempDir(), nil, nil)
	id := tf.split(t, "菱形", "diamond")
	tf.until(t, id, func(graph protocol.TaskGraph) bool { return graph.State == protocol.GraphStateDraft })
	parent, err := tf.Issue.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	if parent.Graph == nil || parent.Title != "菱形" || len(parent.Sessions) != 1 || parent.Status != protocol.IssueStatusInReview {
		t.Fatalf("the parent: %+v", parent)
	}
	d, err := tf.Issue.Get(protocol.TaskIssueID(id, "d"))
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
	if _, err := tf.Issue.Start(context.Background(), d.ID, ""); !errors.As(err, &refused) {
		t.Fatalf("a step started on the board: %v", err)
	}
	tf.act(t, id, protocol.GraphActionStart)
	tf.until(t, id, func(graph protocol.TaskGraph) bool { return graph.State == protocol.GraphStateRipe })
	a, _ := tf.Issue.Get(protocol.TaskIssueID(id, "a"))
	if len(a.Sessions) != 1 || a.Closed == nil || *a.Closed != protocol.IssueCloseMergedIntoGraph {
		t.Fatalf("a step done: %+v", a)
	}
	if got, _ := tf.Issue.Get(a.Sessions[0]); got.ID != a.ID {
		t.Fatalf("its session's issue: %s", got.ID)
	}
	if _, err := tf.Issue.Reopen(context.Background(), a.ID, "", ""); !errors.As(err, &refused) {
		t.Fatalf("a step reopened on the board: %v", err)
	}
	tf.act(t, id, protocol.GraphActionMerge)
	testkit.Until(t, "the task closed, harvested", func() bool {
		got, err := tf.Issue.Get(id)
		return err == nil && got.Closed != nil && *got.Closed == protocol.IssueCloseMerged
	})
}
