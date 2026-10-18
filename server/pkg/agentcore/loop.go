package agentcore

// Runs as pi-agent-core runs it: another turn follows while the model asked for tools (unless every result said terminate), while steering waits, or
// when FinishTurn says continue; when it would stop, follow-ups start it again.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
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
	options.Emit(ToolStarted{ToolCallID: toolCall.ID, ToolName: toolCall.Name, Args: toolCall.Args()})
	answered := func(result AgentToolResult) prepared {
		options.Emit(ToolEnded{ToolCallID: toolCall.ID, ToolName: toolCall.Name, Result: result, IsError: true})
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
		options.Emit(ToolUpdated{ToolCallID: p.toolCall.ID, ToolName: p.toolCall.Name, Args: p.args, PartialResult: partial})
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
	options.Emit(ToolEnded{ToolCallID: p.toolCall.ID, ToolName: p.toolCall.Name, Result: result, IsError: isError, DurationMs: &duration})
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
	response  *ai.Response
	announced bool
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
	toolsOf       *toolBatch
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
	r.emit(MessageStarted{Message: m})
	r.emit(MessageEnded{Message: m})
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
	r.answering = &answering{response: ai.NewResponse(model)}
	for e := range streamFn(ctx, model, ai.Context{SystemPrompt: request.SystemPrompt, Messages: llm, Tools: tools}, options) {
		if r.stopping() {
			// Drained, not said: the stop says what came so far.
			continue
		}
		r.answering.response.Observe(e)
		switch e.Type {
		case ai.EventStart:
			partial := e.Partial
			r.answering.announced = true
			r.emit(MessageStarted{Message: partial})
		case ai.EventDone, ai.EventError:
		default:
			partial := e.Partial
			event := e
			r.emit(MessageUpdated{Message: partial, Delta: event})
		}
	}
	if r.stopping() {
		return ai.AssistantMessage{}, false
	}
	message := r.answering.response.Result()
	if !r.answering.announced {
		r.emit(MessageStarted{Message: message})
	}
	r.answering = nil
	r.lastAssistant = &message
	r.emit(MessageEnded{Message: message})
	r.append(message)
	return message, true
}

type ranTools struct {
	results   []ai.ToolResultMessage
	terminate bool
}

func (r *loopRun) runTools(assistantMessage ai.AssistantMessage, calls []ai.Content) (ranTools, bool) {
	batch := newToolBatch(calls, RunToolCallOptions{Tools: r.requestTools, AssistantMessage: assistantMessage, Context: r.snapshot(), Config: r.config, Emit: r.emit})
	r.toolsOf = batch
	result, ok := batch.run(r.ctx)
	if !ok {
		return ranTools{}, false
	}
	r.toolsOf = nil
	for _, message := range result.results {
		r.say(message)
	}
	return result, true
}

func (r *loopRun) run(prompts []AgentMessage, steerFirst bool) []AgentMessage {
	r.emit(AgentStarted{})
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
			r.emit(TurnStarted{})
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
			r.emit(TurnEnded{Message: answer, ToolResults: ran.results})
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
	r.emit(AgentEnded{Messages: r.freshCopy()})
	return r.freshCopy()
}

func (r *loopRun) stopped() []AgentMessage {
	if r.answering != nil {
		message := r.answering.response.Aborted()
		if !r.answering.announced {
			r.emit(MessageStarted{Message: message})
		}
		r.emit(MessageEnded{Message: message})
		r.append(message)
		r.lastAssistant = &message
		r.answering = nil
	}
	results := []ai.ToolResultMessage{}
	if state := r.toolsOf; state != nil {
		results = state.complete().results
		r.toolsOf = nil
		for _, m := range results {
			r.say(m)
		}
	}
	if r.inTurn && r.lastAssistant != nil {
		r.emit(TurnEnded{Message: *r.lastAssistant, ToolResults: results})
	}
	r.inTurn = false
	r.emit(AgentEnded{Messages: r.freshCopy(), Aborted: true})
	return r.freshCopy()
}
