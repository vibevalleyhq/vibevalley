package agents

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/oartest"
	"vibevalley/pkg/smith/observe"
	"vibevalley/pkg/smith/voyage"
)

// Ported from tests/subagents.test.ts. Tests that touch OAR_SUBAGENT_DEPTH
// use t.Setenv; none runs in parallel.

func TestSpawnedTurnIsAReportReadOnceByWait(t *testing.T) {
	t.Setenv(SubagentDepthEnv, "")
	ctx := testCtx(t)
	crew := crewOf(t, echo, Options{})
	spawned(t, crew, "count files", "counter")
	reports := crew.Wait(ctx, WaitOptions{Timeout: 5 * time.Second})
	if len(reports) != 1 {
		t.Fatalf("reports = %+v", reports)
	}
	report := reports[0]
	if report.ID != "counter" || report.Name != "counter" || report.Runtime != "fake" || report.Turn != 1 || report.Outcome.Kind != "completed" || report.Text != "did: count files" {
		t.Fatalf("report = %+v", report)
	}
	if again := crew.Wait(ctx, WaitOptions{Timeout: -1}); len(again) != 0 {
		t.Fatalf("second wait = %+v", again)
	}
	list := crew.List()
	if len(list) != 1 || list[0].ID != "counter" || list[0].State != "idle" || list[0].Turns != 1 {
		t.Fatalf("list = %+v", list)
	}
	tasks := crew.Tasks()
	if len(tasks) != 1 || tasks[0].TaskID != "counter" || tasks[0].TaskType != "agent" || tasks[0].Status != "completed" || tasks[0].Summary != "did: count files" || tasks[0].Background == nil || !*tasks[0].Background {
		t.Fatalf("tasks = %+v", tasks)
	}
	if err := crew.Close(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestFollowupSteersRunningSubagent(t *testing.T) {
	t.Setenv(SubagentDepthEnv, "")
	ctx := testCtx(t)
	g := &gate{}
	crew := crewOf(t, g.script, Options{})
	agent := spawned(t, crew, "first", "")
	result, err := agent.Send(ctx, "hurry", "")
	if err != nil || result != (SendResult{Kind: "accepted", Landed: "steered"}) {
		t.Fatalf("send = %+v %v", result, err)
	}
	g.release()
	reports := crew.Wait(ctx, WaitOptions{Timeout: 5 * time.Second})
	if len(reports) != 1 || reports[0].Text != "working on first steered: hurry" {
		t.Fatalf("reports = %+v", reports)
	}
}

func TestFollowupStartsNewTurnOnIdleSubagent(t *testing.T) {
	t.Setenv(SubagentDepthEnv, "")
	ctx := testCtx(t)
	crew := crewOf(t, echo, Options{})
	agent := spawned(t, crew, "first", "")
	crew.Wait(ctx, WaitOptions{Timeout: 5 * time.Second})
	result, err := agent.Send(ctx, "second", "")
	if err != nil || result != (SendResult{Kind: "accepted", Landed: "prompted"}) {
		t.Fatalf("send = %+v %v", result, err)
	}
	reports := crew.Wait(ctx, WaitOptions{Timeout: 5 * time.Second})
	if len(reports) != 1 || reports[0].ID != "fake-1" || reports[0].Turn != 2 || reports[0].Text != "did: second" {
		t.Fatalf("reports = %+v", reports)
	}
}

func TestChildrenRunOneLevelDeeper(t *testing.T) {
	t.Setenv(SubagentDepthEnv, "")
	ctx := testCtx(t)
	var mu sync.Mutex
	var depths []string
	crew := crewOf(t, func(turn *oartest.Turn) error {
		mu.Lock()
		defer mu.Unlock()
		value := "<unset>"
		if depth := turn.Options.Env[SubagentDepthEnv]; depth != nil {
			value = *depth
		}
		depths = append(depths, value)
		return nil
	}, Options{})
	spawned(t, crew, "a", "")
	poll(t, 5*time.Second, "depths [1]", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return reflect.DeepEqual(depths, []string{"1"})
	})
	t.Setenv(SubagentDepthEnv, "1")
	result, err := crew.Spawn(ctx, SpawnOptions{Runtime: "fake", Task: "b"})
	if err != nil || result.Kind != "refused" || result.Code != "depth_limit" {
		t.Fatalf("spawn = %+v %v", result, err)
	}
}

func TestRunningLimitAndUnknownRuntimeRefuse(t *testing.T) {
	t.Setenv(SubagentDepthEnv, "")
	ctx := testCtx(t)
	g := &gate{}
	crew := crewOf(t, g.script, Options{MaxRunning: 1})
	spawned(t, crew, "a", "")
	if result, err := crew.Spawn(ctx, SpawnOptions{Runtime: "fake", Task: "b"}); err != nil || result.Kind != "refused" || result.Code != "running_limit" || result.Reason == "" {
		t.Fatalf("spawn b = %+v %v", result, err)
	}
	if result, err := crew.Spawn(ctx, SpawnOptions{Runtime: "nope", Task: "c"}); err != nil || result.Kind != "refused" || result.Code != "unknown_runtime" || result.Reason == "" {
		t.Fatalf("spawn c = %+v %v", result, err)
	}
	g.release()
}

func TestOnReportDeliveringIntoIdleParentWakesIt(t *testing.T) {
	t.Setenv(SubagentDepthEnv, "")
	ctx := testCtx(t)
	var mu sync.Mutex
	var inputs []string
	parentRuntime := oartest.Runtime(oartest.Options{ID: "parent", Turn: func(turn *oartest.Turn) error {
		mu.Lock()
		defer mu.Unlock()
		inputs = append(inputs, turn.Input)
		return nil
	}})
	cwd, _ := os.Getwd()
	parent, err := parentRuntime.Session(ctx, oar.AvailableInstallation{Via: "bundled"}, oar.SessionOptions{Cwd: cwd})
	if err != nil {
		t.Fatal(err)
	}
	crew := crewOf(t, echo, Options{})
	crew.OnReport(func(report SubagentReport) error {
		origin := ReportOrigin(report)
		go func() {
			_, _ = parent.Deliver(context.Background(), FormatReport(report), oar.DeliverOptions{InputOptions: oar.InputOptions{Origin: &origin}})
		}()
		return nil
	})
	spawned(t, crew, "summarize", "helper")
	poll(t, 5*time.Second, "one parent input", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(inputs) == 1
	})
	mu.Lock()
	first := inputs[0]
	mu.Unlock()
	if !regexp.MustCompile(`^\[subagent helper on fake, turn 1: completed; session [^\]]+\]\ndid: summarize$`).MatchString(first) {
		t.Fatalf("input = %q", first)
	}
	if unread := crew.Unread(); len(unread) != 0 {
		t.Fatalf("unread = %+v", unread)
	}
	var origins []oar.InputOrigin
	for _, input := range observe.ConversationOf(parent.Records()).Inputs.Values() {
		origins = append(origins, *input.Origin)
	}
	if !reflect.DeepEqual(origins, []oar.InputOrigin{{Kind: "notification", Source: "subagent:helper"}}) {
		t.Fatalf("origins = %+v", origins)
	}
	_ = crew.Close(ctx)
	_ = parent.Dispose(ctx)
}

func TestReportEveryHookThrowsOnStaysUnread(t *testing.T) {
	t.Setenv(SubagentDepthEnv, "")
	crew := crewOf(t, echo, Options{})
	crew.OnReport(func(SubagentReport) error { return errors.New("app inbox down") })
	crew.OnReport(func(SubagentReport) error { panic("app inbox down") })
	spawned(t, crew, "x", "")
	poll(t, 5*time.Second, "one unread report", func() bool { return len(crew.Unread()) == 1 })
}

func closeMidTurn(t *testing.T, dir string) *Subagents {
	t.Helper()
	g := &gate{}
	crew := crewOf(t, g.script, Options{LogDir: dir})
	spawned(t, crew, "long job", "")
	poll(t, 5*time.Second, "the turn to start", func() bool { return g.started.Load() == 1 })
	if err := crew.Close(testCtx(t)); err != nil {
		t.Fatal(err)
	}
	return crew
}

func TestClosingRunningSubagentEndsTaskStoppedAndLogKeepsRecords(t *testing.T) {
	t.Setenv(SubagentDepthEnv, "")
	dir := t.TempDir()
	crew := closeMidTurn(t, dir)
	tasks := crew.Tasks()
	if len(tasks) != 1 || tasks[0].TaskID != "fake-1" || tasks[0].Status != "stopped" {
		t.Fatalf("tasks = %+v", tasks)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("entries = %v %v", entries, err)
	}
	data, err := os.ReadFile(filepath.Join(dir, entries[0].Name()))
	if err != nil {
		t.Fatal(err)
	}
	records, err := voyage.ReadRecords(strings.NewReader(string(data)))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(records, crew.Get("fake-1").Session.Records()) {
		t.Fatal("subagent Close returned before its recording caught up")
	}
	if strings.Count(string(data), `"kind":"end"`) != 1 || !strings.Contains(string(data), `"reason":"exited"`) {
		t.Fatal("subagent recording did not end once as exited")
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if !strings.Contains(lines[0], `"kind":"header"`) {
		t.Fatalf("first line = %s", lines[0])
	}
	found := false
	for _, line := range lines {
		if strings.Contains(line, "long job") {
			found = true
		}
	}
	if !found {
		t.Fatalf("no line has the task: %v", lines)
	}
}

func TestWaitReturnsNothingBeforeTimeout(t *testing.T) {
	t.Setenv(SubagentDepthEnv, "")
	ctx := testCtx(t)
	g := &gate{}
	crew := crewOf(t, g.script, Options{})
	spawned(t, crew, "slow", "")
	started := time.Now()
	if reports := crew.Wait(ctx, WaitOptions{Timeout: 200 * time.Millisecond}); len(reports) != 0 {
		t.Fatalf("reports = %+v", reports)
	}
	if elapsed := time.Since(started); elapsed < 150*time.Millisecond {
		t.Fatalf("waited only %v", elapsed)
	}
	g.release()
}

// Ported from tests/subagents-lifecycle.test.ts.

func silentCrew(t *testing.T, g *gate) *Subagents {
	crew := New(Options{Runtimes: registryOf(t, silentOnDispose(oartest.Runtime(oartest.Options{ID: "fake", Turn: g.script})))})
	t.Cleanup(func() { _ = crew.Close(context.Background()) })
	return crew
}

func TestClosingMidTurnWithNoRuntimeEndYieldsAbortedReport(t *testing.T) {
	t.Setenv(SubagentDepthEnv, "")
	ctx := testCtx(t)
	g := &gate{}
	crew := silentCrew(t, g)
	agent := spawned(t, crew, "long job", "")
	poll(t, 5*time.Second, "the turn to start", func() bool { return g.started.Load() == 1 })
	pending := make(chan *SubagentReport, 1)
	go func() {
		report, _ := agent.NextReport(ctx)
		pending <- report
	}()
	// Go-only: TS registers the waiter synchronously inside nextReport().
	poll(t, 5*time.Second, "nextReport to register", func() bool {
		agent.mu.Lock()
		defer agent.mu.Unlock()
		return len(agent.waiters) == 1
	})
	if err := crew.Close(ctx); err != nil {
		t.Fatal(err)
	}
	report := <-pending
	if report == nil || report.Turn != 1 || report.Outcome.Kind != "aborted" {
		t.Fatalf("report = %+v", report)
	}
	unread := crew.Unread()
	if len(unread) != 1 || unread[0].ID != "fake-1" || unread[0].Outcome.Kind != "aborted" {
		t.Fatalf("unread = %+v", unread)
	}
	tasks := crew.Tasks()
	if len(tasks) != 1 || tasks[0].TaskID != "fake-1" || tasks[0].Status != "stopped" {
		t.Fatalf("tasks = %+v", tasks)
	}
	if next, err := agent.NextReport(ctx); next != nil || err != nil {
		t.Fatalf("next = %+v %v", next, err)
	}
}

func TestNextKeepsItsReportFromWaitsNamingNoIDs(t *testing.T) {
	t.Setenv(SubagentDepthEnv, "")
	ctx := testCtx(t)
	g := &gate{}
	crew := crewOf(t, g.script, Options{})
	agent := spawned(t, crew, "mine", "")
	// The other wait registers first, so it would be first to look.
	other := make(chan []SubagentReport, 1)
	go func() { other <- crew.Wait(ctx, WaitOptions{Timeout: 300 * time.Millisecond}) }()
	mine := make(chan *SubagentReport, 1)
	go func() { mine <- crew.Next(ctx, agent.ID) }()
	// Go-only: TS reserves synchronously inside next(); wait for the reservation.
	poll(t, 5*time.Second, "next to reserve", func() bool {
		crew.mu.Lock()
		defer crew.mu.Unlock()
		return crew.reserved[agent.ID] == 1
	})
	g.release()
	if got := <-other; len(got) != 0 {
		t.Fatalf("other = %+v", got)
	}
	if got := <-mine; got == nil || got.ID != agent.ID || got.Turn != 1 {
		t.Fatalf("mine = %+v", got)
	}
}

func TestNextCancelledLeavesReportUnread(t *testing.T) {
	t.Setenv(SubagentDepthEnv, "")
	g := &gate{}
	crew := crewOf(t, g.script, Options{})
	agent := spawned(t, crew, "cancel me", "")
	cancelled, cancel := context.WithCancel(context.Background())
	waiting := make(chan *SubagentReport, 1)
	go func() { waiting <- crew.Next(cancelled, agent.ID) }()
	cancel()
	if got := <-waiting; got != nil {
		t.Fatalf("next = %+v", got)
	}
	g.release()
	poll(t, 5*time.Second, "one unread report", func() bool { return len(crew.Unread()) == 1 })
}

func slowToProbe(runtime oar.Runtime) oar.Runtime {
	probe := runtime.Installation
	runtime.Installation = func(ctx context.Context, options oar.InstallationOptions) (oar.InstallationSnapshot, error) {
		time.Sleep(50 * time.Millisecond)
		return probe(ctx, options)
	}
	return runtime
}

func TestSpawnInFlightWhenCrewClosesIsRefused(t *testing.T) {
	t.Setenv(SubagentDepthEnv, "")
	ctx := testCtx(t)
	crew := New(Options{Runtimes: registryOf(t, slowToProbe(oartest.Runtime(oartest.Options{ID: "fake", Turn: echo})))})
	pending := make(chan SpawnResult, 1)
	go func() {
		result, _ := crew.Spawn(ctx, SpawnOptions{Runtime: "fake", Task: "late"})
		pending <- result
	}()
	// Let the spawn get past its refusal check into the slow probe.
	poll(t, 5*time.Second, "the spawn to start", func() bool {
		crew.mu.Lock()
		defer crew.mu.Unlock()
		return crew.starting == 1
	})
	if err := crew.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if result := <-pending; result.Kind != "refused" || result.Code != "closed" {
		t.Fatalf("pending = %+v", result)
	}
	if list := crew.List(); len(list) != 0 {
		t.Fatalf("list = %+v", list)
	}
	if result, err := crew.Spawn(ctx, SpawnOptions{Runtime: "fake", Task: "after"}); err != nil || result.Kind != "refused" || result.Code != "closed" {
		t.Fatalf("after = %+v %v", result, err)
	}
}

func TestQueueOnIdleSubagentCountsAgainstRunningLimit(t *testing.T) {
	t.Setenv(SubagentDepthEnv, "")
	ctx := testCtx(t)
	g := &gate{}
	crew := crewOf(t, g.script, Options{MaxRunning: 1})
	first := spawned(t, crew, "one", "")
	g.release()
	crew.Wait(ctx, WaitOptions{Timeout: 5 * time.Second})
	spawned(t, crew, "two", "")
	if result, err := first.Send(ctx, "again", "queue"); err != nil || result.Kind != "rejected" || result.Code != "running_limit" {
		t.Fatalf("queue = %+v %v", result, err)
	}
	if result, err := first.Send(ctx, "again", ""); err != nil || result.Kind != "rejected" || result.Code != "running_limit" {
		t.Fatalf("followup = %+v %v", result, err)
	}
	g.release()
}

func TestLogNamesKeepChosenNameInsideLogDir(t *testing.T) {
	t.Setenv(SubagentDepthEnv, "")
	ctx := testCtx(t)
	dir := t.TempDir()
	crew := crewOf(t, echo, Options{LogDir: filepath.Join(dir, "logs")})
	spawned(t, crew, "x", "../frontend/api")
	crew.Wait(ctx, WaitOptions{Timeout: 5 * time.Second})
	if err := crew.Close(ctx); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Join(dir, "logs"))
	if err != nil || len(entries) != 1 {
		t.Fatalf("entries = %v %v", entries, err)
	}
	if name := entries[0].Name(); !regexp.MustCompile(`^\.\._frontend_api-[\w-]+\.jsonl$`).MatchString(name) {
		t.Fatalf("file = %s", name)
	}
	if _, err := os.Stat(filepath.Join(dir, "frontend")); !os.IsNotExist(err) {
		t.Fatalf("frontend exists: %v", err)
	}
}

// Go-only: the helpers TS keeps implicit.

func TestSliceUTF16CountsCodeUnits(t *testing.T) {
	if got := sliceUTF16("a😀b", 3); got != "a😀" {
		t.Fatalf("got %q", got)
	}
	if got := sliceUTF16("中文", 120); got != "中文" {
		t.Fatalf("got %q", got)
	}
}

func TestHostDepthReadsLikeNumber(t *testing.T) {
	for value, want := range map[string]int{"": 0, "2": 2, " 3 ": 3, "-1": 0, "1.5": 0, "x": 0, "0x2": 2, "1e1": 10} {
		t.Setenv(SubagentDepthEnv, value)
		if got := hostDepth(); got != want {
			t.Fatalf("hostDepth(%q) = %d, want %d", value, got, want)
		}
	}
}
