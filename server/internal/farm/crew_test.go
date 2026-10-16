package farm

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/farmtest"
	"vibevalley/internal/protocol"
	"vibevalley/internal/runs"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/oartest"
)

// No binary, login or model: smith's scripted runtime runs a real Session over real git repositories in temp folders.

func crewHelperGit(cwd string, args ...string) error {
	cmd := exec.Command("git", append([]string{"-c", "user.name=helper", "-c", "user.email=helper@vibevalley.test"}, args...)...)
	cmd.Dir = cwd
	return cmd.Run()
}

var crewVersion = regexp.MustCompile(`写版本(\w)`)

func crewScripted() oar.Runtime {
	return oartest.Runtime(oartest.Options{ID: "pi", Turn: func(turn *oartest.Turn) error {
		parts := strings.Split(turn.Input, runs.JobBreak)
		input := parts[len(parts)-1]
		if strings.Contains(input, "必败") {
			return errors.New("provider said no")
		}
		if strings.Contains(input, "发呆") {
			select {
			case <-time.After(1500 * time.Millisecond):
			case <-turn.Context.Done():
				return nil
			}
		}
		cwd := turn.Options.Cwd
		if m := crewVersion.FindStringSubmatch(input); m != nil {
			turn.Tool("bash", `{"command":"git commit"}`, func() (any, error) {
				os.WriteFile(filepath.Join(cwd, "same.ts"), []byte("export const v = '"+m[1]+"'\n"), 0o644)
				crewHelperGit(cwd, "add", "same.ts")
				return "", crewHelperGit(cwd, "commit", "-q", "-m", "版本 "+m[1])
			})
		}
		if strings.Contains(input, "有冲突") {
			turn.Tool("bash", `{"command":"git merge main"}`, func() (any, error) {
				crewHelperGit(cwd, "merge", "main")
				os.WriteFile(filepath.Join(cwd, "same.ts"), []byte("export const v = 'A+B'\n"), 0o644)
				crewHelperGit(cwd, "add", "same.ts")
				return "", crewHelperGit(cwd, "commit", "-q", "--no-edit")
			})
		}
		turn.Tool("bash", `{"command":"echo hi"}`, func() (any, error) { return "hi", nil })
		if strings.Contains(input, "提交") {
			turn.Tool("bash", `{"command":"git commit"}`, func() (any, error) {
				os.WriteFile(filepath.Join(cwd, "clock.ts"), []byte("export const clockIn = () => \"ok\"\n"), 0o644)
				crewHelperGit(cwd, "add", "clock.ts")
				return "", crewHelperGit(cwd, "commit", "-q", "-m", "加上打卡")
			})
		}
		notes := ""
		if strings.Contains(input, "记一笔") {
			notes = "\n\n记住：这个项目用 pnpm test 跑测试\n记住（所有项目）：提交信息写中文"
		}
		persona := "无"
		if turn.Options.AppendSystemPrompt != nil {
			persona = *turn.Options.AppendSystemPrompt
		}
		turn.Say("做完了：" + input + "｜人设：" + persona + notes)
		return nil
	}})
}

type crewWorld struct {
	f       *Farm
	current protocol.RuntimeInfo
	infoMu  sync.Mutex

	mu    sync.Mutex
	facts []protocol.FactValue
	notes []string
	taken int
	stop  func()
}

func crewOpen(t *testing.T, home, work string) *crewWorld {
	t.Helper()
	return crewOpenAt(t, home, work, ":memory:")
}

func crewOpenAt(t *testing.T, home, work, db string) *crewWorld {
	t.Helper()
	f, err := New(base.Config{Home: home, WorkRoot: work, DBPath: db})
	if err != nil {
		t.Fatal(err)
	}
	w := &crewWorld{f: f, current: farmtest.PiInfo()}
	registry, _ := oar.NewRuntimeRegistry(crewScripted())
	f.Runtimes.Registry = registry
	f.Runtimes.Probe = func(_ context.Context, id string) protocol.RuntimeInfo {
		if id != "pi" {
			return protocol.RuntimeInfo{ID: id, Installation: protocol.Installation{Value: protocol.InstallationNotFound{}}, Settings: f.Store.Settings(id)}
		}
		w.infoMu.Lock()
		defer w.infoMu.Unlock()
		return w.current
	}
	_, events, stopEvents := f.Site.Events()
	go func() {
		for e := range events {
			w.mu.Lock()
			switch v := e.Value.(type) {
			case protocol.FactValue:
				w.facts = append(w.facts, v)
			case protocol.SiteEventNotice:
				w.notes = append(w.notes, v.Text)
			}
			w.mu.Unlock()
		}
	}()
	ctx, cancel := context.WithCancel(context.Background())
	services := []base.Service{f.Ledger, f.Tokens, f.Runtimes, f.Commits, f.Trajectories, f.Projects, f.Crew, f.Issues, f.Dispatch, f.Merges}
	for _, s := range services {
		if err := s.OnStart(ctx); err != nil {
			t.Fatal(err)
		}
	}
	for _, s := range services {
		if r, ok := s.(interface{ OnReady(context.Context) }); ok {
			r.OnReady(ctx)
		}
	}
	once := sync.Once{}
	w.stop = func() {
		once.Do(func() {
			cancel()
			for i := len(services) - 1; i >= 0; i-- {
				services[i].OnStop()
			}
			stopEvents()
			f.Site.Close()
			f.DB.Close()
		})
	}
	t.Cleanup(w.stop)
	return w
}

func (w *crewWorld) setInfo(info protocol.RuntimeInfo) {
	w.infoMu.Lock()
	w.current = info
	w.infoMu.Unlock()
	w.f.Runtimes.Refresh(context.Background(), "pi")
}

func (w *crewWorld) seen() []protocol.FactValue {
	w.mu.Lock()
	defer w.mu.Unlock()
	return slices.Clone(w.facts)
}

type crewDone struct {
	outcome protocol.Outcome
	text    string
}

func (w *crewWorld) nextReport(t *testing.T) crewDone {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var reports []protocol.FactReport
		for _, f := range w.seen() {
			if r, ok := f.(protocol.FactReport); ok && r.Outcome != protocol.OutcomeInterrupted {
				reports = append(reports, r)
			}
		}
		if len(reports) > w.taken {
			r := reports[w.taken]
			w.taken++
			text := r.Summary
			if found := w.f.Crew.Find(r.ID); found != nil {
				text = found.LastText
			}
			return crewDone{r.Outcome, text}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("no report in 10 s")
	return crewDone{}
}

func crewHired(t *testing.T, h base.Hired) protocol.Helper {
	t.Helper()
	if h.Helper == nil {
		t.Fatalf("refused: %s", h.Refused)
	}
	return *h.Helper
}

func crewDirs(t *testing.T) (string, string) { return t.TempDir(), t.TempDir() }

func TestCrewHiredHelperWorksReportsAndGoesHome(t *testing.T) {
	home, work := crewDirs(t)
	w := crewOpen(t, home, work)
	helper := crewHired(t, w.f.Dispatch.Hire(context.Background(), farmtest.Lab(t), "写 hello.py", "demo", base.HireOptions{}))
	report := w.nextReport(t)
	w.f.Crew.Dismiss(helper.ID)
	time.Sleep(50 * time.Millisecond)

	farmtest.Eq(t, report.outcome, protocol.OutcomeCompleted, "outcome")
	farmtest.Match(t, report.text, `做完了：写 hello\.py`, "text")
	farmtest.Match(t, report.text, `原型`, "persona")

	facts := w.seen()
	var mine []protocol.FactValue
	for _, f := range facts {
		switch f.(type) {
		case protocol.FactCommits, protocol.FactIssue:
		default:
			mine = append(mine, f)
		}
	}
	if _, ok := mine[0].(protocol.FactHired); !ok {
		t.Fatalf("first: %T", mine[0])
	}
	if _, ok := mine[len(mine)-1].(protocol.FactLeft); !ok {
		t.Fatalf("last: %T", mine[len(mine)-1])
	}
	has := func(match func(protocol.FactValue) bool) bool { return slices.ContainsFunc(mine, match) }
	if !has(func(f protocol.FactValue) bool { _, ok := f.(protocol.FactTurn); return ok }) {
		t.Fatal("a turn")
	}
	if !has(func(f protocol.FactValue) bool {
		d, ok := f.(protocol.FactDoing)
		return ok && d.Action == protocol.WorkerActionRunCommand && d.Label == "echo hi"
	}) {
		t.Fatal("the command shows in the bubble")
	}
	if w.f.Runtimes.UsageAsked("pi") == 0 {
		t.Fatal("usage read again")
	}
	farmtest.Until(t, "commits recounted", func() bool { return w.f.Commits.Asked() > 0 })
}

func TestCrewRefusals(t *testing.T) {
	home, work := crewDirs(t)
	w := crewOpen(t, home, work)
	lab := farmtest.Lab(t)
	disabled := lab
	disabled.Enabled = false
	farmtest.Eq(t, w.f.Dispatch.Hire(context.Background(), disabled, "随便做点什么", "demo", base.HireOptions{}).Refused, lab.Name+" 被停用了", "disabled")
	farmtest.Match(t, w.f.Dispatch.Hire(context.Background(), lab, "随便做点什么", "../../etc", base.HireOptions{}).Refused, `不能当项目名`, "a plain folder")
	if w.f.Dispatch.Hire(context.Background(), lab, "随便做点什么", "", base.HireOptions{}).Refused == "" {
		t.Fatal("no project, no work")
	}
}

func TestCrewHarvestMergesAndClearsTheWorktree(t *testing.T) {
	home, work := crewDirs(t)
	w := crewOpen(t, home, work)
	helper := crewHired(t, w.f.Dispatch.Hire(context.Background(), farmtest.Lab(t), "写打卡并提交", "clock", base.HireOptions{}))
	w.nextReport(t)
	said := w.f.Merges.Harvest(helper.ID)
	if helper.Branch == nil || !strings.HasPrefix(*helper.Branch, "vibevalley/") {
		t.Fatal("it worked on a branch of its own")
	}
	farmtest.Match(t, said, `1 个提交合进了 clock 的 main`, "said")
	project := filepath.Join(work, "clock")
	farmtest.Match(t, farmtest.Git(t, project, "log", "--format=%s", "main"), `加上打卡`, "log")
	if _, err := os.Stat(filepath.Join(project, "clock.ts")); err != nil {
		t.Fatal("the file is in the project now")
	}
	farmtest.Eq(t, len(strings.Split(farmtest.Git(t, project, "worktree", "list"), "\n")), 1, "only the project itself is left")
}

func TestCrewHarvestGoesInTheLedger(t *testing.T) {
	home, work := crewDirs(t)
	w := crewOpen(t, home, work)
	helper := crewHired(t, w.f.Dispatch.Hire(context.Background(), farmtest.Lab(t), "写打卡并提交", "ledger", base.HireOptions{}))
	w.nextReport(t)
	w.f.Merges.Harvest(helper.ID)
	entries := func() int {
		var n int
		if err := w.f.DB.QueryRow(`select count(*) from ledger where kind = 'harvested' and payload like ?`, `%"helper":"`+helper.ID+`"%`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	farmtest.Until(t, "a harvested entry", func() bool { return entries() > 0 })
	farmtest.Eq(t, entries(), 1, "one harvested entry")
}

func TestCrewIssueClosesAndReopens(t *testing.T) {
	home, work := crewDirs(t)
	w := crewOpen(t, home, work)
	lab := farmtest.Lab(t)
	w.f.Store.SaveAgent(lab)
	helper := crewHired(t, w.f.Dispatch.Hire(context.Background(), lab, "写打卡并提交", "tickets", base.HireOptions{}))
	if helper.Issue == nil || !strings.HasPrefix(*helper.Issue, "t") {
		t.Fatalf("sent at once, it works an issue of its own: %+v", helper.Issue)
	}
	w.nextReport(t)
	var refused protocol.FarmRefused
	if _, err := w.f.Dispatch.Reopen(context.Background(), helper.ID, "", 0); !errors.As(err, &refused) {
		t.Fatalf("an open issue: %v", err)
	}
	w.f.Merges.Harvest(helper.ID)
	head := w.f.Trajectories.Get(helper.ID).Head
	if head.Closed == nil || *head.Closed != protocol.IssueCloseHarvested || head.Outcome == nil || *head.Outcome != protocol.OutcomeCompleted ||
		head.Summary == nil || head.Turns == nil || *head.Turns != 1 || head.Issue == nil || *head.Issue != *helper.Issue {
		t.Fatalf("closed: %+v", head)
	}
	closedAs := func(how protocol.IssueClose) func() bool {
		return func() bool {
			issue, err := w.f.Issues.Get(*helper.Issue)
			return err == nil && issue.Closed != nil && *issue.Closed == how
		}
	}
	farmtest.Until(t, "the issue closed with its run", closedAs(protocol.IssueCloseHarvested))

	again, err := w.f.Dispatch.Reopen(context.Background(), helper.ID, "打卡还要记下时区", 0)
	if err != nil {
		t.Fatal(err)
	}
	w.nextReport(t)
	issue, _ := w.f.Issues.Get(again)
	farmtest.Eq(t, issue.ID, *helper.Issue, "the same issue")
	farmtest.Eq(t, issue.Runs, []string{helper.ID, again}, "its runs")
	farmtest.Eq(t, issue.Closed == nil && issue.ClosedAt == nil, true, "open again")
	reopened := w.f.Trajectories.Get(again).Head
	farmtest.Match(t, *reopened.Job, `^打卡还要记下时区\n\n（这张工单重开了，上一次是 .+（`+helper.ID+`）做的。）`, "what to do now comes first")
	farmtest.Match(t, *reopened.Job, `这张工单原来是：写打卡并提交\n它是怎么关的：收获了`, "the job and how its last run closed")
	if _, err := w.f.Dispatch.Reopen(context.Background(), *helper.Issue, "", 0); !errors.As(err, &refused) {
		t.Fatalf("reopened while open: %v", err)
	}
	var missing protocol.FarmMissing
	if _, err := w.f.Dispatch.Reopen(context.Background(), "w404", "", 0); !errors.As(err, &missing) {
		t.Fatalf("no such issue: %v", err)
	}
	w.f.Crew.Dismiss(again)
	farmtest.Until(t, "sent home", closedAs(protocol.IssueCloseDismissed))
	if err := generated.New(w.f.DB).CloseIssue(context.Background(), generated.CloseIssueParams{
		ClosedAt: sql.NullInt64{Int64: base.NowMs(), Valid: true}, Closed: sql.NullString{String: string(protocol.IssueCloseMerged), Valid: true}, ID: issue.ID,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := w.f.Dispatch.Reopen(context.Background(), issue.ID, "", 0); !errors.As(err, &refused) || !strings.Contains(refused.Reason, "种植计划") {
		t.Fatalf("a playbook's step: %v", err)
	}
}

func TestCrewIssueWrittenDownStarts(t *testing.T) {
	home, work := crewDirs(t)
	w := crewOpen(t, home, work)
	lab := farmtest.Lab(t)
	w.f.Store.SaveAgent(lab)
	var refused protocol.FarmRefused
	if _, err := w.f.Issues.Add(protocol.IssueRequest{Title: "  "}); !errors.As(err, &refused) {
		t.Fatalf("an empty job: %v", err)
	}
	issue, err := w.f.Issues.Add(protocol.IssueRequest{Title: "写打卡并提交"})
	if err != nil {
		t.Fatal(err)
	}
	farmtest.Eq(t, issue.Status, protocol.IssueStatusTodo, "written down")
	inState := func(id string) *protocol.Issue {
		for _, x := range w.f.Site.State().Issues {
			if x.ID == id {
				return &x
			}
		}
		return nil
	}
	farmtest.Eq(t, inState(issue.ID).Title, "写打卡并提交", "in the core state as soon as it is written")
	if _, err := w.f.Dispatch.Start(context.Background(), issue.ID, 0); !errors.As(err, &refused) {
		t.Fatalf("no agent yet: %v", err)
	}
	project, agent := "backlog", lab.ID
	if issue, err = w.f.Issues.Edit(issue.ID, protocol.IssueRequest{Title: "写打卡并提交", Project: &project, Agent: &agent}); err != nil {
		t.Fatal(err)
	}
	farmtest.Eq(t, []string{*issue.Project, *issue.Agent}, []string{"backlog", lab.ID}, "edited")
	got, err := w.f.Dispatch.Start(context.Background(), issue.ID, 0)
	if err != nil || got.Helper == nil {
		t.Fatalf("started: %+v %v", got, err)
	}
	w.nextReport(t)
	farmtest.Eq(t, *w.f.Trajectories.Get(*got.Helper).Head.Job, "写打卡并提交", "its run's job")
	started, _ := w.f.Issues.Get(issue.ID)
	farmtest.Eq(t, started.Runs, []string{*got.Helper}, "the same issue, its run on it")
	farmtest.Eq(t, started.Status, protocol.IssueStatusWaiting, "its turn over")
	farmtest.Until(t, "the core state follows its run", func() bool {
		x := inState(issue.ID)
		return x != nil && len(x.Runs) == 1 && x.Status == protocol.IssueStatusWaiting
	})
	if _, err := w.f.Dispatch.Start(context.Background(), issue.ID, 0); !errors.As(err, &refused) {
		t.Fatalf("started twice: %v", err)
	}
	if _, err := w.f.Issues.Edit(issue.ID, protocol.IssueRequest{Title: "改不了了"}); !errors.As(err, &refused) {
		t.Fatalf("edited once started: %v", err)
	}
	unsent := func(all []protocol.Issue) (out []string) {
		for _, i := range all {
			if len(i.Runs) == 0 {
				out = append(out, i.Title)
			}
		}
		return out
	}
	urgent := protocol.PriorityUrgent
	a, _ := w.f.Issues.Add(protocol.IssueRequest{Title: "一"})
	b, _ := w.f.Issues.Add(protocol.IssueRequest{Title: "二", Priority: &urgent})
	c, _ := w.f.Issues.Add(protocol.IssueRequest{Title: "三"})
	farmtest.Eq(t, []protocol.Priority{a.Priority, b.Priority}, []protocol.Priority{protocol.PriorityNormal, protocol.PriorityUrgent}, "priorities")
	moved, err := w.f.Issues.Move(c.ID, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	farmtest.Eq(t, unsent(moved), []string{"三", "一", "二"}, "before another")
	moved, _ = w.f.Issues.Move(c.ID, "")
	farmtest.Eq(t, unsent(moved), []string{"一", "二", "三"}, "last")
	d, _ := w.f.Issues.Add(protocol.IssueRequest{Title: "四"})
	all, _ := w.f.Issues.List()
	farmtest.Eq(t, unsent(all)[3], d.Title, "a new one goes last")
	farmtest.Eq(t, all[len(all)-1].ID, issue.ID, "the started one after the ones not sent")
}

func TestCrewIssueWaitsForAFreeBed(t *testing.T) {
	t.Setenv("VIBEVALLEY_MAX_PER_PROJECT", "1")
	home, work := crewDirs(t)
	w := crewOpen(t, home, work)
	lab := farmtest.Lab(t)
	w.f.Store.SaveAgent(lab)
	project, agent := "queue", lab.ID
	w.f.Site.Apply(protocol.FactHired{Helper: protocol.Helper{
		ID: "w90", Name: "占地的", Agent: lab.ID, Runtime: lab.Runtime, Task: "先干着", Project: &project,
		Phase: protocol.Phase{Value: protocol.PhaseWorking{Since: base.NowMs(), Doing: protocol.Doing{}}},
	}})
	issue, _ := w.f.Issues.Add(protocol.IssueRequest{Title: "等空地的活", Project: &project, Agent: &agent})
	got, err := w.f.Dispatch.Start(context.Background(), issue.ID, 0)
	if err != nil || got.Helper != nil || got.Queued == nil || !strings.Contains(*got.Queued, "排上队了") {
		t.Fatalf("queued: %+v %v", got, err)
	}
	status := func() protocol.IssueStatus {
		now, _ := w.f.Issues.Get(issue.ID)
		return now.Status
	}
	farmtest.Eq(t, status(), protocol.IssueStatusQueued, "queued")
	w.f.Dispatch.TryQueued(context.Background())
	farmtest.Eq(t, status(), protocol.IssueStatusQueued, "waits")
	w.f.Site.Apply(protocol.FactLeft{ID: "w90"})
	w.f.Dispatch.TryQueued(context.Background())
	w.nextReport(t)
	farmtest.Eq(t, status(), protocol.IssueStatusWaiting, "started, its turn over")
	if !slices.ContainsFunc(w.f.Trajectories.List(lab.ID), func(h protocol.TrajectoryHead) bool { return h.Job != nil && *h.Job == "等空地的活" }) {
		t.Fatal("its run")
	}
	other, _ := w.f.Issues.Add(protocol.IssueRequest{Title: "别排了"})
	queued, _ := w.f.Issues.Queue(other.ID, true)
	unqueued, _ := w.f.Issues.Queue(other.ID, false)
	if queued.QueuedAt == nil || unqueued.QueuedAt != nil {
		t.Fatalf("queue and unqueue: %+v %+v", queued, unqueued)
	}
}

func TestCrewIssueAdoptsTheRunsOfBefore(t *testing.T) {
	home, work := crewDirs(t)
	agent, harvested, dismissed := "lab", protocol.IssueCloseHarvested, protocol.IssueCloseDismissed
	ended := int64(2000)
	heads := []protocol.TrajectoryHead{
		{ID: "w1", Name: "一号", Agent: &agent, Job: new("写打卡"), StartedAt: 1000, EndedAt: &ended, Closed: &harvested, ReopenedAs: new("w2")},
		{ID: "w2", Name: "二号", Agent: &agent, Job: new("打卡还要记下时区"), StartedAt: 3000, ReopenedFrom: new("w1")},
		{ID: "w3", Name: "三号", Agent: &agent, Job: new("画个图"), StartedAt: 4000, EndedAt: &ended, Closed: &dismissed},
		{ID: "w4", Name: "四号", StartedAt: 5000},
	}
	if err := os.MkdirAll(filepath.Join(home, "steps"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, h := range heads {
		body, _ := json.Marshal(h)
		if err := os.WriteFile(filepath.Join(home, "steps", h.ID+".head.json"), body, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	db := filepath.Join(home, "farm.db")
	for range 2 { // and again after a restart: nothing twice
		w := crewOpenAt(t, home, work, db)
		all, err := w.f.Issues.List()
		if err != nil {
			t.Fatal(err)
		}
		farmtest.Eq(t, len(all), 2, "one issue per chain of runs, none for no agent")
		farmtest.Eq(t, len(w.f.Site.State().Issues), 2, "back in the core state")
		first, _ := w.f.Issues.Get("w2")
		farmtest.Eq(t, first.ID, "w1", "named after its first run")
		farmtest.Eq(t, first.Title, "写打卡", "its first job")
		farmtest.Eq(t, first.Runs, []string{"w1", "w2"}, "its runs")
		farmtest.Eq(t, first.Closed == nil && first.ClosedAt == nil, true, "open while its last run is")
		other, _ := w.f.Issues.Get("w3")
		farmtest.Eq(t, other.Closed != nil && *other.Closed == dismissed && *other.ClosedAt == ended, true, "closed as its run")
		w.f.Close()
	}
}

func TestCrewTicketKnowsItsPlaybook(t *testing.T) {
	home, work := crewDirs(t)
	w := crewOpen(t, home, work)
	node := "impl"
	helper := crewHired(t, w.f.Dispatch.Hire(context.Background(), farmtest.Lab(t), "做一步", "planned", base.HireOptions{Playbook: &protocol.HelperPlaybook{ID: "p1", Node: &node}}))
	head := w.f.Trajectories.Get(helper.ID).Head
	if head.Playbook == nil || head.Playbook.ID != "p1" || head.Playbook.Node == nil || *head.Playbook.Node != "impl" {
		t.Fatalf("the ticket's playbook: %+v", head.Playbook)
	}
}

func TestCrewRestartHelpersComeBackResting(t *testing.T) {
	home, work := crewDirs(t)
	lab := farmtest.Lab(t)
	first := crewOpen(t, home, work)
	// Waking reads the agent from the store, as in real use: keep the script-friendly one there.
	first.f.Store.SaveAgent(lab)
	helper := crewHired(t, first.f.Dispatch.Hire(context.Background(), lab, "先写一点并提交", "survivor", base.HireOptions{}))
	first.nextReport(t)
	time.Sleep(50 * time.Millisecond)
	first.stop()

	second := crewOpen(t, home, work)
	back := second.f.Crew.Find(helper.ID)
	if back == nil {
		t.Fatal("the helper came back")
	}
	if _, ok := back.Helper.Phase.Value.(protocol.PhaseRipe); !ok {
		t.Fatalf("as it was: its turn had finished (%T)", back.Helper.Phase.Value)
	}
	farmtest.Eq(t, back.Place.Branch, *helper.Branch, "on its own branch still")
	farmtest.Match(t, second.f.Crew.Tell(helper.ID, "再加一句并提交"), `醒了`, "woke")
	second.nextReport(t)
	farmtest.Match(t, second.f.Merges.Harvest(helper.ID), `个提交合进了 survivor 的 main`, "harvested")
}

func TestCrewEveryStepKeptInItsTrajectory(t *testing.T) {
	home, work := crewDirs(t)
	w := crewOpen(t, home, work)
	lab := farmtest.Lab(t)
	helper := crewHired(t, w.f.Dispatch.Hire(context.Background(), lab, "看看目录", "steps", base.HireOptions{}))
	w.nextReport(t)
	steps, _ := w.f.Crew.Steps(helper.ID)
	w.f.Crew.Dismiss(helper.ID)
	after := w.f.Trajectories.Get(helper.ID)
	if after == nil {
		t.Fatal("the trajectory outlives the helper")
	}
	farmtest.Eq(t, []string{*after.Head.Job, *after.Head.Agent, *after.Head.Project}, []string{"看看目录", lab.ID, "steps"}, "head")
	if after.Head.EndedAt == nil {
		t.Fatal("ended")
	}
	kinds := func(steps []protocol.WorkStep) []protocol.StepKind {
		var out []protocol.StepKind
		for _, s := range steps {
			out = append(out, s.Kind)
		}
		return out
	}
	want := []protocol.StepKind{protocol.StepKindAsked, protocol.StepKindTool, protocol.StepKindSaid}
	farmtest.Eq(t, kinds(after.Steps), want, "kept")
	if !slices.ContainsFunc(w.f.Trajectories.List(lab.ID), func(h protocol.TrajectoryHead) bool { return h.ID == helper.ID }) {
		t.Fatal("listed")
	}
	farmtest.Eq(t, kinds(steps), want, "steps")
	farmtest.Eq(t, steps[0].Text, "看看目录", "asked")
	farmtest.Eq(t, []string{string(*steps[1].Action), steps[1].Text, *steps[1].Output}, []string{"run_command", "echo hi", "hi"}, "tool")
	farmtest.Eq(t, *steps[1].Ok, true, "ok")
	farmtest.Match(t, steps[2].Text, `做完了：看看目录`, "said")
}

func TestCrewCommentOnAStep(t *testing.T) {
	home, work := crewDirs(t)
	w := crewOpen(t, home, work)
	helper := crewHired(t, w.f.Dispatch.Hire(context.Background(), farmtest.Lab(t), "看看目录", "comments", base.HireOptions{}))
	w.nextReport(t)
	steps, _ := w.f.Crew.Steps(helper.ID)
	tool := steps[1]
	told := runs.CommentText(tool, "这里换成 ls -la 再看一遍")
	farmtest.Match(t, told, `^【评论第 1 步】关于你这一步的操作：echo hi`, "names the step")
	farmtest.Match(t, told, `输出的结尾：hi\n\n我的评论：这里换成 ls -la 再看一遍$`, "the step's output, then the comment")
	w.f.Crew.Tell(helper.ID, told)
	w.nextReport(t)
	steps, _ = w.f.Crew.Steps(helper.ID)
	i := slices.IndexFunc(steps, func(s protocol.WorkStep) bool { return s.Kind == protocol.StepKindAsked && s.N > tool.N })
	if i < 0 || steps[i].On == nil || *steps[i].On != tool.N {
		t.Fatalf("the comment is tied to step %d: %+v", tool.N, steps)
	}
}

func TestCrewFailedTurnSaysWhy(t *testing.T) {
	home, work := crewDirs(t)
	w := crewOpen(t, home, work)
	helper := crewHired(t, w.f.Dispatch.Hire(context.Background(), farmtest.Lab(t), "这一单必败", "fails", base.HireOptions{}))
	report := w.nextReport(t)
	w.f.Crew.Dismiss(helper.ID)
	farmtest.Eq(t, report.outcome, protocol.OutcomeFailed, "outcome")
	farmtest.Match(t, report.text, `provider said no`, "why")
	if strings.Contains(report.text, `{"`) {
		t.Fatal("not a JSON dump")
	}
}

func TestCrewNobodySentWhenMoneyRunsOut(t *testing.T) {
	home, work := crewDirs(t)
	w := crewOpen(t, home, work)
	hire := func() base.Hired {
		return w.f.Dispatch.Hire(context.Background(), farmtest.Lab(t), "随便做点什么", "money", base.HireOptions{})
	}
	info := farmtest.PiInfo()

	broke := info
	broke.Usage = protocol.AccountUsage{Value: protocol.AccountUsageBalance{Provider: "DeepSeek", Available: true, Balances: []protocol.Balance{{Currency: "CNY", Amount: 0}}}}
	w.setInfo(broke)
	farmtest.Match(t, hire().Refused, `余额用完了`, "balance")

	capped := info
	capped.Settings.DailyBudget, capped.SpentToday = farmtest.Ptr[float64](1), farmtest.Ptr[float64](1.2)
	w.setInfo(capped)
	farmtest.Match(t, hire().Refused, `每日预算 ¥1\.00`, "budget")

	// A window used up would only fail with a quota error.
	resets := time.Date(2026, 10, 14, 8, 0, 0, 0, time.Local).UnixMilli()
	week := protocol.UsageWindow{Label: "Codex · 1 week", UsedPercent: 100, ResetsAt: &resets}
	used := info
	used.Usage = protocol.AccountUsage{Value: protocol.AccountUsageOk{Plan: farmtest.Ptr("pro"), Windows: []protocol.UsageWindow{{Label: "5h", UsedPercent: 40}, week}}}
	w.setInfo(used)
	farmtest.Match(t, hire().Refused, `额度用完了（Codex · 1 week），10 月 14 日 08:00重置`, "window")

	week.UsedPercent = 99
	almost := info
	almost.Usage = protocol.AccountUsage{Value: protocol.AccountUsageOk{Plan: farmtest.Ptr("pro"), Windows: []protocol.UsageWindow{week}}}
	w.setInfo(almost)
	farmtest.Eq(t, hire().Refused, "", "a window not quite used up is fine")

	under := info
	under.Settings.DailyBudget, under.SpentToday = farmtest.Ptr[float64](1), farmtest.Ptr[float64](0.4)
	w.setInfo(under)
	farmtest.Eq(t, hire().Refused, "", "under the budget is fine")
}

func TestCrewQuietHelperIsFlagged(t *testing.T) {
	t.Setenv("VIBEVALLEY_STALL_SECONDS", "0.5")
	home, work := crewDirs(t)
	w := crewOpen(t, home, work)
	helper := crewHired(t, w.f.Dispatch.Hire(context.Background(), farmtest.Lab(t), "先发呆一会儿", "quiet", base.HireOptions{}))
	time.Sleep(time.Second)
	found := w.f.Crew.Find(helper.ID)
	need := protocol.NeedOf(found.Helper)
	if need == nil || need.Kind != "quiet" || base.NowMs()-need.Since < 500 {
		t.Fatalf("the manager sees how long it has been quiet: %+v", need)
	}
	w.nextReport(t)
	steps, _ := w.f.Crew.Steps(helper.ID)
	w.f.Crew.Dismiss(helper.ID)
	w.mu.Lock()
	notes := slices.Clone(w.notes)
	w.mu.Unlock()
	if !slices.ContainsFunc(notes, func(s string) bool { return strings.Contains(s, "没动静") }) {
		t.Fatalf("the farm is told: %v", notes)
	}
	if !slices.ContainsFunc(steps, func(s protocol.WorkStep) bool {
		return s.Kind == protocol.StepKindProblem && strings.Contains(s.Text, "没动静")
	}) {
		t.Fatal("its steps say so")
	}
}

func TestCrewChangesBeforeAHarvest(t *testing.T) {
	home, work := crewDirs(t)
	w := crewOpen(t, home, work)
	helper := crewHired(t, w.f.Dispatch.Hire(context.Background(), farmtest.Lab(t), "写打卡并提交", "preview", base.HireOptions{}))
	w.nextReport(t)
	changes, err := w.f.Merges.Changes(helper.ID)
	if err != nil || changes == nil {
		t.Fatalf("changes: %v", err)
	}
	w.f.Crew.Dismiss(helper.ID)
	farmtest.Eq(t, changes.Base, "main", "base")
	farmtest.Eq(t, len(changes.Commits), 1, "commits")
	farmtest.Eq(t, changes.Commits[0].Subject, "加上打卡", "subject")
	farmtest.Eq(t, len(changes.Files), 1, "files")
	file := changes.Files[0]
	farmtest.Eq(t, []any{file.Path, file.Status, file.Added}, []any{"clock.ts", "A", int64(1)}, "file")
	farmtest.Match(t, *file.Patch, `\+export const clockIn`, "patch")
	farmtest.Eq(t, len(changes.Conflicts), 0, "conflicts")
	farmtest.Eq(t, len(changes.Uncommitted), 0, "uncommitted")
}

func TestCrewConflictingBranchStaysUntilResolved(t *testing.T) {
	home, work := crewDirs(t)
	w := crewOpen(t, home, work)
	lab := farmtest.Lab(t)
	w.f.Store.SaveAgent(lab)
	a := crewHired(t, w.f.Dispatch.Hire(context.Background(), lab, "写版本A并提交", "clash", base.HireOptions{}))
	b := crewHired(t, w.f.Dispatch.Hire(context.Background(), lab, "写版本B并提交", "clash", base.HireOptions{}))
	w.nextReport(t)
	w.nextReport(t)
	farmtest.Match(t, w.f.Merges.Harvest(a.ID), `个提交合进了 clash 的 main`, "first")
	preview, _ := w.f.Merges.Changes(b.ID)
	farmtest.Eq(t, preview.Conflicts, []string{"same.ts"}, "the preview saw it coming")
	farmtest.Match(t, w.f.Merges.Harvest(b.ID), `会冲突（same\.ts）`, "second")
	stayed := w.f.Crew.Find(b.ID)
	if stayed == nil {
		t.Fatal("the helper is still on the farm")
	}
	farmtest.Eq(t, *stayed.Helper.Conflict, protocol.Conflict{Base: "main", Files: []string{"same.ts"}}, "flag")
	w.f.Crew.Tell(b.ID, "合进 main 有冲突，请解决")
	w.nextReport(t)
	farmtest.Match(t, w.f.Merges.Harvest(b.ID), `合进了 clash 的 main`, "third")
	project := filepath.Join(work, "clash")
	farmtest.Eq(t, farmtest.Git(t, project, "show", "main:same.ts"), "export const v = 'A+B'", "both versions")
	farmtest.Eq(t, farmtest.Git(t, project, "status", "--porcelain"), "", "main is clean: nothing half-merged")
}

func TestCrewLimitsOnProjectAndRuntime(t *testing.T) {
	home, work := crewDirs(t)
	w := crewOpen(t, home, work)
	lab := farmtest.Lab(t)
	ctx := context.Background()
	var busy []protocol.Helper
	for _, i := range []string{"1", "2", "3"} {
		busy = append(busy, crewHired(t, w.f.Dispatch.Hire(ctx, lab, "发呆 "+i, "crowded", base.HireOptions{})))
	}
	farmtest.Match(t, w.f.Dispatch.Hire(ctx, lab, "发呆 4", "crowded", base.HireOptions{}).Refused, `项目 crowded 里已经有 3 个帮工在干活`, "project")
	three := protocol.DefaultSettings()
	three.MaxWorking = farmtest.Ptr[int64](3)
	w.f.Store.SaveSettings("pi", three)
	farmtest.Match(t, w.f.Dispatch.Hire(ctx, lab, "发呆 5", "roomy", base.HireOptions{}).Refused, `最多同时 3 个`, "runtime")
	w.f.Store.SaveSettings("pi", protocol.DefaultSettings())
	for range 3 {
		w.nextReport(t)
	}
	later := crewHired(t, w.f.Dispatch.Hire(ctx, lab, "随便做点什么", "crowded", base.HireOptions{}))
	w.nextReport(t)
	for _, h := range append(busy, later) {
		w.f.Crew.Dismiss(h.ID)
	}
}

func TestCrewTwoSentToANewProjectAtOnce(t *testing.T) {
	home, work := crewDirs(t)
	w := crewOpen(t, home, work)
	lab := farmtest.Lab(t)
	both := make([]base.Hired, 2)
	var group sync.WaitGroup
	for i := range both {
		group.Go(func() {
			both[i] = w.f.Dispatch.Hire(context.Background(), lab, "随便做点什么", "twins", base.HireOptions{})
		})
	}
	group.Wait()
	for _, h := range both {
		crewHired(t, h)
	}
	w.nextReport(t)
	w.nextReport(t)
	farmtest.Eq(t, len(w.f.Crew.Roster()), 2, "both on the farm")
	w.f.Crew.DismissAll()
	farmtest.Eq(t, len(w.f.Crew.Roster()), 0, "all gone home")
}

func TestCrewActivityAndTokens(t *testing.T) {
	home, work := crewDirs(t)
	w := crewOpen(t, home, work)
	activity, stop := w.f.Crew.Activity().Subscribe()
	defer stop()
	helper := crewHired(t, w.f.Dispatch.Hire(context.Background(), farmtest.Lab(t), "看看", "talk", base.HireOptions{}))
	var kinds []string
	timeout := time.After(10 * time.Second)
	for !slices.Contains(kinds, "ended") {
		select {
		case a := <-activity:
			if a.ID == helper.ID {
				kinds = append(kinds, a.Kind)
			}
		case <-timeout:
			t.Fatalf("activity: %v", kinds)
		}
	}
	farmtest.Eq(t, kinds, []string{"spoke", "ended"}, "the turn spoke, then ended")
	issued := w.f.Tokens.Issue(helper.ID)
	farmtest.Eq(t, w.f.Tokens.Who(issued), helper.ID, "who")
	delivered := w.f.Crew.Deliver(helper.ID, "再看看")
	farmtest.Eq(t, delivered.Kind, "turn", "a new turn")
	w.nextReport(t)
	w.nextReport(t)
	w.f.Crew.Dismiss(helper.ID)
	if w.f.Tokens.Who(issued) != "" {
		t.Fatal("its token goes with it")
	}
}
