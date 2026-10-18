package manager

import (
	"context"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"vibevalley/internal/issue"
	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
)

func managerWorkFor(t *testing.T, f *world, title string) issue.ManagerWork {
	t.Helper()
	i, err := f.Issue.Add(protocol.IssueRequest{Title: title, Description: title, Assignee: new(protocol.ManagerAgent)})
	if err != nil {
		t.Fatal(err)
	}
	return issue.ManagerWork{Issue: i, Channel: f.Channel.General(), By: protocol.RunTrigger{Kind: protocol.RunTriggerKindIssue}}
}

func managerFinishedRun(t *testing.T, f *world, work issue.ManagerWork, outcome protocol.Outcome) protocol.Run {
	t.Helper()
	r := testkit.Await(t, "manager run ends", func() (protocol.Run, bool) {
		runs, err := f.Session.Runs(work.Issue.ID)
		if err != nil || len(runs) != 1 {
			return protocol.Run{}, false
		}
		return runs[0], runs[0].Outcome != nil
	})
	if *r.Outcome != outcome {
		t.Fatalf("outcome %v want %v", *r.Outcome, outcome)
	}
	events := testkit.Await(t, "run journal ends", func() ([]protocol.SessionEvent, bool) {
		events := f.Session.Events(protocol.ManagerAgent, r.ID)
		return events, len(events) >= 3 && events[0].Type == protocol.SessionEventTypeRunStart && events[len(events)-1].Type == protocol.SessionEventTypeRunEnd
	})
	for _, e := range events {
		if e.Run == nil || *e.Run != r.ID {
			t.Fatalf("event outside run: %+v", e)
		}
	}
	if outcome == protocol.OutcomeCompleted {
		testkit.Until(t, "successful work closes", func() bool {
			i, _ := f.Issue.Get(work.Issue.ID)
			return i.Closed != nil && *i.Closed == protocol.IssueCloseAnswered
		})
	} else {
		i, _ := f.Issue.Get(work.Issue.ID)
		if i.Closed != nil {
			t.Fatalf("unsuccessful work closed: %+v", i)
		}
	}
	return r
}

func TestManagerExecutionUsesModelOutcome(t *testing.T) {
	for _, outcome := range []protocol.Outcome{protocol.OutcomeCompleted, protocol.OutcomeFailed} {
		t.Run(string(outcome), func(t *testing.T) {
			w := managerOpen(t)
			w.faux.SetResponses(ai.FauxResponseFactory(func(ai.Context, ai.StreamOptions, ai.FauxProviderState, ai.Model) ai.AssistantMessage {
				m := ai.FauxAssistantMessage("answer")
				if outcome == protocol.OutcomeFailed {
					m.StopReason = ai.StopError
					m.ErrorMessage = "model failed"
				}
				return m
			}))
			work := managerWorkFor(t, w.f, "outcome")
			w.f.Manager.onWork(work)
			managerFinishedRun(t, w.f, work, outcome)
		})
	}
}

func TestManagerStartFailureHasFailedRun(t *testing.T) {
	f, err := newWorld(fixture.Config(t.TempDir(), t.TempDir(), ":memory:"))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.Close)
	work := managerWorkFor(t, f, "start failure")
	f.Manager.onWork(work)
	run := managerFinishedRun(t, f, work, protocol.OutcomeFailed)
	if run.Summary == nil || !strings.Contains(*run.Summary, "起不来") {
		t.Fatalf("summary: %+v", run)
	}
}

func TestMergedManagerInputsShareOnlyTheirConsumedRun(t *testing.T) {
	w := managerOpen(t)
	entered, release := make(chan struct{}), make(chan struct{})
	w.faux.SetResponses(
		ai.FauxResponseFactory(func(ai.Context, ai.StreamOptions, ai.FauxProviderState, ai.Model) ai.AssistantMessage {
			close(entered)
			<-release
			return ai.FauxAssistantMessage("first answer")
		}),
		ai.FauxResponseFactory(func(ai.Context, ai.StreamOptions, ai.FauxProviderState, ai.Model) ai.AssistantMessage {
			return ai.FauxAssistantMessage("second answer")
		}),
	)
	a, b := managerWorkFor(t, w.f, "first"), managerWorkFor(t, w.f, "second")
	w.f.Manager.onWork(a)
	<-entered
	w.f.Manager.onWork(b)
	if runs, err := w.f.Session.Runs(b.Issue.ID); err != nil || len(runs) != 0 {
		t.Fatalf("queued work already owns run: %+v %v", runs, err)
	}
	close(release)
	ar := managerFinishedRun(t, w.f, a, protocol.OutcomeCompleted)
	br := managerFinishedRun(t, w.f, b, protocol.OutcomeCompleted)
	if ar.ID != br.ID || ar.Issue == nil || *ar.Issue != a.Issue.ID {
		t.Fatalf("merged ownership: %+v %+v", ar, br)
	}
	events := w.f.Session.Events(protocol.ManagerAgent, ar.ID)
	inputs := 0
	for _, e := range events {
		if e.Type == protocol.SessionEventTypeUserMessage {
			inputs++
		}
	}
	if inputs != 2 {
		t.Fatalf("inputs: %d", inputs)
	}
}

func TestInterruptedManagerRunDoesNotConsumeQueuedWork(t *testing.T) {
	w := managerOpen(t)
	fm := w.f.Manager.manager
	brain, err := fm.brainOf()
	if err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{})
	brain.Core.SetTools([]agentcore.AgentTool{agentcore.DefineTool(agentcore.ToolSpec[struct{}]{Name: "wait", Parameters: agentcore.ObjectSchema(nil), Execute: func(ctx context.Context, _ string, _ struct{}, _ agentcore.AgentToolUpdateCallback) (agentcore.AgentToolResult, error) {
		close(entered)
		<-ctx.Done()
		return agentcore.TextResult("stopped"), nil
	}})})
	w.faux.SetResponses(ai.FauxResponseFactory(func(ai.Context, ai.StreamOptions, ai.FauxProviderState, ai.Model) ai.AssistantMessage {
		return ai.FauxAssistantMessage(ai.FauxToolCall("wait", map[string]any{}, ""))
	}))
	a, b := managerWorkFor(t, w.f, "interrupted"), managerWorkFor(t, w.f, "queued")
	fm.onWork(a)
	<-entered
	fm.onWork(b)
	brain.Stop()
	managerFinishedRun(t, w.f, a, protocol.OutcomeInterrupted)
	if runs, err := w.f.Session.Runs(b.Issue.ID); err != nil || len(runs) != 0 {
		t.Fatalf("unconsumed work assigned: %+v %v", runs, err)
	}
	if got, _ := w.f.Issue.Get(b.Issue.ID); got.Closed != nil {
		t.Fatal("queued work closed")
	}
}

func TestFailedStartRetriesPreviousFinishWithoutMergingInputs(t *testing.T) {
	f, err := newWorld(fixture.Config(t.TempDir(), t.TempDir(), ":memory:"))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.Close)
	a, b := managerWorkFor(t, f, "first rejected input"), managerWorkFor(t, f, "second rejected input")
	if _, err := f.DB.Exec(`CREATE TRIGGER reject_finish BEFORE UPDATE OF ended_at ON session_run BEGIN SELECT RAISE(FAIL,'transient finish failure'); END`); err != nil {
		t.Fatal(err)
	}
	f.Manager.onWork(a)
	first, err := f.Session.Runs(a.Issue.ID)
	if err != nil || len(first) != 1 || first[0].EndedAt != nil {
		t.Fatalf("first pending terminal: %+v %v", first, err)
	}
	if current := f.Manager.execution.CurrentRun(); current != "" {
		t.Fatalf("terminal run advertised as active: %s", current)
	}
	// Repeated persistence failure cannot attach the new input to the old run.
	f.Manager.onWork(b)
	if runs, err := f.Session.Runs(b.Issue.ID); err != nil || len(runs) != 0 {
		t.Fatalf("new input merged into pending terminal: %+v %v", runs, err)
	}
	if _, err := f.DB.Exec(`DROP TRIGGER reject_finish`); err != nil {
		t.Fatal(err)
	}
	f.Manager.onWork(b)
	ar := managerFinishedRun(t, f, a, protocol.OutcomeFailed)
	br := managerFinishedRun(t, f, b, protocol.OutcomeFailed)
	if ar.ID == br.ID {
		t.Fatalf("independent failures share run %s", ar.ID)
	}
	for _, pair := range []struct {
		run        protocol.Run
		own, other string
	}{{ar, a.Issue.Title, b.Issue.Title}, {br, b.Issue.Title, a.Issue.Title}} {
		inputs := 0
		for _, e := range f.Session.Events(protocol.ManagerAgent, pair.run.ID) {
			if e.Type == protocol.SessionEventTypeUserMessage {
				inputs++
				if !strings.Contains(e.Text, pair.own) || strings.Contains(e.Text, pair.other) {
					t.Fatalf("cross-run input: %+v", e)
				}
			}
		}
		if inputs != 1 {
			t.Fatalf("run %s has %d input events", pair.run.ID, inputs)
		}
	}
}

func TestShutdownPreservesPendingFailedRunOutcome(t *testing.T) {
	f, err := newWorld(fixture.Config(t.TempDir(), t.TempDir(), ":memory:"))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.Close)
	work := managerWorkFor(t, f, "failed before stop")
	if _, err := f.DB.Exec(`CREATE TRIGGER reject_finish BEFORE UPDATE OF ended_at ON session_run BEGIN SELECT RAISE(FAIL,'transient finish failure'); END`); err != nil {
		t.Fatal(err)
	}
	f.Manager.onWork(work)
	if _, err := f.DB.Exec(`DROP TRIGGER reject_finish`); err != nil {
		t.Fatal(err)
	}
	if err := f.Manager.execution.Close(); err != nil {
		t.Fatal(err)
	}
	managerFinishedRun(t, f, work, protocol.OutcomeFailed)
}

func TestAResumedRunAnswersTheIssueItWasCutIn(t *testing.T) {
	cfg := fixture.Config(t.TempDir(), t.TempDir(), filepath.Join(t.TempDir(), "vibevalley.db"))
	before := ai.FauxProvider(ai.FauxProviderOptions{Delay: 5 * time.Millisecond})
	before.SetResponses(
		ai.FauxAssistantMessage(ai.FauxToolCall("projects", map[string]any{}, "")),
		ai.FauxAssistantMessage(strings.Repeat("还在说", 400)),
	)
	w := managerStart(t, cfg, before)
	work := managerWorkFor(t, w.f, "接着做")
	w.f.Manager.onWork(work)
	testkit.Until(t, "the second answer coming", func() bool { return len(before.State().Contexts) == 2 })
	w.f.Close()

	after := ai.FauxProvider(ai.FauxProviderOptions{})
	after.SetResponses(ai.FauxAssistantMessage("做完了"))
	again := managerStart(t, cfg, after)
	runs := testkit.Await(t, "the resumed run", func() ([]protocol.Run, bool) {
		runs, err := again.f.Session.Runs(work.Issue.ID)
		return runs, err == nil && len(runs) == 2 && runs[0].Outcome != nil && runs[1].Outcome != nil
	})
	outcomes := []protocol.Outcome{*runs[0].Outcome, *runs[1].Outcome}
	if !slices.Contains(outcomes, protocol.OutcomeInterrupted) || !slices.Contains(outcomes, protocol.OutcomeCompleted) {
		t.Fatalf("outcomes %v", outcomes)
	}
	testkit.Until(t, "the issue answered", func() bool {
		i, _ := again.f.Issue.Get(work.Issue.ID)
		return i.Closed != nil && *i.Closed == protocol.IssueCloseAnswered
	})
}
