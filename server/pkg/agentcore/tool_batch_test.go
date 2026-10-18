package agentcore

import (
	"context"
	"encoding/json"
	"testing"

	"vibevalley/pkg/ai"
)

func TestToolBatchOwnsTerminalReceiptsOnce(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ended := map[string]int{}
	tools := []AgentTool{
		{Name: "complete", Execute: func(context.Context, string, json.RawMessage, AgentToolUpdateCallback) (AgentToolResult, error) {
			return TextResult("done"), nil
		}},
		{Name: "cancel", Execute: func(context.Context, string, json.RawMessage, AgentToolUpdateCallback) (AgentToolResult, error) {
			cancel()
			return AgentToolResult{}, ctx.Err()
		}},
	}
	calls := []ai.Content{ai.FauxToolCall("complete", "{}", "first"), ai.FauxToolCall("cancel", "{}", "second")}
	batch := newToolBatch(calls, RunToolCallOptions{Tools: tools, Config: AgentLoopConfig{AgentConfig: AgentConfig{ToolExecution: ToolSequential}}, Emit: func(e AgentEvent) {
		if e, ok := e.(ToolEnded); ok {
			ended[e.ToolCallID]++
		}
	}})
	if _, ok := batch.run(ctx); ok {
		t.Fatal("cancelled batch reported completion")
	}
	for range 2 {
		receipts := batch.complete().results
		if len(receipts) != 2 || receipts[0].IsError || !receipts[1].IsError || receipts[0].ToolCallID != "first" || receipts[1].ToolCallID != "second" {
			t.Fatalf("receipts: %+v", receipts)
		}
	}
	if ended["first"] != 1 || ended["second"] != 1 {
		t.Fatalf("duplicate terminal event: %v", ended)
	}
}
