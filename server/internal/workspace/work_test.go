package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/internal/session"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/oartest"
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/ptr"
)

// No binary, login or model: smith's scripted runtime runs a real Session over real git repositories in temp folders.

func sessionGit(cwd string, args ...string) error {
	cmd := exec.Command("git", append([]string{"-c", "user.name=session", "-c", "user.email=session@vibevalley.test"}, args...)...)
	cmd.Dir = cwd
	return cmd.Run()
}

var version = regexp.MustCompile(`写版本(\w)`)

func scripted() oar.Runtime {
	return oartest.Runtime(oartest.Options{ID: "pi", Turn: func(turn *oartest.Turn) error {
		parts := strings.Split(turn.Input, session.JobBreak)
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
		if m := version.FindStringSubmatch(input); m != nil {
			turn.Tool("bash", `{"command":"git commit"}`, func() (any, error) {
				os.WriteFile(filepath.Join(cwd, "same.ts"), []byte("export const v = '"+m[1]+"'\n"), 0o644)
				sessionGit(cwd, "add", "same.ts")
				return "", sessionGit(cwd, "commit", "-q", "-m", "版本 "+m[1])
			})
		}
		if strings.Contains(input, "有冲突") {
			turn.Tool("bash", `{"command":"git merge main"}`, func() (any, error) {
				sessionGit(cwd, "merge", "main")
				os.WriteFile(filepath.Join(cwd, "same.ts"), []byte("export const v = 'A+B'\n"), 0o644)
				sessionGit(cwd, "add", "same.ts")
				return "", sessionGit(cwd, "commit", "-q", "--no-edit")
			})
		}
		turn.Tool("bash", `{"command":"echo hi"}`, func() (any, error) { return "hi", nil })
		if strings.Contains(input, "提交") {
			turn.Tool("bash", `{"command":"git commit"}`, func() (any, error) {
				os.WriteFile(filepath.Join(cwd, "clock.ts"), []byte("export const clockIn = () => \"ok\"\n"), 0o644)
				sessionGit(cwd, "add", "clock.ts")
				return "", sessionGit(cwd, "commit", "-q", "-m", "加上打卡")
			})
		}
		notes := ""
		if strings.Contains(input, "先问清楚") && !strings.Contains(input, "用 8797") {
			notes += "\n\n要问主人：用 8787 还是 8797？"
		}
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

type testWorld struct {
	f       *Workspace
	current protocol.RuntimeInfo
	infoMu  sync.Mutex

	mu    sync.Mutex
	facts []protocol.FactValue
	notes []string
	taken int
	stop  func()
}

func openWorld(t *testing.T, home, work string, change ...func(*base.Config)) *testWorld {
	t.Helper()
	return openWorldAt(t, home, work, ":memory:", change...)
}

func openWorldAt(t *testing.T, home, work, db string, change ...func(*base.Config)) *testWorld {
	t.Helper()
	cfg := fixture.Config(home, work, db)
	for _, f := range change {
		f(&cfg)
	}
	f, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	f.Project.GitHubProbe = fixture.NoGitHub
	w := &testWorld{f: f, current: fixture.Pi()}
	registry, _ := oar.NewRuntimeRegistry(scripted())
	f.Runtime.Registry = registry
	f.Runtime.Probe = func(_ context.Context, id string) protocol.RuntimeInfo {
		if id != "pi" {
			return protocol.RuntimeInfo{ID: id, Installation: protocol.Installation{Value: protocol.InstallationNotFound{}}, Settings: f.Agent.Settings(id)}
		}
		w.infoMu.Lock()
		defer w.infoMu.Unlock()
		return w.current
	}
	_, events, stopEvents := f.Core.Events()
	go func() {
		for e := range events {
			w.mu.Lock()
			switch v := e.Value.(type) {
			case protocol.FactValue:
				w.facts = append(w.facts, v)
			case protocol.SideEventNotice:
				w.notes = append(w.notes, v.Text)
			}
			w.mu.Unlock()
		}
	}()
	ctx, cancel := context.WithCancel(context.Background())
	services := []base.Service{f.Game, f.Runtime, f.Project, f.Session, f.Issue}
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
			f.Core.Close()
			f.Close()
		})
	}
	t.Cleanup(w.stop)
	return w
}

func (w *testWorld) setInfo(info protocol.RuntimeInfo) {
	w.infoMu.Lock()
	w.current = info
	w.infoMu.Unlock()
	w.f.Runtime.Refresh(context.Background(), "pi")
}

func (w *testWorld) seen() []protocol.FactValue {
	w.mu.Lock()
	defer w.mu.Unlock()
	return slices.Clone(w.facts)
}

type done struct {
	outcome protocol.Outcome
	text    string
}

func (w *testWorld) nextReport(t *testing.T) done {
	t.Helper()
	r := testkit.Await(t, "the next report", func() (protocol.FactReport, bool) {
		var reports []protocol.FactReport
		for _, f := range w.seen() {
			if r, ok := f.(protocol.FactReport); ok && r.Outcome != protocol.OutcomeInterrupted {
				reports = append(reports, r)
			}
		}
		if len(reports) > w.taken {
			return reports[w.taken], true
		}
		return protocol.FactReport{}, false
	})
	w.taken++
	text := r.Summary
	if found := w.f.Session.Find(r.ID); found != nil {
		text = found.LastText
	}
	return done{r.Outcome, text}
}

func mustHire(t *testing.T, h session.Hired) protocol.Session {
	t.Helper()
	if h.Session == nil {
		t.Fatalf("refused: %s", h.Refused)
	}
	return *h.Session
}

func dirs(t *testing.T) (string, string) { return t.TempDir(), t.TempDir() }

func TestHiredSessionWorksReportsAndGoesHome(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	session := mustHire(t, w.f.Issue.Hire(context.Background(), fixture.Lab(t), "写 hello.py", "demo", session.HireOptions{}))
	report := w.nextReport(t)
	w.f.Session.Dismiss(session.ID)
	testkit.Until(t, "it went home", func() bool {
		return slices.ContainsFunc(w.seen(), func(f protocol.FactValue) bool { _, ok := f.(protocol.FactLeft); return ok })
	})

	testkit.Eq(t, report.outcome, protocol.OutcomeCompleted, "outcome")
	testkit.Match(t, report.text, `做完了：写 hello\.py`, "text")
	testkit.Match(t, report.text, `原型`, "persona")

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
	if !has(func(f protocol.FactValue) bool { _, ok := f.(protocol.FactRun); return ok }) {
		t.Fatal("a turn")
	}
	if !has(func(f protocol.FactValue) bool {
		d, ok := f.(protocol.FactDoing)
		return ok && d.Action == protocol.SessionActionRunCommand && d.Label == "echo hi"
	}) {
		t.Fatal("the command shows in the bubble")
	}
	if w.f.Runtime.UsageAsked("pi") == 0 {
		t.Fatal("usage read again")
	}
	testkit.Until(t, "commits recounted", func() bool { return w.f.Game.Asked() > 0 })
}

func TestRefusals(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	lab := fixture.Lab(t)
	disabled := lab
	disabled.Enabled = false
	testkit.Eq(t, w.f.Issue.Hire(context.Background(), disabled, "随便做点什么", "demo", session.HireOptions{}).Refused, lab.Name+" 被停用了", "disabled")
	testkit.Match(t, w.f.Issue.Hire(context.Background(), lab, "随便做点什么", "../../etc", session.HireOptions{}).Refused, `不能当项目名`, "a plain folder")
	if w.f.Issue.Hire(context.Background(), lab, "随便做点什么", "", session.HireOptions{}).Refused == "" {
		t.Fatal("no project, no work")
	}
}

func TestMergeClearsTheWorktree(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	session := mustHire(t, w.f.Issue.Hire(context.Background(), fixture.Lab(t), "写打卡并提交", "clock", session.HireOptions{}))
	w.nextReport(t)
	said, err := w.f.Issue.Merge(*session.Issue)
	if err != nil {
		t.Fatal(err)
	}
	if session.Branch == nil || !strings.HasPrefix(*session.Branch, "vibevalley/") {
		t.Fatal("it worked on a branch of its own")
	}
	testkit.Match(t, said, `1 个提交合进了 clock 的 main`, "said")
	project := filepath.Join(work, "projects", "clock")
	testkit.Match(t, testkit.Git(t, project, "log", "--format=%s", "main"), `加上打卡`, "log")
	if _, err := os.Stat(filepath.Join(project, "clock.ts")); err != nil {
		t.Fatal("the file is in the project now")
	}
	testkit.Eq(t, len(strings.Split(testkit.Git(t, project, "worktree", "list"), "\n")), 1, "only the project itself is left")
}

func TestMergeGoesInTheLedger(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	session := mustHire(t, w.f.Issue.Hire(context.Background(), fixture.Lab(t), "写打卡并提交", "ledger", session.HireOptions{}))
	w.nextReport(t)
	w.f.Issue.Merge(*session.Issue)
	entries := func() int {
		var n int
		if err := w.f.DB.QueryRow(`select count(*) from game_ledger where kind = 'harvested' and payload like ?`, `%"session":"`+session.ID+`"%`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	testkit.Until(t, "a harvested entry", func() bool { return entries() > 0 })
	testkit.Eq(t, entries(), 1, "one harvested entry")
}

func TestIssueClosesAndReopens(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	lab := fixture.Lab(t)
	w.f.Agent.SaveAgent(lab)
	session := mustHire(t, w.f.Issue.Hire(context.Background(), lab, "写打卡并提交", "clock-in", session.HireOptions{}))
	if session.Issue == nil || *session.Issue == "" {
		t.Fatalf("sent at once, it works an issue of its own: %+v", session.Issue)
	}
	w.nextReport(t)
	var refused protocol.Refused
	if _, err := w.f.Issue.Reopen(context.Background(), session.ID, "", ""); !errors.As(err, &refused) {
		t.Fatalf("an open issue: %v", err)
	}
	w.f.Issue.Merge(*session.Issue)
	ended := w.f.Session.Get(session.ID)
	if closed, ok := ended.Phase.Value.(protocol.PhaseClosed); !ok || closed.Closed != protocol.IssueCloseMerged || ended.LastRun == nil ||
		ended.LastRun.Outcome != protocol.OutcomeCompleted || ended.LastRun.Summary == "" || ended.Runs != 1 || ended.Issue == nil || *ended.Issue != *session.Issue {
		t.Fatalf("closed: %+v", ended)
	}
	closedAs := func(how protocol.IssueClose) func() bool {
		return func() bool {
			issue, err := w.f.Issue.Get(*session.Issue)
			return err == nil && issue.Closed != nil && *issue.Closed == how
		}
	}
	testkit.Until(t, "the issue closed with its run", closedAs(protocol.IssueCloseMerged))

	again, err := w.f.Issue.Reopen(context.Background(), session.ID, "打卡还要记下时区", "")
	if err != nil {
		t.Fatal(err)
	}
	w.nextReport(t)
	issue, _ := w.f.Issue.Get(again)
	testkit.Eq(t, issue.ID, *session.Issue, "the same issue")
	testkit.Eq(t, issue.Sessions, []string{session.ID, again}, "its runs")
	testkit.Eq(t, issue.Closed == nil && issue.ClosedAt == nil, true, "open again")
	reopened := w.f.Session.Get(again)
	testkit.Match(t, reopened.Brief, `^打卡还要记下时区\n\n（这张工单重开了，上一次是 .+（`+session.ID+`）做的。）`, "what to do now comes first")
	testkit.Match(t, reopened.Brief, `这张工单原来是：写打卡并提交\n它是怎么关的：收获了`, "the job and how its last run closed")
	if _, err := w.f.Issue.Reopen(context.Background(), *session.Issue, "", ""); !errors.As(err, &refused) {
		t.Fatalf("reopened while open: %v", err)
	}
	var missing protocol.Missing
	if _, err := w.f.Issue.Reopen(context.Background(), "w404", "", ""); !errors.As(err, &missing) {
		t.Fatalf("no such issue: %v", err)
	}
	w.f.Session.Dismiss(again)
	testkit.Until(t, "sent home", closedAs(protocol.IssueCloseDismissed))
	if err := generated.New(w.f.DB).CloseIssue(context.Background(), generated.CloseIssueParams{
		ClosedAt: sql.NullInt64{Int64: clock.NowMs(), Valid: true}, Closed: sql.NullString{String: string(protocol.IssueCloseMergedIntoGraph), Valid: true}, ID: issue.ID,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := w.f.Issue.Reopen(context.Background(), issue.ID, "", ""); !errors.As(err, &refused) || !strings.Contains(refused.Reason, "种植计划") {
		t.Fatalf("a task's step: %v", err)
	}
}

func TestIssueWrittenDownStarts(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	lab := fixture.Lab(t)
	w.f.Agent.SaveAgent(lab)
	var refused protocol.Refused
	if _, err := w.f.Issue.Add(protocol.IssueRequest{Title: "  "}); !errors.As(err, &refused) {
		t.Fatalf("an empty job: %v", err)
	}
	issue, err := w.f.Issue.Add(protocol.IssueRequest{Title: "写打卡并提交"})
	if err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, issue.Status, protocol.IssueStatusBacklog, "written down")
	inState := func(id string) *protocol.Issue {
		for _, x := range w.f.Core.State().Issues {
			if x.ID == id {
				return &x
			}
		}
		return nil
	}
	testkit.Eq(t, inState(issue.ID).Title, "写打卡并提交", "in the core state as soon as it is written")
	if _, err := w.f.Issue.Start(context.Background(), issue.ID, ""); !errors.As(err, &refused) {
		t.Fatalf("no agent yet: %v", err)
	}
	project, agent := "backlog", lab.ID
	if issue, err = w.f.Issue.Edit(issue.ID, protocol.IssueUpdate{Project: &project, Assignee: &agent}); err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, []string{*issue.Project, *issue.Assignee}, []string{"backlog", lab.ID}, "edited")
	got, err := w.f.Issue.Start(context.Background(), issue.ID, "")
	if err != nil || got.Session == nil {
		t.Fatalf("started: %+v %v", got, err)
	}
	w.nextReport(t)
	testkit.Eq(t, w.f.Session.Get(*got.Session).Brief, "写打卡并提交", "its run's job")
	started, _ := w.f.Issue.Get(issue.ID)
	testkit.Eq(t, started.Sessions, []string{*got.Session}, "the same issue, its run on it")
	testkit.Eq(t, started.Status, protocol.IssueStatusInReview, "its turn over")
	testkit.Until(t, "the core state follows its run", func() bool {
		x := inState(issue.ID)
		return x != nil && len(x.Sessions) == 1 && x.Status == protocol.IssueStatusInReview
	})
	if _, err := w.f.Issue.Start(context.Background(), issue.ID, ""); !errors.As(err, &refused) {
		t.Fatalf("started twice: %v", err)
	}
	if _, err := w.f.Issue.Edit(issue.ID, protocol.IssueUpdate{Title: new("改不了了")}); !errors.As(err, &refused) {
		t.Fatalf("edited once started: %v", err)
	}
	unsent := func(all []protocol.Issue) (out []string) {
		for _, i := range all {
			if len(i.Sessions) == 0 {
				out = append(out, i.Title)
			}
		}
		return out
	}
	urgent := protocol.PriorityUrgent
	a, _ := w.f.Issue.Add(protocol.IssueRequest{Title: "一"})
	b, _ := w.f.Issue.Add(protocol.IssueRequest{Title: "二", Priority: &urgent})
	c, _ := w.f.Issue.Add(protocol.IssueRequest{Title: "三"})
	testkit.Eq(t, []protocol.Priority{a.Priority, b.Priority}, []protocol.Priority{protocol.PriorityMedium, protocol.PriorityUrgent}, "priorities")
	moved, err := w.f.Issue.Move(c.ID, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, unsent(moved), []string{"三", "一", "二"}, "before another")
	moved, _ = w.f.Issue.Move(c.ID, "")
	testkit.Eq(t, unsent(moved), []string{"一", "二", "三"}, "last")
	d, _ := w.f.Issue.Add(protocol.IssueRequest{Title: "四"})
	all, _ := w.f.Issue.List()
	testkit.Eq(t, unsent(all)[3], d.Title, "a new one goes last")
	testkit.Eq(t, all[len(all)-1].ID, issue.ID, "the started one after the ones not sent")
}

func TestIssueWaitsForAFreeBed(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work, func(c *base.Config) { c.Project.MaxSessions = 1 })
	lab := fixture.Lab(t)
	w.f.Agent.SaveAgent(lab)
	project, agent := "queue", lab.ID
	w.f.Core.Apply(protocol.FactHired{Session: protocol.Session{
		ID: "w90", Name: "占地的", Agent: lab.ID, Runtime: lab.Runtime, Brief: "先干着", Project: &project,
		Phase: protocol.Phase{Value: protocol.PhaseWorking{Since: clock.NowMs(), Doing: protocol.Doing{}}},
	}})
	issue, _ := w.f.Issue.Add(protocol.IssueRequest{Title: "等空地的活", Project: &project, Assignee: &agent})
	got, err := w.f.Issue.Start(context.Background(), issue.ID, "")
	if err != nil || got.Session != nil || got.Queued == nil || !strings.Contains(*got.Queued, "排上队了") {
		t.Fatalf("queued: %+v %v", got, err)
	}
	status := func() protocol.IssueStatus {
		now, _ := w.f.Issue.Get(issue.ID)
		return now.Status
	}
	testkit.Eq(t, status(), protocol.IssueStatusTodo, "queued")
	w.f.Issue.TryQueued(context.Background())
	testkit.Eq(t, status(), protocol.IssueStatusTodo, "waits")
	w.f.Core.Apply(protocol.FactLeft{ID: "w90"})
	w.f.Issue.TryQueued(context.Background())
	w.nextReport(t)
	testkit.Eq(t, status(), protocol.IssueStatusInReview, "started, its turn over")
	records, err := w.f.Session.List(lab.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.ContainsFunc(records, func(s protocol.Session) bool { return s.Brief == "等空地的活" }) {
		t.Fatal("its run")
	}
	other, _ := w.f.Issue.Add(protocol.IssueRequest{Title: "别排了"})
	queued, _ := w.f.Issue.Queue(other.ID, true)
	unqueued, _ := w.f.Issue.Queue(other.ID, false)
	if queued.QueuedAt == nil || unqueued.QueuedAt != nil {
		t.Fatalf("queue and unqueue: %+v %+v", queued, unqueued)
	}
}

func TestIssueKnowsItsTask(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	node := "impl"
	session := mustHire(t, w.f.Issue.Hire(context.Background(), fixture.Lab(t), "做一步", "split", session.HireOptions{TaskGraph: &protocol.SessionGraph{ID: "p1", Task: &node}}))
	head := w.f.Session.Get(session.ID)
	if head.Graph == nil || head.Graph.ID != "p1" || head.Graph.Task == nil || *head.Graph.Task != "impl" {
		t.Fatalf("the issue's task: %+v", head.Graph)
	}
}

func TestRestartSessionsComeBackResting(t *testing.T) {
	home, work := dirs(t)
	lab := fixture.Lab(t)
	db := filepath.Join(home, "vibevalley.db")
	first := openWorldAt(t, home, work, db)
	// Waking reads the agent from the store, as in real use: keep the script-friendly one there.
	first.f.Agent.SaveAgent(lab)
	session := mustHire(t, first.f.Issue.Hire(context.Background(), lab, "先写一点并提交", "survivor", session.HireOptions{}))
	first.nextReport(t)
	first.stop()

	second := openWorldAt(t, home, work, db)
	back := second.f.Session.Find(session.ID)
	if back == nil {
		t.Fatal("the session came back")
	}
	if _, ok := back.Session.Phase.Value.(protocol.PhaseRipe); !ok {
		t.Fatalf("as it was: its turn had finished (%T)", back.Session.Phase.Value)
	}
	testkit.Eq(t, back.Place.Branch, *session.Branch, "on its own branch still")
	testkit.Match(t, second.f.Session.Tell(session.ID, "再加一句并提交", protocol.RunTrigger{Kind: protocol.RunTriggerKindComment}), `醒了`, "woke")
	second.nextReport(t)
	testkit.Match(t, mustMerge(t, second.f, *session.Issue), `个提交合进了 survivor 的 main`, "merged")
}

func TestEveryStepKeptInItsTrajectory(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	lab := fixture.Lab(t)
	session := mustHire(t, w.f.Issue.Hire(context.Background(), lab, "看看目录", "steps", session.HireOptions{}))
	w.nextReport(t)
	steps := w.f.Session.Events(session.ID, "")
	w.f.Session.Dismiss(session.ID)
	after := w.f.Session.Get(session.ID)
	if after == nil {
		t.Fatal("the trajectory outlives the session")
	}
	testkit.Eq(t, []string{after.Brief, after.Agent, *after.Project}, []string{"看看目录", lab.ID, "steps"}, "who it was")
	if _, ok := after.Phase.Value.(protocol.PhaseClosed); !ok {
		t.Fatal("ended")
	}
	kinds := func(steps []protocol.SessionEvent) []protocol.SessionEventType {
		var out []protocol.SessionEventType
		for _, s := range steps {
			out = append(out, s.Type)
		}
		return out
	}
	want := []protocol.SessionEventType{protocol.SessionEventTypeRunStart, protocol.SessionEventTypeUserMessage, protocol.SessionEventTypeToolCall,
		protocol.SessionEventTypeToolResult, protocol.SessionEventTypeAssistantMessage, protocol.SessionEventTypeRunEnd}
	testkit.Eq(t, kinds(w.f.Session.Events(session.ID, "")), want, "kept")
	for _, e := range w.f.Session.Events(session.ID, "") {
		if e.Run == nil || *e.Run != *w.f.Session.Events(session.ID, "")[0].Run {
			t.Fatalf("an event outside the run: %+v", e)
		}
	}
	testkit.Eq(t, w.f.Session.Events(session.ID, "")[len(w.f.Session.Events(session.ID, ""))-1].Text, string(protocol.OutcomeCompleted), "the run's end says how it ended")
	records, err := w.f.Session.List(lab.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.ContainsFunc(records, func(s protocol.Session) bool { return s.ID == session.ID }) {
		t.Fatal("listed")
	}
	testkit.Eq(t, kinds(steps), want, "steps")
	testkit.Eq(t, steps[1].Text, "看看目录", "asked")
	testkit.Eq(t, []string{string(*steps[2].Action), steps[2].Text}, []string{"run_command", "echo hi"}, "the call")
	testkit.Eq(t, []any{*steps[3].Call, *steps[3].Output, *steps[3].Ok}, []any{steps[2].Seq, "hi", true}, "its result")
	testkit.Match(t, steps[4].Text, `做完了：看看目录`, "said")
}

func TestFailedRunSaysWhy(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	session := mustHire(t, w.f.Issue.Hire(context.Background(), fixture.Lab(t), "这一单必败", "fails", session.HireOptions{}))
	report := w.nextReport(t)
	w.f.Session.Dismiss(session.ID)
	testkit.Eq(t, report.outcome, protocol.OutcomeFailed, "outcome")
	testkit.Match(t, report.text, `provider said no`, "why")
	if strings.Contains(report.text, `{"`) {
		t.Fatal("not a JSON dump")
	}
}

func TestNobodySentWhenMoneyRunsOut(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	hire := func() session.Hired {
		return w.f.Issue.Hire(context.Background(), fixture.Lab(t), "随便做点什么", "money", session.HireOptions{})
	}
	info := fixture.Pi()

	broke := info
	broke.Usage = protocol.AccountUsage{Value: protocol.AccountUsageBalance{Provider: "DeepSeek", Available: true, Balances: []protocol.Balance{{Currency: "CNY", Amount: 0}}}}
	w.setInfo(broke)
	testkit.Match(t, hire().Refused, `余额用完了`, "balance")

	capped := info
	capped.Settings.DailyBudget = ptr.To[float64](1)
	w.f.Runtime.Spend(capped.ID, 1.2)
	w.setInfo(capped)
	testkit.Match(t, hire().Refused, `每日预算 ¥1\.00`, "budget")

	// A window used up would only fail with a quota error.
	resets := time.Date(2026, 10, 14, 8, 0, 0, 0, time.Local).UnixMilli()
	week := protocol.UsageWindow{Label: "Codex · 1 week", UsedPercent: 100, ResetsAt: &resets}
	used := info
	used.Usage = protocol.AccountUsage{Value: protocol.AccountUsageOk{Subscription: ptr.To("pro"), Windows: []protocol.UsageWindow{{Label: "5h", UsedPercent: 40}, week}}}
	w.setInfo(used)
	testkit.Match(t, hire().Refused, `额度用完了（Codex · 1 week），10 月 14 日 08:00重置`, "window")

	week.UsedPercent = 99
	almost := info
	almost.Usage = protocol.AccountUsage{Value: protocol.AccountUsageOk{Subscription: ptr.To("pro"), Windows: []protocol.UsageWindow{week}}}
	w.setInfo(almost)
	testkit.Eq(t, hire().Refused, "", "a window not quite used up is fine")

	under := info
	under.Settings.DailyBudget = ptr.To[float64](2)
	w.setInfo(under)
	testkit.Eq(t, hire().Refused, "", "under the budget is fine")
}

func TestQuietSessionIsFlagged(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work, func(c *base.Config) { c.Session.StallSeconds = 0.5 })
	session := mustHire(t, w.f.Issue.Hire(context.Background(), fixture.Lab(t), "先发呆一会儿", "quiet", session.HireOptions{}))
	testkit.Await(t, "the manager sees it has been quiet half a second", func() (*protocol.Need, bool) {
		need := protocol.NeedOf(w.f.Session.Find(session.ID).Session)
		return need, need != nil && need.Kind == "quiet" && clock.NowMs()-need.Since >= 500
	})
	w.nextReport(t)
	steps := w.f.Session.Events(session.ID, "")
	w.f.Session.Dismiss(session.ID)
	w.mu.Lock()
	notes := slices.Clone(w.notes)
	w.mu.Unlock()
	if !slices.ContainsFunc(notes, func(s string) bool { return strings.Contains(s, "没动静") }) {
		t.Fatalf("the farm is told: %v", notes)
	}
	if !slices.ContainsFunc(steps, func(s protocol.SessionEvent) bool {
		return s.Type == protocol.SessionEventTypeRunError && strings.Contains(s.Text, "没动静")
	}) {
		t.Fatal("its steps say so")
	}
}

func TestChangesBeforeAMerge(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	session := mustHire(t, w.f.Issue.Hire(context.Background(), fixture.Lab(t), "写打卡并提交", "preview", session.HireOptions{}))
	w.nextReport(t)
	changes, err := w.f.Issue.Changes(*session.Issue, protocol.CallerManager)
	if err != nil {
		t.Fatalf("changes: %v", err)
	}
	w.f.Session.Dismiss(session.ID)
	testkit.Eq(t, changes.Base, "main", "base")
	testkit.Eq(t, len(changes.Commits), 1, "commits")
	testkit.Eq(t, changes.Commits[0].Subject, "加上打卡", "subject")
	testkit.Eq(t, len(changes.Files), 1, "files")
	file := changes.Files[0]
	testkit.Eq(t, []any{file.Path, file.Status, file.Added}, []any{"clock.ts", "A", int64(1)}, "file")
	testkit.Match(t, *file.Patch, `\+export const clockIn`, "patch")
	testkit.Eq(t, len(changes.Conflicts), 0, "conflicts")
	testkit.Eq(t, len(changes.Uncommitted), 0, "uncommitted")
}

func TestConflictingBranchStaysUntilResolved(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	lab := fixture.Lab(t)
	w.f.Agent.SaveAgent(lab)
	a := mustHire(t, w.f.Issue.Hire(context.Background(), lab, "写版本A并提交", "clash", session.HireOptions{}))
	b := mustHire(t, w.f.Issue.Hire(context.Background(), lab, "写版本B并提交", "clash", session.HireOptions{}))
	w.nextReport(t)
	w.nextReport(t)
	testkit.Match(t, mustMerge(t, w.f, *a.Issue), `个提交合进了 clash 的 main`, "first")
	preview, _ := w.f.Issue.Changes(*b.Issue, protocol.CallerManager)
	testkit.Eq(t, preview.Conflicts, []string{"same.ts"}, "the preview saw it coming")
	_, mergeErr := w.f.Issue.Merge(*b.Issue)
	if mergeErr == nil {
		t.Fatal("conflicting harvest must return an error")
	}
	testkit.Match(t, mergeErr.Error(), `会冲突（same\.ts）`, "second")
	stayed := w.f.Session.Find(b.ID)
	if stayed == nil {
		t.Fatal("the session is still on the farm")
	}
	testkit.Eq(t, *stayed.Session.Conflict, protocol.Conflict{Base: "main", Files: []string{"same.ts"}}, "flag")
	if err := w.f.Issue.Resolve(*a.Issue); err == nil {
		t.Fatal("a session with nothing in the way was asked to resolve")
	}
	// The owner's 让它解决冲突: the server says which conflicts, in the owner's words.
	if err := w.f.Issue.Resolve(*b.Issue); err != nil {
		t.Fatal(err)
	}
	w.nextReport(t)
	testkit.Match(t, mustMerge(t, w.f, *b.Issue), `合进了 clash 的 main`, "third")
	project := filepath.Join(work, "projects", "clash")
	testkit.Eq(t, testkit.Git(t, project, "show", "main:same.ts"), "export const v = 'A+B'", "both versions")
	testkit.Eq(t, testkit.Git(t, project, "status", "--porcelain"), "", "main is clean: nothing half-merged")
}

func TestLimitsOnProjectAndRuntime(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	lab := fixture.Lab(t)
	ctx := context.Background()
	var busy []protocol.Session
	for _, i := range []string{"1", "2", "3"} {
		busy = append(busy, mustHire(t, w.f.Issue.Hire(ctx, lab, "发呆 "+i, "crowded", session.HireOptions{})))
	}
	testkit.Match(t, w.f.Issue.Hire(ctx, lab, "发呆 4", "crowded", session.HireOptions{}).Refused, `项目 crowded 里已经有 3 个帮工在干活`, "project")
	three := protocol.DefaultSettings()
	three.MaxWorking = ptr.To[int64](3)
	w.f.Agent.SaveSettings("pi", three)
	testkit.Match(t, w.f.Issue.Hire(ctx, lab, "发呆 5", "roomy", session.HireOptions{}).Refused, `最多同时 3 个`, "runtime")
	w.f.Agent.SaveSettings("pi", protocol.DefaultSettings())
	for range 3 {
		w.nextReport(t)
	}
	later := mustHire(t, w.f.Issue.Hire(ctx, lab, "随便做点什么", "crowded", session.HireOptions{}))
	w.nextReport(t)
	for _, h := range append(busy, later) {
		w.f.Session.Dismiss(h.ID)
	}
}

func TestTwoSentToANewProjectAtOnce(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	lab := fixture.Lab(t)
	both := make([]session.Hired, 2)
	var group sync.WaitGroup
	for i := range both {
		group.Go(func() {
			both[i] = w.f.Issue.Hire(context.Background(), lab, "随便做点什么", "twins", session.HireOptions{})
		})
	}
	group.Wait()
	for _, h := range both {
		mustHire(t, h)
	}
	w.nextReport(t)
	w.nextReport(t)
	testkit.Eq(t, len(w.f.Session.Roster()), 2, "both on the farm")
	for _, h := range w.f.Core.State().Sessions {
		w.f.Session.Dismiss(h.ID)
	}
	testkit.Eq(t, len(w.f.Session.Roster()), 0, "all gone home")
}

func TestActivityAndTokens(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	activity, stop := w.f.Session.Launches().Subscribe()
	defer stop()
	session := mustHire(t, w.f.Issue.Hire(context.Background(), fixture.Lab(t), "看看", "talk", session.HireOptions{}))
	var kinds []string
	timeout := time.After(10 * time.Second)
	for !slices.Contains(kinds, "ended") {
		select {
		case a := <-activity:
			if a.ID == session.ID {
				kinds = append(kinds, a.Kind)
			}
		case <-timeout:
			t.Fatalf("activity: %v", kinds)
		}
	}
	testkit.Eq(t, kinds, []string{"spoke", "ended"}, "the turn spoke, then ended")
	issued := w.f.Session.Issue(session.ID)
	testkit.Eq(t, w.f.Session.Who(issued), session.ID, "who")
	delivered := w.f.Session.Deliver(session.ID, "再看看", protocol.RunTrigger{Kind: protocol.RunTriggerKindComment})
	testkit.Eq(t, delivered.Kind, "run", "a new run")
	w.nextReport(t)
	w.nextReport(t)
	w.f.Session.Dismiss(session.ID)
	if w.f.Session.Who(issued) != "" {
		t.Fatal("its token goes with it")
	}
}

func TestRunsKeepWhatStartedEachRun(t *testing.T) {
	home, work := dirs(t)
	db := filepath.Join(home, "vibevalley.db")
	first := openWorldAt(t, home, work, db)
	lab := fixture.Lab(t)
	first.f.Agent.SaveAgent(lab)
	session := mustHire(t, first.f.Issue.Hire(context.Background(), lab, "写打卡并提交", "runs", session.HireOptions{}))
	first.nextReport(t)
	said := protocol.RunTrigger{Kind: protocol.RunTriggerKindComment, Message: ptr.To("m42")}
	testkit.Match(t, first.f.Session.Tell(session.ID, "再看看", said), `新的一轮`, "a second turn")
	first.nextReport(t)
	runs := func(w *testWorld) []protocol.Run {
		r, err := w.f.Session.Runs(*session.Issue)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	got := testkit.Await(t, "two runs ended", func() ([]protocol.Run, bool) {
		r := runs(first)
		return r, len(r) == 2 && r[1].EndedAt != nil
	})
	testkit.Eq(t, got[0].TriggeredBy.Kind, protocol.RunTriggerKindIssue, "the first is the issue sent out")
	testkit.Eq(t, *got[0].Outcome, protocol.OutcomeCompleted, "and it is done")
	testkit.Eq(t, got[1].TriggeredBy, said, "the second is the comment")

	first.f.Session.Tell(session.ID, "发呆一会儿", protocol.RunTrigger{Kind: protocol.RunTriggerKindComment})
	testkit.Until(t, "a third run going", func() bool { return len(runs(first)) == 3 })
	more := "m43"
	testkit.Eq(t, first.f.Session.Deliver(session.ID, "顺便看看", protocol.RunTrigger{Kind: protocol.RunTriggerKindComment, Message: &more}).Kind, "steered", "said while it works")
	testkit.Eq(t, runs(first)[2].Heard, []string{more}, "heard by the run going")
	first.stop()
	second := openWorldAt(t, home, work, db)
	testkit.Eq(t, *runs(second)[2].Outcome, protocol.OutcomeInterrupted, "the restart stopped it")
}

func TestAScheduleKeepsOneIssue(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	enabled := fixture.Lab(t)
	enabled.Enabled = true
	w.f.Agent.SaveAgent(enabled)
	var now atomic.Int64
	now.Store(clock.NowMs())
	w.f.Schedule.Now = now.Load
	lab, project := "lab", "every"
	made, err := w.f.Schedule.Add(protocol.ScheduleRequest{Name: "巡检", Text: "看一眼", Agent: &lab, Project: &project, When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenEvery{Minutes: 5}}}, protocol.ScheduleByOwner, true)
	if err != nil {
		t.Fatal(err)
	}
	due := func() {
		now.Add(5*60_000 + 1)
		w.f.Schedule.Tick()
	}
	ofSchedule := func() protocol.Issue {
		i, ok := w.f.Issue.OfSchedule(made.ID)
		if !ok {
			t.Fatal("no issue for the schedule")
		}
		return i
	}
	runs := func() []protocol.Run {
		r, err := w.f.Session.Runs(ofSchedule().ID)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	due()
	w.nextReport(t)
	first := ofSchedule()
	testkit.Eq(t, len(first.Sessions), 1, "a session sent")

	due()
	w.nextReport(t)
	testkit.Eq(t, ofSchedule().ID, first.ID, "the same issue")
	testkit.Eq(t, len(ofSchedule().Sessions), 1, "the same session, told again")
	testkit.Until(t, "a second run", func() bool { return len(runs()) == 2 && runs()[1].EndedAt != nil })
	testkit.Eq(t, runs()[1].TriggeredBy.Kind, protocol.RunTriggerKindSchedule, "started by the schedule")

	w.f.Issue.Merge(first.ID)
	testkit.Until(t, "merged", func() bool { return ofSchedule().Status == protocol.IssueStatusDone })
	due()
	w.nextReport(t)
	testkit.Eq(t, ofSchedule().ID, first.ID, "reopened, not a new one")
	testkit.Eq(t, len(ofSchedule().Sessions), 2, "a new session for it")
	testkit.Until(t, "a third run", func() bool { return len(runs()) == 3 })
	testkit.Eq(t, runs()[2].TriggeredBy.Kind, protocol.RunTriggerKindSchedule, "started by the schedule too")
}

// Whoever sees a session arrive can find its issue: the link is written before the session goes on the farm.
func TestASessionsIssueIsThereWhenItArrives(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	_, events, stop := w.f.Core.Events()
	defer stop()
	found := make(chan error, 1)
	go func() {
		for e := range events {
			if hired, ok := e.Value.(protocol.FactHired); ok {
				_, err := w.f.Issue.Get(hired.Session.ID)
				found <- err
				return
			}
		}
	}()
	mustHire(t, w.f.Issue.Hire(context.Background(), fixture.Lab(t), "看看目录", "arrives", session.HireOptions{}))
	if err := <-found; err != nil {
		t.Fatalf("its issue when it arrived: %v", err)
	}
	w.nextReport(t)
}

func TestIssueUpdateChangesOnlyWhatItGives(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	high := protocol.PriorityHigh
	issue, err := w.f.Issue.Add(protocol.IssueRequest{Title: "写打卡", Description: "每天一次", Project: new("demo"), Assignee: new("lab"), Priority: &high})
	if err != nil {
		t.Fatal(err)
	}
	issue, err = w.f.Issue.Edit(issue.ID, protocol.IssueUpdate{Title: new("写打卡并提交")})
	if err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, []any{issue.Title, issue.Description, *issue.Project, *issue.Assignee, issue.Priority}, []any{"写打卡并提交", "每天一次", "demo", "lab", protocol.PriorityHigh}, "the rest kept")
	issue, err = w.f.Issue.Edit(issue.ID, protocol.IssueUpdate{Project: new("")})
	if err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, []any{issue.Project == nil, *issue.Assignee}, []any{true, "lab"}, "an empty project is none")
}

// A session is a row from when it is sent: listed with the ones on the farm once it has ended, closed, its runs counted.
// An ended session's log goes after session.trajectory_days, its row stays.
func TestEndedSessionsAreRows(t *testing.T) {
	home, work := dirs(t)
	dir := filepath.Join(home, "events")
	os.MkdirAll(dir, 0o755)
	lab := fixture.Lab(t)
	w := openWorld(t, home, work)
	s := mustHire(t, w.f.Issue.Hire(context.Background(), lab, "看看目录", "rows", session.HireOptions{}))
	w.nextReport(t)
	w.f.Session.Dismiss(s.ID)
	got := w.f.Session.Get(s.ID)
	if closed, ok := got.Phase.Value.(protocol.PhaseClosed); !ok || closed.Closed != protocol.IssueCloseDismissed || got.Runs != 1 || got.LastRun == nil {
		t.Fatalf("ended: %+v", got)
	}
	var ids []string
	all, err := w.f.Session.List("")
	if err != nil {
		t.Fatal(err)
	}
	for _, x := range all {
		ids = append(ids, x.ID)
	}
	testkit.Eq(t, ids, []string{s.ID}, "newest first")
	matching, err := w.f.Session.List(lab.ID)
	if err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, len(matching), 1, "by agent")
}

func mustMerge(t *testing.T, f *Workspace, id string) string {
	t.Helper()
	said, err := f.Issue.Merge(id)
	if err != nil {
		t.Fatal(err)
	}
	return said
}

// The owner only moves the issue: todo sends it out, todo again is another round, done merges; the dropped one comes back.
func TestMovingAnIssueIsTheWork(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	lab := fixture.Lab(t)
	w.f.Agent.SaveAgent(lab)
	move := func(id string, to protocol.IssueStatus, text string) (protocol.Issue, error) {
		return w.f.Issue.SetStatus(context.Background(), id, to, text, "")
	}
	project := "clock"
	issue, err := w.f.Issue.Add(protocol.IssueRequest{Title: "写打卡并提交", Project: &project, Assignee: &lab.ID})
	if err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, issue.Moves, []protocol.IssueStatus{protocol.IssueStatusTodo, protocol.IssueStatusCanceled}, "from the backlog")
	var refused protocol.Refused
	if _, err := move(issue.ID, protocol.IssueStatusInProgress, ""); !errors.As(err, &refused) {
		t.Fatalf("in progress is the session's: %v", err)
	}
	if issue, err = move(issue.ID, protocol.IssueStatusTodo, ""); err != nil {
		t.Fatal(err)
	}
	w.nextReport(t)
	issue, _ = w.f.Issue.Get(issue.ID)
	testkit.Eq(t, issue.Status, protocol.IssueStatusInReview, "its round handed back")
	testkit.Eq(t, issue.Moves, []protocol.IssueStatus{protocol.IssueStatusTodo, protocol.IssueStatusDone, protocol.IssueStatusCanceled}, "in review")
	if _, err := move(issue.ID, protocol.IssueStatusTodo, " "); !errors.As(err, &refused) {
		t.Fatalf("another round without a word: %v", err)
	}
	if _, err := move(issue.ID, protocol.IssueStatusTodo, "再写版本B"); err != nil {
		t.Fatal(err)
	}
	w.nextReport(t)
	if issue, err = move(issue.ID, protocol.IssueStatusDone, ""); err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, issue.Status, protocol.IssueStatusDone, "merged")
	testkit.Match(t, testkit.Git(t, filepath.Join(work, "projects", "clock"), "log", "--format=%s", "main"), `版本 B`, "both rounds on main")
	testkit.Eq(t, issue.Moves, []protocol.IssueStatus{protocol.IssueStatusTodo}, "a closed one only reopens")

	dropped, _ := w.f.Issue.Add(protocol.IssueRequest{Title: "算了"})
	if dropped, err = move(dropped.ID, protocol.IssueStatusCanceled, ""); err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, []any{dropped.Status, *dropped.Closed}, []any{protocol.IssueStatusCanceled, protocol.IssueCloseDismissed}, "dropped unsent")
	if dropped, err = move(dropped.ID, protocol.IssueStatusBacklog, ""); err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, dropped.Status, protocol.IssueStatusBacklog, "back in the backlog")
}

func TestMovingToDoneRefusesFailedProjectCheck(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	lab := fixture.Lab(t)
	w.f.Agent.SaveAgent(lab)
	helper := mustHire(t, w.f.Issue.Hire(context.Background(), lab, "写打卡并提交", "clock", session.HireOptions{}))
	w.nextReport(t)
	place, ok := w.f.Session.Place(helper.ID)
	if !ok {
		t.Fatal("missing workplace")
	}
	if err := os.MkdirAll(filepath.Join(place.Cwd, ".vibevalley"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(place.Cwd, ".vibevalley/check"), []byte("#!/bin/sh\necho harvest-check-failed\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(work, "projects", "clock")
	before := testkit.Git(t, project, "rev-parse", "main")
	issue, err := w.f.Issue.SetStatus(context.Background(), *helper.Issue, protocol.IssueStatusDone, "", "")
	var refused protocol.Refused
	if !errors.As(err, &refused) || !strings.Contains(refused.Reason, "harvest-check-failed") {
		t.Fatalf("refusal with output: %v", err)
	}
	testkit.Eq(t, issue.Status, protocol.IssueStatusInReview, "failed harvest stays in review")
	testkit.Until(t, "helper hears check output", func() bool {
		got := w.f.Session.Find(helper.ID)
		return got != nil && strings.Contains(got.LastText, "harvest-check-failed") && !protocol.IsBusy(got.Session)
	})
	issue, err = w.f.Issue.Get(issue.ID)
	if err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, issue.Status, protocol.IssueStatusInReview, "repair round returns to review")
	testkit.Eq(t, testkit.Git(t, project, "rev-parse", "main"), before, "main unchanged")
	if _, err := os.Stat(place.Cwd); err != nil {
		t.Fatal(err)
	}
	testkit.Git(t, project, "rev-parse", "--verify", place.Branch)
}

func TestIssueWorktreeSurvivesCancellationAndReopen(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	lab := fixture.Lab(t)
	w.f.Agent.SaveAgent(lab)
	issue, err := w.f.Issue.Add(protocol.IssueRequest{Title: "写打卡并提交", Project: ptr.To("resume"), Assignee: &lab.ID})
	if err != nil {
		t.Fatal(err)
	}
	sent, err := w.f.Issue.Start(context.Background(), issue.ID, "")
	if err != nil || sent.Session == nil {
		t.Fatalf("start: %+v %v", sent, err)
	}
	w.nextReport(t)
	first := w.f.Session.Get(*sent.Session)
	testkit.Eq(t, *first.Branch, fmt.Sprintf("vibevalley/issue-%d", issue.Number), "issue branch")
	before := testkit.Git(t, *first.Worktree, "rev-parse", "HEAD")
	w.f.Session.Dismiss(first.ID)
	testkit.Until(t, "cancelled", func() bool { i, e := w.f.Issue.Get(issue.ID); return e == nil && i.Closed != nil })
	again, err := w.f.Issue.Reopen(context.Background(), issue.ID, "接着做", "")
	if err != nil {
		t.Fatal(err)
	}
	w.nextReport(t)
	reopened := w.f.Session.Get(again)
	testkit.Eq(t, *reopened.Branch, *first.Branch, "same branch")
	testkit.Eq(t, *reopened.Worktree, *first.Worktree, "same worktree")
	testkit.Eq(t, testkit.Git(t, *reopened.Worktree, "rev-parse", "HEAD"), before, "previous commit")
	if !strings.Contains(reopened.Brief, "这条分支上已经有上次的提交，接着做。") {
		t.Fatal(reopened.Brief)
	}
	if _, err := w.f.Issue.Merge(issue.ID); err != nil {
		t.Fatal(err)
	}
	testkit.Until(t, "merged", func() bool {
		i, e := w.f.Issue.Get(issue.ID)
		return e == nil && i.Closed != nil && *i.Closed == protocol.IssueCloseMerged
	})
	again, err = w.f.Issue.Reopen(context.Background(), issue.ID, "再看看", "")
	if err != nil {
		t.Fatal(err)
	}
	w.nextReport(t)
	if strings.Contains(w.f.Session.Get(again).Brief, "这条分支上已经有上次的提交，接着做。") {
		t.Fatal("merged commits must not be described as unmerged")
	}
}

// Every issue has an acceptance: one that must pass waits for it; a fail grows weeds and another round; a pass is ripe.
// A question in a report leaves the plot short of fertilizer until the owner answers.
func TestAPlotGrowsThroughItsAcceptance(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	lab := fixture.Lab(t)
	w.f.Agent.SaveAgent(lab)
	project, required := "clock", protocol.AcceptanceRequired
	issue, err := w.f.Issue.Add(protocol.IssueRequest{Title: "先问清楚，再写打卡并提交", Project: &project, Assignee: &lab.ID, Acceptance: &required})
	if err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, issue.Acceptance, protocol.AcceptanceRequired, "kept")
	if _, err := w.f.Issue.SetStatus(context.Background(), issue.ID, protocol.IssueStatusTodo, "", ""); err != nil {
		t.Fatal(err)
	}
	w.nextReport(t)
	issue = testkit.Await(t, "its question kept", func() (protocol.Issue, bool) {
		got, _ := w.f.Issue.Get(issue.ID)
		return got, len(got.Asks) == 1
	})
	testkit.Eq(t, issue.Asks, []string{"用 8787 还是 8797？"}, "what it asks")
	testkit.Until(t, "缺肥", func() bool { return protocol.ViewOf(w.f.Core.State()).Plots[issue.ID].Crop == protocol.CropDry })

	if err := w.f.Issue.Comment(issue.ID, protocol.CommentRequest{Text: "用 8797"}); err != nil {
		t.Fatal(err)
	}
	issue, _ = w.f.Issue.Get(issue.ID)
	testkit.Eq(t, len(issue.Asks), 0, "answered")
	w.nextReport(t)
	testkit.Until(t, "handed back", func() bool {
		got, _ := w.f.Issue.Get(issue.ID)
		return got.Status == protocol.IssueStatusInReview
	})
	testkit.Until(t, "抽穗：等验收", func() bool { return protocol.ViewOf(w.f.Core.State()).Plots[issue.ID].Crop == protocol.CropFlowering })
	var refused protocol.Refused
	if _, err := w.f.Issue.SetStatus(context.Background(), issue.ID, protocol.IssueStatusDone, "", ""); !errors.As(err, &refused) {
		t.Fatalf("harvest before acceptance: %v", err)
	}

	if _, err := w.f.Issue.Accept(context.Background(), issue.ID, protocol.IssueAcceptRequest{Findings: []string{"再写版本B"}}); err != nil {
		t.Fatal(err)
	}
	issue, _ = w.f.Issue.Get(issue.ID)
	testkit.Eq(t, protocol.OpenFindings(issue), 1, "one weed")
	w.nextReport(t)
	testkit.Until(t, "the weed worked on and handed back", func() bool {
		got, _ := w.f.Issue.Get(issue.ID)
		return got.Status == protocol.IssueStatusInReview
	})
	testkit.Until(t, "the weed stands until a pass", func() bool { return protocol.ViewOf(w.f.Core.State()).Plots[issue.ID].Crop == protocol.CropWeeds })

	if issue, err = w.f.Issue.Accept(context.Background(), issue.ID, protocol.IssueAcceptRequest{Pass: true}); err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, []any{issue.AcceptedAt != nil, protocol.OpenFindings(issue), slices.Contains(issue.Moves, protocol.IssueStatusDone)}, []any{true, 0, true}, "the answer: passed, weed pulled, ready to harvest")
	if issue, err = w.f.Issue.SetStatus(context.Background(), issue.ID, protocol.IssueStatusDone, "", ""); err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, issue.Status, protocol.IssueStatusDone, "harvested")
	testkit.Match(t, testkit.Git(t, filepath.Join(work, "projects", "clock"), "log", "--format=%s", "main"), `版本 B`, "the fix is on main")
}
