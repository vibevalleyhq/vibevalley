package brain

import (
	"context"
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
)

func billed(content any, input, output, cache int) ai.AssistantMessage {
	m := ai.FauxAssistantMessage(content)
	m.Usage = ai.Usage{Input: input, Output: output, CacheRead: cache, TotalTokens: input + output + cache}
	return m
}
func receiptAgent(t *testing.T, steps ...ai.FauxResponseStep) (*Agent, *agentcore.Subscription[AgentEvent]) {
	t.Helper()
	f := ai.FauxProvider(ai.FauxProviderOptions{})
	f.AppendResponses(steps...)
	a := NewAgent(ai.WithProviders(context.Background(), f.Provider), AgentOptions{Name: "receipt", Model: f.GetModel(), Home: t.TempDir(), NoSkills: true, NoMemory: true, NoSubagents: true, NoSession: true, Schedules: new(false)})
	sub := a.Subscribe()
	t.Cleanup(func() { a.Close(); sub.Close() })
	return a, sub
}
func receipt(t *testing.T, sub *agentcore.Subscription[AgentEvent]) RunResult {
	t.Helper()
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	for {
		select {
		case e, ok := <-sub.C:
			if !ok {
				t.Fatal("stream ended without receipt")
			}
			if settled, ok := e.(AgentSettled); ok {
				return settled.Run
			}
		case <-timer.C:
			t.Fatal("no run receipt")
		}
	}
}

func TestRunReceiptOwnsToolTurnsAndTwoRunUsage(t *testing.T) {
	tool := ai.FauxToolCall("echo", `{}`, "")
	a, sub := receiptAgent(t, billed([]ai.Content{tool}, 10, 2, 3), billed([]ai.Content{tool}, 20, 4, 5), billed("first", 30, 6, 7), billed("second", 40, 8, 9))
	a.Core.SetTools([]agentcore.AgentTool{TextTool(TextToolSpec[struct{}]{Name: "echo", Parameters: agentcore.ObjectSchema(nil), Run: func(context.Context, struct{}, ToolContext) (string, error) { return "ok", nil }})})
	text, err := a.Ask(context.Background(), UserMessage("one"))
	if err != nil || text != "first" {
		t.Fatalf("first: %q %v", text, err)
	}
	first := receipt(t, sub)
	if first.ID != 1 || !first.Settled || first.Usage.Input != 60 || first.Usage.Output != 12 || first.Usage.CacheRead != 15 || first.ContextTokens != 43 {
		t.Fatalf("first receipt %+v", first)
	}
	text, err = a.Ask(context.Background(), UserMessage("two"))
	if err != nil || text != "second" {
		t.Fatalf("second: %q %v", text, err)
	}
	second := receipt(t, sub)
	snap := a.Progress()
	if second.ID != 2 || second.Usage.Input != 40 || snap.Lifetime.Input != 100 || snap.Lifetime.Output != 20 || snap.Lifetime.CacheRead != 24 {
		t.Fatalf("second %+v snapshot %+v", second, snap)
	}
}

func TestRunOutcomeUsesLastModelAndKeepsFailureText(t *testing.T) {
	failed := billed("failed words", 7, 2, 1)
	failed.StopReason = ai.StopError
	failed.ErrorMessage = "broken"
	a, sub := receiptAgent(t, failed, billed("recovered", 3, 1, 0))
	text, err := a.Ask(context.Background(), UserMessage("fail"))
	if err != nil || text != "failed words" {
		t.Fatalf("Ask changed failure text: %q %v", text, err)
	}
	if got := receipt(t, sub); got.Error != "broken" || got.Usage.Input != 7 {
		t.Fatalf("failure receipt %+v", got)
	}
	if _, err := a.Ask(context.Background(), UserMessage("retry")); err != nil {
		t.Fatal(err)
	}
	if got := receipt(t, sub); got.Error != "" || got.Usage.Input != 3 {
		t.Fatalf("later success %+v", got)
	}
	var accounting runAccounting
	accounting.begin()
	accounting.message(failed)
	accounting.message(billed("ok", 3, 1, 0))
	if got := accounting.settle(false); got.Error != "" || got.Usage.Input != 10 {
		t.Fatalf("recovery inside a run %+v", got)
	}
}

func TestConsumedFollowUpResetsAskTextBeforeToolOnlyEnd(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	calls := 0
	f := ai.FauxProvider(ai.FauxProviderOptions{})
	f.AppendResponses(billed([]ai.Content{ai.FauxText("A"), ai.FauxToolCall("echo", `{}`, "")}, 2, 1, 0), billed("A done", 3, 1, 0), billed([]ai.Content{ai.FauxToolCall("echo", `{}`, "")}, 4, 1, 0))
	a := NewAgent(ai.WithProviders(context.Background(), f.Provider), AgentOptions{Name: "follow", Model: f.GetModel(), Home: t.TempDir(), NoSkills: true, NoMemory: true, NoSubagents: true, NoSession: true, Schedules: new(false), MaxSteps: 3, Tools: []agentcore.AgentTool{TextTool(TextToolSpec[struct{}]{Name: "echo", Parameters: agentcore.ObjectSchema(nil), Run: func(context.Context, struct{}, ToolContext) (string, error) {
		calls++
		if calls == 1 {
			close(entered)
			<-release
		}
		return "ok", nil
	}})}})
	defer a.Close()
	sub := a.Subscribe()
	defer sub.Close()
	answer := make(chan string, 1)
	go func() { text, _ := a.Ask(context.Background(), UserMessage("A")); answer <- text }()
	<-entered
	a.Later(UserMessage("B"))
	close(release)
	select {
	case text := <-answer:
		if text != "" {
			t.Fatalf("stale A answer: %q", text)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Ask did not settle")
	}
	result := receipt(t, sub)
	if result.ID != 1 || result.Text != "" || result.Usage.Input != 9 {
		t.Fatalf("follow-up receipt %+v", result)
	}
}

func TestRunSnapshotAndCloseKeepConsumedPartialUsage(t *testing.T) {
	model := ai.Model{ID: "partial", API: "partial", Provider: "test", ContextWindow: 1000}
	m := billed("partial", 7, 3, 2)
	provider := ai.ApiProvider{API: "partial", Stream: func(ctx context.Context, _ ai.Model, _ ai.Context, _ ai.StreamOptions) <-chan ai.AssistantMessageEvent {
		out := make(chan ai.AssistantMessageEvent)
		go func() {
			defer close(out)
			select {
			case out <- ai.AssistantMessageEvent{Type: ai.EventTextDelta, Partial: m, Delta: "partial"}:
			case <-ctx.Done():
				return
			}
			<-ctx.Done()
		}()
		return out
	}}
	a := NewAgent(ai.WithProviders(context.Background(), provider), AgentOptions{Name: "partial", Model: model, Home: t.TempDir(), NoSkills: true, NoMemory: true, NoSubagents: true, NoSession: true, Schedules: new(false)})
	sub := a.Subscribe()
	defer sub.Close()
	a.Send(UserMessage("start"))
	deadline := time.Now().Add(3 * time.Second)
	for a.Progress().Current.Usage.Input != 7 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	live := a.Progress()
	if live.Current.Usage.Input != 7 || live.Current.Settled {
		t.Fatalf("live %+v", live)
	}
	var closing sync.WaitGroup
	for range 8 {
		closing.Go(a.Close)
	}
	closing.Wait()
	final := a.Progress()
	if !final.Current.Settled || !final.Current.Aborted || final.Lifetime.Input != 7 || final.Lifetime.Output != 3 || final.Lifetime.CacheRead != 2 {
		t.Fatalf("closed %+v", final)
	}
	if got := receipt(t, sub); got.Usage.Input != 7 || got.Usage.Output != 3 || got.Text != "partial" {
		t.Fatalf("closed receipt %+v", got)
	}
}

func TestStartedAssistantUsageIsVisibleAndFinalDoesNotDoubleCount(t *testing.T) {
	a := &Agent{}
	message := billed("reported at start", 9, 2, 3)
	a.observeRun(agentcore.AgentStarted{})
	a.observeRun(agentcore.MessageStarted{Message: message})
	if got := a.Progress(); got.Current.Usage.Input != 9 || got.Current.Settled {
		t.Fatalf("consumed start %+v", got)
	}
	a.observeRun(agentcore.MessageEnded{Message: message})
	if got := a.Progress(); got.Lifetime.Input != 9 || got.Current.Usage.Output != 2 {
		t.Fatalf("double counted %+v", got)
	}
}
