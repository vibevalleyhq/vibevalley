package pi

import (
	"encoding/json"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// The pi event → record projection as a pure fold (projection.ts). Every pi
// event becomes exactly one frame: the event verbatim as Native, its type as
// Type, and the events OAR read out of it. Nothing is gated on turn state and
// nothing is dropped. pi has no native turn id and no native sub-agents.
//
// pi's RPC mode streams the same session events its SDK emits (pi 1.1.0
// docs/json.md), so the fold reads them unchanged.

// ProjectionState is the fold's state.
type ProjectionState struct {
	ReasoningHadText bool
	ProviderError    *ProviderError
	// The running total of this Session's assistant messages.
	Tokens oar.TokenTotals
}

// Prompted: a prompt (or a drained queue input) resets the per-run
// accumulators; the running token total stays.
func Prompted(state ProjectionState) ProjectionState {
	return ProjectionState{Tokens: state.Tokens}
}

// RunOutcome: pi's settlement reports cancellation; preceding provider events supply error details.
func RunOutcome(state ProjectionState, aborted bool) oar.TurnOutcome {
	if aborted {
		return oar.AbortedOutcome()
	}
	if state.ProviderError != nil {
		return Failure(*state.ProviderError)
	}
	return oar.Completed()
}

// FoldExtra is what the adapter supplies alongside an event: pi's context
// fullness read at agent_settled (nil: none), and whether the failed
// assistant message the event carries is a context overflow.
type FoldExtra struct {
	Context  *oar.ContextUsage
	Overflow bool
}

// jsonDetail is JSON.stringify of a native field, in pi's own key order; nil when absent.
func jsonDetail(raw map[string]json.RawMessage, key string) *string {
	value, present := raw[key]
	if !present {
		return nil
	}
	text := jsonx.Stringify(value)
	return &text
}

func foldMessageUpdate(state ProjectionState, inner jsonx.Record, overflow bool) (ProjectionState, []oar.EventBody) {
	switch jsonx.Str(inner, "type") {
	case "text_delta":
		return state, []oar.EventBody{oar.TextDelta{Text: jsonx.Str(inner, "delta")}}
	case "thinking_delta":
		delta := jsonx.Str(inner, "delta")
		if delta == "" {
			return state, nil
		}
		state.ReasoningHadText = true
		return state, []oar.EventBody{oar.Reasoning{Content: oar.ReasoningContent{Kind: "text", Text: delta}}}
	case "error":
		// pi's prompt resolves even when the provider errored; the failure
		// only surfaces here.
		errorMessage := jsonx.AsRecord(inner["error"])
		message, ok := jsonx.StrOK(errorMessage, "errorMessage")
		if !ok {
			message = jsonx.Str(inner, "reason")
		}
		state.ProviderError = &ProviderError{Message: message, Overflow: overflow}
		return state, nil
	case "thinking_start":
		state.ReasoningHadText = false
		return state, nil
	case "thinking_end":
		if state.ReasoningHadText {
			return state, nil
		}
		return state, []oar.EventBody{oar.Reasoning{Content: oar.ReasoningContent{Kind: "empty"}}}
	}
	return state, nil
}

func number(record jsonx.Record, key string) int64 {
	value, _ := jsonx.Num(record, key)
	return int64(value)
}

// accumulate: cumulative per-session tokens after an assistant message's own usage.
func accumulate(state ProjectionState, message any) (ProjectionState, []oar.EventBody) {
	record := jsonx.AsRecord(message)
	usage := jsonx.AsRecord(record["usage"])
	if record["role"] != "assistant" || usage == nil {
		return state, nil
	}
	// pi's input excludes cache reads and writes, so input counts them back
	// in; each also stands as its own part.
	cacheRead := jsonx.Int64(usage, "cacheRead")
	cacheWrite := jsonx.Int64(usage, "cacheWrite")
	input := number(usage, "input")
	if cacheRead != nil {
		input += *cacheRead
	}
	if cacheWrite != nil {
		input += *cacheWrite
	}
	report := oar.TokenTotals{Input: input, Output: number(usage, "output"), Reasoning: jsonx.Int64(usage, "reasoning"), CacheRead: cacheRead, CacheWrite: cacheWrite}
	state.Tokens = observe.AddTokens(state.Tokens, report)
	tokens := state.Tokens
	return state, []oar.EventBody{oar.Usage{Usage: oar.UsageReport{Tokens: &tokens}}}
}

func userText(content any) string {
	if text, ok := content.(string); ok {
		return text
	}
	joined := ""
	for _, part := range jsonx.AsRecordList(content) {
		if part["type"] == "text" {
			joined += jsonx.Str(part, "text")
		}
	}
	return joined
}

func step(state ProjectionState, native json.RawMessage, event jsonx.Record, extra FoldExtra) (ProjectionState, []oar.EventBody) {
	switch jsonx.Str(event, "type") {
	case "agent_settled":
		// pi's run-settled signal is the turn's end, not agent_end, which
		// precedes threshold compaction and auto-retries.
		aborted, _ := jsonx.Bool(event, "aborted")
		events := []oar.EventBody{oar.TurnEnded{Outcome: RunOutcome(state, aborted)}}
		if extra.Context != nil {
			events = append(events, oar.Usage{Usage: oar.UsageReport{Context: extra.Context}})
		}
		return Prompted(state), events
	case "message_update":
		return foldMessageUpdate(state, jsonx.AsRecord(event["assistantMessageEvent"]), extra.Overflow)
	case "message_end":
		return accumulate(state, event["message"])
	case "tool_execution_start":
		return state, []oar.EventBody{oar.ToolCallStarted{CallID: jsonx.Str(event, "toolCallId"), Tool: jsonx.Str(event, "toolName"), Input: jsonDetail(jsonx.RawFields(native), "args")}}
	case "tool_execution_update":
		return state, []oar.EventBody{oar.ToolCallProgress{CallID: jsonx.Str(event, "toolCallId"), Output: jsonDetail(jsonx.RawFields(native), "partialResult")}}
	case "compaction_start":
		return state, []oar.EventBody{oar.CompactionStarted{Trigger: jsonx.Str(event, "reason")}}
	case "compaction_end":
		outcome := "completed"
		reason, failed := jsonx.StrOK(event, "errorMessage")
		if aborted, _ := jsonx.Bool(event, "aborted"); aborted {
			outcome = "aborted"
		} else if failed {
			outcome = "failed"
		}
		ended := oar.CompactionEnded{Outcome: outcome, Trigger: jsonx.Str(event, "reason")}
		if failed {
			ended.Reason = reason
		}
		return state, []oar.EventBody{ended}
	case "thinking_level_changed":
		return state, []oar.EventBody{oar.Effort{Effort: jsonx.Str(event, "level")}}
	case "auto_retry_start", "summarization_retry_scheduled":
		attempt, _ := jsonx.Num(event, "attempt")
		retry := oar.Retry{Attempt: int(attempt), Reason: jsonx.Str(event, "errorMessage")}
		if maxAttempts, ok := jsonx.Num(event, "maxAttempts"); ok {
			value := int(maxAttempts)
			retry.MaxAttempts = &value
		}
		retry.DelayMs = jsonx.Int64(event, "delayMs")
		return state, []oar.EventBody{retry}
	case "tool_execution_end":
		// An AgentToolResult's content blocks are the result; details stay in the native frame.
		result := event["result"]
		var content []oar.ToolOutputPart
		if blocks := jsonx.AsList(jsonx.AsRecord(result)["content"]); len(blocks) > 0 {
			content = oar.ToolContent(blocks)
		} else {
			content = oar.ToolContent(result)
		}
		ended := oar.ToolCallEnded{CallID: jsonx.Str(event, "toolCallId"), Content: content}
		if isError, ok := jsonx.Bool(event, "isError"); ok {
			ended.Result = "ok"
			if isError {
				ended.Result = "failed"
			}
		}
		return state, []oar.EventBody{ended}
	case "turn_end":
		// A provider failure surfaces only as stopReason "error" on the turn's final assistant message.
		message := jsonx.AsRecord(event["message"])
		if message["role"] == "assistant" && message["stopReason"] == "error" {
			text, ok := jsonx.StrOK(message, "errorMessage")
			if !ok {
				text = "provider error"
			}
			state.ProviderError = &ProviderError{Message: text, Overflow: extra.Overflow}
		}
		return state, nil
	case "message_start":
		message := jsonx.AsRecord(event["message"])
		if message["role"] == "user" {
			return state, []oar.EventBody{oar.UserMessage{Evidence: "conversation", Input: userText(message["content"])}}
		}
		return state, nil
	case "agent_start":
		return state, []oar.EventBody{oar.TurnActive{}}
	}
	// agent_end, turn_start, bash_execution_update, queue_update,
	// entry_appended, session_info_changed, auto_retry_end, the
	// summarization retry boundaries and anything newer: a frame with no event.
	return state, nil
}

// FoldEvent folds one pi event into the next state plus the one frame it produces.
func FoldEvent(state ProjectionState, native json.RawMessage, event jsonx.Record, extra FoldExtra) (ProjectionState, oar.FrameBody) {
	next, events := step(state, native, event, extra)
	return next, oar.FrameBody{Type: jsonx.Str(event, "type"), Native: native, Events: events}
}

// OverflowOf says whether an event carries a failed assistant message that is a context overflow.
func OverflowOf(event jsonx.Record) bool {
	switch jsonx.Str(event, "type") {
	case "turn_end":
		message := jsonx.AsRecord(event["message"])
		return message["role"] == "assistant" && IsContextOverflow(message)
	case "message_update":
		inner := jsonx.AsRecord(event["assistantMessageEvent"])
		return jsonx.Str(inner, "type") == "error" && IsContextOverflow(jsonx.AsRecord(inner["error"]))
	}
	return false
}
