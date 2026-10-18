package agentcore

import (
	"context"
	"sync"
	"vibevalley/pkg/ai"
)

type toolBatch struct {
	options   RunToolCallOptions
	calls     []ai.Content
	announced map[string]bool
	mu        sync.Mutex
	finished  map[string]AgentToolCallOutcome
	completed *ranTools
}

func newToolBatch(calls []ai.Content, options RunToolCallOptions) *toolBatch {
	return &toolBatch{calls: calls, options: options, announced: map[string]bool{}, finished: map[string]AgentToolCallOutcome{}}
}

// The batch owns execution order and its terminal receipts, including interrupted calls.
func (state *toolBatch) run(ctx context.Context) (ranTools, bool) {
	calls, options := state.calls, state.options
	var runnable []prepared
	for _, call := range calls {
		if ctx.Err() != nil {
			return ranTools{}, false
		}
		state.announced[call.ID] = true
		p := prepare(ctx, call, options)
		if p.tool == nil {
			state.finished[call.ID] = p.outcome
		} else {
			runnable = append(runnable, p)
		}
	}
	sequential := options.Config.ToolExecution == ToolSequential
	for _, p := range runnable {
		if p.tool.ExecutionMode == ToolSequential {
			sequential = true
		}
	}
	finish := func(p prepared) {
		if outcome, ok := execute(ctx, p, options); ok {
			state.mu.Lock()
			state.finished[p.toolCall.ID] = outcome
			state.mu.Unlock()
		}
	}
	if sequential {
		for _, p := range runnable {
			if ctx.Err() != nil {
				break
			}
			finish(p)
		}
	} else {
		var wg sync.WaitGroup
		for _, p := range runnable {
			wg.Add(1)
			go func() {
				defer wg.Done()
				finish(p)
			}()
		}
		wg.Wait()
	}
	if ctx.Err() != nil {
		return ranTools{}, false
	}
	return state.complete(), true
}

// Called after execution has joined, even when it was cancelled.
func (state *toolBatch) complete() ranTools {
	if state.completed != nil {
		return *state.completed
	}
	results := make([]ai.ToolResultMessage, 0, len(state.calls))
	terminate := len(state.calls) > 0
	for _, call := range state.calls {
		outcome, ok := state.finished[call.ID]
		if !ok {
			outcome = AgentToolCallOutcome{ToolCall: call, Result: errorResult(STOPPED), IsError: true}
			if state.announced[call.ID] {
				result := outcome.Result
				state.options.Emit(ToolEnded{ToolCallID: call.ID, ToolName: call.Name, Result: result, IsError: true})
			}
		}
		results = append(results, resultMessage(outcome))
		if !outcome.Result.Terminate {
			terminate = false
		}
	}
	state.completed = &ranTools{results: results, terminate: terminate}
	return *state.completed
}
