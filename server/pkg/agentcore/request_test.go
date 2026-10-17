package agentcore

import (
	"context"
	"encoding/json"
	"testing"
	"vibevalley/pkg/ai"
)

func TestCanceledToolCallDoesNotExecute(t *testing.T) {
	for _, before := range []bool{false, true} {
		ctx, cancel := context.WithCancel(context.Background())
		executed := false
		tool := AgentTool{Name: "write", Execute: func(context.Context, string, json.RawMessage, AgentToolUpdateCallback) (AgentToolResult, error) {
			executed = true
			return TextResult("written"), nil
		}}
		config := AgentLoopConfig{}
		if before {
			config.BeforeToolCall = func(context.Context, BeforeToolCallContext) *BeforeToolCallResult { cancel(); return nil }
		} else {
			cancel()
		}
		_, ok := RunToolCall(ctx, ai.FauxToolCall("write", "{}", "c1"), RunToolCallOptions{Tools: []AgentTool{tool}, Config: config, Emit: func(AgentEvent) {}})
		if ok || executed {
			t.Fatalf("canceled tool executed: before=%v ok=%v executed=%v", before, ok, executed)
		}
	}
}

func TestAfterToolCallClearsBothErrorFlags(t *testing.T) {
	tool := AgentTool{Name: "read", Execute: func(context.Context, string, json.RawMessage, AgentToolUpdateCallback) (AgentToolResult, error) {
		return TextResult("not found", TextResultOptions{IsError: true}), nil
	}}
	var ended AgentEvent
	outcome, ok := RunToolCall(context.Background(), ai.FauxToolCall("read", "{}", "c1"), RunToolCallOptions{Tools: []AgentTool{tool}, Config: AgentLoopConfig{AfterToolCall: func(context.Context, AfterToolCallContext) *AfterToolCallResult {
		success := false
		return &AfterToolCallResult{IsError: &success, Content: []ai.Content{ai.NewText("fallback")}}
	}}, Emit: func(e AgentEvent) {
		if e.Type == EventToolExecutionEnd {
			ended = e
		}
	}})
	if !ok || outcome.IsError || outcome.Result.IsError || ended.IsError || ended.Result.IsError {
		t.Fatalf("contradictory error flags: %+v %+v", outcome, ended)
	}
}

func TestPreparedToolSetIsTheExecutionToolSet(t *testing.T) {
	oldRuns, newRuns := 0, 0
	old := AgentTool{Name: "read", Execute: func(context.Context, string, json.RawMessage, AgentToolUpdateCallback) (AgentToolResult, error) {
		oldRuns++
		return TextResult("old"), nil
	}}
	replacement := AgentTool{Name: "read", Execute: func(context.Context, string, json.RawMessage, AgentToolUpdateCallback) (AgentToolResult, error) {
		newRuns++
		return TextResult("new", TextResultOptions{Terminate: true}), nil
	}}
	config := AgentLoopConfig{
		PrepareRequest: func(_ context.Context, p PrepareRequestContext) *AgentRequestUpdate {
			c := p.Context
			c.Tools = []AgentTool{replacement}
			return &AgentRequestUpdate{Context: &c}
		},
		StreamFn: func(ctx context.Context, m ai.Model, c ai.Context, o ai.StreamOptions) <-chan ai.AssistantMessageEvent {
			answer := ai.NewAnswer(m, "")
			events := answer.Start()
			events = append(events, answer.ToolCall(0, ai.ToolCallPiece{ID: "c1", Name: "read", Args: "{}"})...)
			events = append(events, answer.Done(ai.StopToolUse, ai.RawUsage{})...)
			return ai.FromEvents(ctx, events)
		},
		FinishTurn: func(context.Context, AgentTurnContext) *AgentTurnDecision { return TurnEnd },
	}
	messages := RunAgentLoop(context.Background(), []AgentMessage{user("read")}, AgentContext{Tools: []AgentTool{old}}, config, func(AgentEvent) {})
	if oldRuns != 0 || newRuns != 1 {
		t.Fatalf("wrong tool: old=%d new=%d transcript=%+v", oldRuns, newRuns, messages)
	}
}

func TestSubmitOwnsIdleAndBusyAdmission(t *testing.T) {
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	calls := 0
	a := NewAgent(context.Background(), AgentOptions{AgentLoopConfig: AgentLoopConfig{StreamFn: func(ctx context.Context, m ai.Model, c ai.Context, o ai.StreamOptions) <-chan ai.AssistantMessageEvent {
		calls++
		out := make(chan ai.AssistantMessageEvent)
		first := calls == 1
		go func() {
			defer close(out)
			if first {
				entered <- struct{}{}
				select {
				case <-release:
				case <-ctx.Done():
					return
				}
			}
			answer := ai.NewAnswer(m, "")
			for _, e := range answer.Done(ai.StopStop, ai.RawUsage{}) {
				select {
				case out <- e:
				case <-ctx.Done():
					return
				}
			}
		}()
		return out
	}}})
	defer a.Close()
	done, started := a.Submit(user("first"), true)
	if !started {
		t.Fatal("idle submission not started")
	}
	<-entered
	_, started = a.Submit(user("second"), true)
	close(release)
	if started {
		t.Fatal("busy submission started a second run")
	}
	<-done
	if calls != 2 {
		t.Fatalf("queued message not processed: %d calls", calls)
	}
	var got []string
	for _, m := range a.State().Messages {
		if u, ok := m.(ai.UserMessage); ok {
			got = append(got, u.Content.Text)
		}
	}
	if len(got) != 2 || got[0] != "first" || got[1] != "second" {
		t.Fatal(got)
	}
}
