package agentcore

// Runs as pi-agent-core runs it: another turn follows while the model asked for tools (unless every result said terminate), while steering waits, or
// when FinishTurn says continue; when it would stop, follow-ups start it again.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"vibevalley/pkg/ai"
)

// Called from several goroutines (tools in parallel); must not block for long.
type AgentEventSink func(event AgentEvent)

var modelRoles = map[string]bool{"system": true, "user": true, "assistant": true, "toolResult": true}

func DefaultConvertToLlm(_ context.Context, messages []AgentMessage) []ai.Message {
	out := []ai.Message{}
	for _, m := range messages {
		if llm, ok := m.(ai.Message); ok && modelRoles[m.Role()] {
			out = append(out, llm)
		}
	}
	return out
}

const STOPPED = "已停下"

func errorResult(text string) AgentToolResult {
	return AgentToolResult{Content: []ai.Content{ai.NewText(text)}, IsError: true}
}

func now() int64 { return time.Now().UnixMilli() }

func resultMessage(outcome AgentToolCallOutcome) ai.ToolResultMessage {
	content := outcome.Result.Content
	if content == nil {
		content = []ai.Content{}
	}
	return ai.ToolResultMessage{
		ToolCallID: outcome.ToolCall.ID, ToolName: outcome.ToolCall.Name, Content: content, Details: outcome.Result.Details,
		IsError: outcome.IsError, Timestamp: now(), DurationMs: outcome.DurationMs,
	}
}

type RunToolCallOptions struct {
	Tools            []AgentTool
	AssistantMessage ai.AssistantMessage
	Context          AgentContext
	Config           AgentLoopConfig
	Emit             AgentEventSink
}

type prepared struct {
	toolCall ai.Content
	tool     *AgentTool
	args     json.RawMessage
	outcome  AgentToolCallOutcome
}

func prepare(ctx context.Context, toolCall ai.Content, options RunToolCallOptions) prepared {
	options.Emit(AgentEvent{Type: EventToolExecutionStart, ToolCallID: toolCall.ID, ToolName: toolCall.Name, Args: toolCall.Args()})
	answered := func(result AgentToolResult) prepared {
		options.Emit(AgentEvent{Type: EventToolExecutionEnd, ToolCallID: toolCall.ID, ToolName: toolCall.Name, Result: &result, IsError: true})
		return prepared{toolCall: toolCall, outcome: AgentToolCallOutcome{ToolCall: toolCall, Result: result, IsError: true}}
	}
	var tool *AgentTool
	names := make([]string, 0, len(options.Tools))
	for i := range options.Tools {
		names = append(names, options.Tools[i].Name)
		if tool == nil && options.Tools[i].Name == toolCall.Name {
			tool = &options.Tools[i]
		}
	}
	if tool == nil {
		have := strings.Join(names, "、")
		if have == "" {
			have = "（没有）"
		}
		return answered(errorResult(fmt.Sprintf("没有叫 %s 的工具。有：%s", toolCall.Name, have)))
	}
	args, err := DecodeArguments(*tool, toolCall.Args())
	if err != nil {
		return answered(errorResult(err.Error()))
	}
	if options.Config.BeforeToolCall != nil {
		before := options.Config.BeforeToolCall(ctx, BeforeToolCallContext{AssistantMessage: options.AssistantMessage, ToolCall: toolCall, Args: args, Context: options.Context})
		if before != nil && before.Block {
			reason := before.Reason
			if reason == "" {
				reason = toolCall.Name + " 不让用"
			}
			result := errorResult(reason)
			result.Terminate = before.Terminate
			return answered(result)
		}
	}
	return prepared{toolCall: toolCall, tool: tool, args: args}
}

func runTool(ctx context.Context, tool *AgentTool, id string, args json.RawMessage, onUpdate AgentToolUpdateCallback) (result AgentToolResult, isError bool) {
	defer func() {
		if recovered := recover(); recovered != nil {
			why := fmt.Sprint(recovered)
			if err, ok := recovered.(error); ok {
				why = err.Error()
			}
			result, isError = errorResult("工具出错："+why), true
		}
	}()
	if tool.Execute == nil {
		return errorResult("工具出错：" + tool.Name + " 不能跑"), true
	}
	r, err := tool.Execute(ctx, id, args, onUpdate)
	if err != nil {
		return errorResult(err.Error()), true
	}
	return r, r.IsError
}

// Nothing is said when the run was stopped meanwhile: the stop answers it.
func execute(ctx context.Context, p prepared, options RunToolCallOptions) (AgentToolCallOutcome, bool) {
	if ctx.Err() != nil {
		return AgentToolCallOutcome{}, false
	}
	started := time.Now()
	onUpdate := func(partial AgentToolResult) {
		if ctx.Err() != nil {
			return
		}
		options.Emit(AgentEvent{Type: EventToolExecutionUpdate, ToolCallID: p.toolCall.ID, ToolName: p.toolCall.Name, Args: p.args, PartialResult: &partial})
	}
	result, isError := runTool(ctx, p.tool, p.toolCall.ID, p.args, onUpdate)
	if ctx.Err() != nil {
		return AgentToolCallOutcome{}, false
	}
	if options.Config.AfterToolCall != nil {
		after := options.Config.AfterToolCall(ctx, AfterToolCallContext{
			BeforeToolCallContext: BeforeToolCallContext{AssistantMessage: options.AssistantMessage, ToolCall: p.toolCall, Args: p.args, Context: options.Context},
			Result:                result,
			IsError:               isError,
		})
		if after != nil {
			if after.IsError != nil {
				isError = *after.IsError
			}
			if after.Content != nil {
				result.Content = after.Content
			}
			if after.HasDetails {
				result.Details = after.Details
			}
			if after.Usage != nil {
				result.Usage = after.Usage
			}
			if after.Terminate != nil {
				result.Terminate = *after.Terminate
			}
		}
	}
	result.IsError = isError
	duration := time.Since(started).Milliseconds()
	options.Emit(AgentEvent{Type: EventToolExecutionEnd, ToolCallID: p.toolCall.ID, ToolName: p.toolCall.Name, Result: &result, IsError: isError, DurationMs: &duration})
	return AgentToolCallOutcome{ToolCall: p.toolCall, Result: result, IsError: isError, DurationMs: &duration}, true
}

func RunToolCall(ctx context.Context, toolCall ai.Content, options RunToolCallOptions) (AgentToolCallOutcome, bool) {
	if ctx.Err() != nil {
		return AgentToolCallOutcome{}, false
	}
	p := prepare(ctx, toolCall, options)
	if p.tool == nil {
		return p.outcome, true
	}
	return execute(ctx, p, options)
}

func RunAgentLoop(ctx context.Context, prompts []AgentMessage, c AgentContext, config AgentLoopConfig, emit AgentEventSink) []AgentMessage {
	return newRun(ctx, c, config, emit).run(prompts, false)
}

// The last message must be the user's or a tool's; steering is taken first.
func RunAgentLoopContinue(ctx context.Context, c AgentContext, config AgentLoopConfig, emit AgentEventSink) []AgentMessage {
	return newRun(ctx, c, config, emit).run(nil, true)
}

// The channel closes after agent_end.
func AgentLoop(ctx context.Context, prompts []AgentMessage, c AgentContext, config AgentLoopConfig) <-chan AgentEvent {
	return asStream(func(emit AgentEventSink) { RunAgentLoop(ctx, prompts, c, config, emit) })
}

func AgentLoopContinue(ctx context.Context, c AgentContext, config AgentLoopConfig) <-chan AgentEvent {
	return asStream(func(emit AgentEventSink) { RunAgentLoopContinue(ctx, c, config, emit) })
}

func asStream(body func(emit AgentEventSink)) <-chan AgentEvent {
	hub := NewHub[AgentEvent]()
	sub := hub.Subscribe()
	go func() {
		defer hub.Close()
		body(hub.Publish)
	}()
	return sub.C
}

func reasoningOf(level ThinkingLevel) ThinkingLevel {
	if level == "" || level == "off" {
		return ""
	}
	return level
}

type answering struct {
	partial   *ai.AssistantMessage
	announced bool
}

type toolsState struct {
	calls     []ai.Content
	announced map[string]bool
	mu        sync.Mutex
	finished  map[string]AgentToolCallOutcome
}

type loopRun struct {
	ctx          context.Context
	context      AgentContext
	config       AgentLoopConfig
	emit         AgentEventSink
	messages     []AgentMessage
	fresh        []AgentMessage
	tools        []AgentTool
	requestTools []AgentTool

	// Where the run is, for a stop to end it properly.
	answering     *answering
	lastAssistant *ai.AssistantMessage
	toolsOf       *toolsState
	inTurn        bool
}

func newRun(ctx context.Context, c AgentContext, config AgentLoopConfig, emit AgentEventSink) *loopRun {
	return &loopRun{ctx: ctx, context: c, config: config, emit: emit, messages: append([]AgentMessage(nil), c.Messages...), tools: c.Tools}
}

func (r *loopRun) append(m AgentMessage) {
	r.messages = append(r.messages, m)
	r.fresh = append(r.fresh, m)
}

func (r *loopRun) say(m AgentMessage) {
	r.emit(AgentEvent{Type: EventMessageStart, Message: m})
	r.emit(AgentEvent{Type: EventMessageEnd, Message: m})
	r.append(m)
}

func (r *loopRun) snapshot() AgentContext {
	return AgentContext{SystemPrompt: r.context.SystemPrompt, Messages: append([]AgentMessage(nil), r.messages...), Tools: r.tools}
}

func (r *loopRun) freshCopy() []AgentMessage { return append([]AgentMessage{}, r.fresh...) }

func (r *loopRun) steering() []AgentMessage {
	if r.config.GetSteeringMessages == nil {
		return nil
	}
	return r.config.GetSteeringMessages()
}

func (r *loopRun) followUps() []AgentMessage {
	if r.config.GetFollowUpMessages == nil {
		return nil
	}
	return r.config.GetFollowUpMessages()
}

func (r *loopRun) stopping() bool { return r.ctx.Err() != nil }

func emptyAnswer(model ai.Model) ai.AssistantMessage {
	return ai.AssistantMessage{Content: []ai.Content{}, API: model.API, Provider: model.Provider, Model: model.ID, Usage: ai.EmptyUsage(), StopReason: ai.StopStop, Timestamp: now()}
}

func (r *loopRun) respond() (ai.AssistantMessage, bool) {
	ctx := r.ctx
	request := r.snapshot()
	model := r.config.Model
	thinkingLevel := r.config.ThinkingLevel
	if thinkingLevel == "" {
		thinkingLevel = "off"
	}
	if r.config.PrepareRequest != nil {
		update := r.config.PrepareRequest(ctx, PrepareRequestContext{Context: request, Model: model, ThinkingLevel: thinkingLevel})
		if update != nil {
			if update.Context != nil {
				request = *update.Context
			}
			if update.Model != nil {
				model = *update.Model
			}
			if update.ThinkingLevel != "" {
				thinkingLevel = update.ThinkingLevel
			}
		}
	}
	if r.stopping() {
		return ai.AssistantMessage{}, false
	}
	transformed := request.Messages
	if r.config.TransformContext != nil {
		transformed = r.config.TransformContext(ctx, request.Messages)
	}
	if r.stopping() {
		return ai.AssistantMessage{}, false
	}
	convert := r.config.ConvertToLlm
	if convert == nil {
		convert = DefaultConvertToLlm
	}
	llm := convert(ctx, transformed)
	apiKey := ""
	if r.config.GetApiKey != nil {
		apiKey = r.config.GetApiKey(ctx, model.Provider)
	}
	if r.stopping() {
		return ai.AssistantMessage{}, false
	}
	r.requestTools = append([]AgentTool(nil), request.Tools...)
	tools := make([]ai.Tool, 0, len(request.Tools))
	for _, t := range request.Tools {
		tools = append(tools, ToolOf(t))
	}
	options := r.config.StreamOptions
	if apiKey != "" {
		options.APIKey = apiKey
	}
	options.Reasoning = reasoningOf(thinkingLevel)
	streamFn := r.config.StreamFn
	if streamFn == nil {
		streamFn = ai.Stream
	}
	r.answering = &answering{}
	var final *ai.AssistantMessage
	for e := range streamFn(ctx, model, ai.Context{SystemPrompt: request.SystemPrompt, Messages: llm, Tools: tools}, options) {
		if r.stopping() {
			// Drained, not said: the stop says what came so far.
			continue
		}
		switch e.Type {
		case ai.EventStart:
			partial := e.Partial
			r.answering = &answering{partial: &partial, announced: true}
			r.emit(AgentEvent{Type: EventMessageStart, Message: partial})
		case ai.EventDone:
			m := e.Message
			final = &m
		case ai.EventError:
			m := e.Error
			final = &m
		default:
			partial := e.Partial
			r.answering = &answering{partial: &partial, announced: r.answering.announced}
			event := e
			r.emit(AgentEvent{Type: EventMessageUpdate, Message: partial, AssistantMessageEvent: &event})
		}
	}
	if r.stopping() {
		return ai.AssistantMessage{}, false
	}
	var message ai.AssistantMessage
	if final != nil {
		message = *final
	} else {
		if r.answering.partial != nil {
			message = *r.answering.partial
		} else {
			message = emptyAnswer(model)
		}
		message.StopReason = ai.StopError
		message.ErrorMessage = "模型没有回答完"
	}
	if !r.answering.announced {
		r.emit(AgentEvent{Type: EventMessageStart, Message: message})
	}
	r.answering = nil
	r.lastAssistant = &message
	r.emit(AgentEvent{Type: EventMessageEnd, Message: message})
	r.append(message)
	return message, true
}

type ranTools struct {
	results   []ai.ToolResultMessage
	terminate bool
}

// Results go in the model's order.
func (r *loopRun) runTools(assistantMessage ai.AssistantMessage, calls []ai.Content) (ranTools, bool) {
	ctx := r.ctx
	state := &toolsState{calls: calls, announced: map[string]bool{}, finished: map[string]AgentToolCallOutcome{}}
	r.toolsOf = state
	options := RunToolCallOptions{Tools: r.requestTools, AssistantMessage: assistantMessage, Context: r.snapshot(), Config: r.config, Emit: r.emit}
	var runnable []prepared
	for _, call := range calls {
		if r.stopping() {
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
	sequential := r.config.ToolExecution == ToolSequential
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
			if r.stopping() {
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
	if r.stopping() {
		return ranTools{}, false
	}
	results := make([]ai.ToolResultMessage, 0, len(calls))
	terminate := len(calls) > 0
	for _, call := range calls {
		outcome := state.finished[call.ID]
		results = append(results, resultMessage(outcome))
		if !outcome.Result.Terminate {
			terminate = false
		}
	}
	r.toolsOf = nil
	for _, m := range results {
		r.say(m)
	}
	return ranTools{results: results, terminate: terminate}, true
}

func (r *loopRun) run(prompts []AgentMessage, steerFirst bool) []AgentMessage {
	r.emit(AgentEvent{Type: EventAgentStart})
	pending := prompts
	if steerFirst {
		pending = r.steering()
	}
outer:
	for {
		for {
			if r.stopping() {
				return r.stopped()
			}
			r.inTurn = true
			r.lastAssistant = nil
			r.emit(AgentEvent{Type: EventTurnStart})
			for _, m := range pending {
				r.say(m)
			}
			pending = nil
			answer, ok := r.respond()
			if !ok {
				return r.stopped()
			}
			failed := answer.StopReason == ai.StopError || answer.StopReason == ai.StopAborted
			var calls []ai.Content
			if !failed {
				calls = answer.ToolCalls()
			}
			ran := ranTools{results: []ai.ToolResultMessage{}}
			if len(calls) > 0 {
				if ran, ok = r.runTools(answer, calls); !ok {
					return r.stopped()
				}
			}
			var decision *AgentTurnDecision
			if r.config.FinishTurn != nil {
				decision = r.config.FinishTurn(r.ctx, AgentTurnContext{Message: answer, ToolResults: ran.results, Context: r.snapshot(), NewMessages: r.freshCopy()})
			}
			if r.stopping() {
				return r.stopped()
			}
			r.inTurn = false
			r.emit(AgentEvent{Type: EventTurnEnd, Message: answer, ToolResults: ran.results})
			// An error or an abort ends the run, whatever was decided or is waiting.
			if failed || (decision != nil && decision.Action == "end") {
				break outer
			}
			pending = r.steering()
			if len(pending) > 0 {
				continue
			}
			if (len(calls) > 0 && !ran.terminate) || (decision != nil && decision.Action == "continue") {
				continue
			}
			break
		}
		if r.stopping() {
			return r.stopped()
		}
		pending = r.followUps()
		if len(pending) == 0 {
			break
		}
	}
	r.emit(AgentEvent{Type: EventAgentEnd, Messages: r.freshCopy()})
	return r.freshCopy()
}

func (r *loopRun) stopped() []AgentMessage {
	if r.answering != nil {
		var message ai.AssistantMessage
		if r.answering.partial != nil {
			message = *r.answering.partial
		} else {
			message = emptyAnswer(r.config.Model)
		}
		message.StopReason = ai.StopAborted
		message.ErrorMessage = STOPPED
		if !r.answering.announced {
			r.emit(AgentEvent{Type: EventMessageStart, Message: message})
		}
		r.emit(AgentEvent{Type: EventMessageEnd, Message: message})
		r.append(message)
		r.lastAssistant = &message
		r.answering = nil
	}
	results := []ai.ToolResultMessage{}
	if state := r.toolsOf; state != nil {
		state.mu.Lock()
		finished := state.finished
		state.mu.Unlock()
		for _, call := range state.calls {
			outcome, ok := finished[call.ID]
			if !ok {
				outcome = AgentToolCallOutcome{ToolCall: call, Result: errorResult(STOPPED), IsError: true}
				if state.announced[call.ID] {
					result := outcome.Result
					r.emit(AgentEvent{Type: EventToolExecutionEnd, ToolCallID: call.ID, ToolName: call.Name, Result: &result, IsError: true})
				}
			}
			results = append(results, resultMessage(outcome))
		}
		r.toolsOf = nil
		for _, m := range results {
			r.say(m)
		}
	}
	if r.inTurn && r.lastAssistant != nil {
		r.emit(AgentEvent{Type: EventTurnEnd, Message: *r.lastAssistant, ToolResults: results})
	}
	r.inTurn = false
	r.emit(AgentEvent{Type: EventAgentEnd, Messages: r.freshCopy()})
	return r.freshCopy()
}
