package oarruntime

import (
	"context"
	"testing"
	"time"

	"vibevalley/internal/agent/brain"
	"vibevalley/pkg/ai"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

func usageReports(session oar.Session) []oar.UsageReport {
	var reports []oar.UsageReport
	read := observe.EventsReader(func(e oar.Event) {
		if usage, ok := e.Body.(oar.Usage); ok {
			reports = append(reports, usage.Usage)
		}
	})
	for _, record := range session.Records() {
		read(record)
	}
	return reports
}
func TestRuntimeUsageAccumulatesAcrossOwnedRuns(t *testing.T) {
	first := ai.FauxAssistantMessage("first")
	first.Usage = ai.Usage{Input: 11, Output: 2, CacheRead: 3, CacheWrite: 1, TotalTokens: 17}
	second := ai.FauxAssistantMessage("second")
	second.Usage = ai.Usage{Input: 7, Output: 4, CacheRead: 5, CacheWrite: 2, TotalTokens: 18}
	r := open(t, []ai.FauxResponseStep{first, second}, openOptions{})
	defer r.session.Dispose(context.Background())
	r.session.Prompt(context.Background(), "one", oar.InputOptions{})
	r.untilTurns(1)
	r.session.Prompt(context.Background(), "two", oar.InputOptions{})
	r.untilTurns(2)
	reports := usageReports(r.session)
	if len(reports) != 2 || reports[0].Tokens.Input != 11 || reports[1].Tokens.Input != 18 || reports[1].Tokens.Output != 6 || *reports[1].Tokens.CacheRead != 8 || *reports[1].Tokens.CacheWrite != 3 {
		t.Fatalf("usage %+v", reports)
	}
	if *reports[1].Context.Tokens != 16 {
		t.Fatalf("last context %+v", reports[1].Context)
	}
}
func TestDisposeReportsAlreadyConsumedPartialUsage(t *testing.T) {
	model := ai.Model{ID: "partial", API: "partial", Provider: "test", ContextWindow: 1000}
	message := ai.FauxAssistantMessage("partial")
	message.Usage = ai.Usage{Input: 13, Output: 4, CacheRead: 2, CacheWrite: 1, TotalTokens: 20}
	provider := ai.ApiProvider{API: "partial", Stream: func(ctx context.Context, _ ai.Model, _ ai.Context, _ ai.StreamOptions) <-chan ai.AssistantMessageEvent {
		out := make(chan ai.AssistantMessageEvent)
		go func() {
			defer close(out)
			select {
			case out <- ai.AssistantMessageEvent{Type: ai.EventTextDelta, Partial: message, Delta: "partial"}:
			case <-ctx.Done():
				return
			}
			<-ctx.Done()
		}()
		return out
	}}
	runtime := VibeValleyRuntime(Options{Home: func() string { return t.TempDir() }, Llm: func(context.Context, string) (brain.LLM, error) { return brain.LLM{Model: model}, nil }, Providers: []ai.ApiProvider{provider}})
	session, err := runtime.Session(context.Background(), oar.AvailableInstallation{}, oar.SessionOptions{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	session.Prompt(context.Background(), "start", oar.InputOptions{})
	seen := make(chan struct{}, 1)
	unsubscribe := session.Events(func(e oar.Event) {
		if _, ok := e.Body.(oar.TextDelta); ok {
			select {
			case seen <- struct{}{}:
			default:
			}
		}
	}, oar.EventsOptions{Cursor: &oar.Cursor{SessionID: session.ID(), AfterSeq: -1}})
	defer unsubscribe()
	select {
	case <-seen:
	case <-time.After(3 * time.Second):
		t.Fatal("no partial received")
	}
	if err := session.Dispose(context.Background()); err != nil {
		t.Fatal(err)
	}
	reports := usageReports(session)
	if len(reports) != 1 || reports[0].Tokens.Input != 13 || reports[0].Tokens.Output != 4 || *reports[0].Tokens.CacheRead != 2 || *reports[0].Tokens.CacheWrite != 1 {
		t.Fatalf("dispose lost consumed usage: %+v", reports)
	}
	if *reports[0].Context.Tokens != 19 {
		t.Fatalf("dispose context %+v", reports[0].Context)
	}
}
