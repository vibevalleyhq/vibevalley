package acp

import (
	"encoding/json"
	"errors"
	"math"
	"strings"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// ACP `session/update` → events, as a pure projection (projection.ts).
// Every update becomes exactly one frame (the adapter records the
// notification verbatim as native); this file only decides what OAR READ
// out of it. Unknown update kinds yield no events and are still recorded.
//
// Values TS JSON.stringify's into event text (rawInput, rawOutput) are read
// from the raw bytes, keeping the agent's key order.

type toolState struct {
	callID string
	ended  bool
	// The input last reported for the call; nil while none was.
	input *string
}

// ProjectionState is per-session tool lifecycle memory: a terminal status
// ends a call once; an input is reported once per change.
type ProjectionState struct {
	tools map[string]*toolState
}

// NewProjectionState is a fresh state.
func NewProjectionState() *ProjectionState {
	return &ProjectionState{tools: map[string]*toolState{}}
}

func textContent(value any) (string, bool) {
	if content := jsonx.AsRecord(value); content != nil {
		if text, ok := content["text"].(string); ok {
			return text, true
		}
		// An ACP ToolCallContent of type "content" wraps a ContentBlock
		// (grok's completed `run_terminal_command`); its text is the call's output.
		if content["type"] == "content" {
			return textContent(content["content"])
		}
		return "", false
	}
	if list, ok := value.([]any); ok {
		var parts []string
		for _, item := range list {
			if text, ok := textContent(item); ok {
				parts = append(parts, text)
			}
		}
		if len(parts) == 0 {
			return "", false
		}
		return strings.Join(parts, "\n"), true
	}
	return "", false
}

// truncate keeps the first 10 000 UTF-16 units, marking a cut with "…"
// (a pair split by the cut is dropped whole; JS keeps its high half).
func truncate(value string) string {
	units := 0
	for index, r := range value {
		size := 1
		if r >= 0x10000 {
			size = 2
		}
		if units+size > 10_000 {
			return value[:index] + "…"
		}
		units += size
	}
	return value
}

// detail is a value as event text: a string as is, a content block's text,
// else the value's JSON; truncated. raw is the value's own JSON.
func detail(value any, raw json.RawMessage) *string {
	if text, ok := value.(string); ok {
		out := truncate(text)
		return &out
	}
	if value == nil {
		return nil
	}
	if text, ok := textContent(value); ok {
		out := truncate(text)
		return &out
	}
	out := truncate(jsonx.Stringify(raw))
	return &out
}

func toolName(update jsonx.Record) string {
	if name, ok := update["name"].(string); ok {
		return name
	}
	if name, ok := update["toolName"].(string); ok {
		return name
	}
	// ACP's `kind` is a category (execute, other, …), never a tool's name;
	// the OPENING `tool_call` frame's `title` is the closest thing the
	// protocol has (kimi 0.42.0: "Bash"/"Agent"; grok: "run_terminal_command").
	// A later `tool_call_update` retitles the call with progress text, so a
	// call first seen on an update falls back to `kind`.
	if update["sessionUpdate"] == "tool_call" {
		if title, ok := update["title"].(string); ok {
			return title
		}
	}
	if kind, ok := update["kind"].(string); ok {
		return kind
	}
	return "tool"
}

func sameText(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func projectTool(state *ProjectionState, update jsonx.Record, fields map[string]json.RawMessage) []oar.EventBody {
	callID, ok := update["toolCallId"].(string)
	if !ok {
		return nil
	}
	var events []oar.EventBody
	rawInput, hasInput := update["rawInput"]
	tool := state.tools[callID]
	opening := tool == nil
	if tool == nil {
		var input *string
		if hasInput {
			input = detail(rawInput, fields["rawInput"])
		}
		tool = &toolState{callID: callID, input: input}
		state.tools[callID] = tool
		events = append(events, oar.ToolCallStarted{CallID: callID, Tool: toolName(update), Input: input})
	} else if !tool.ended && hasInput {
		// A runtime may send the arguments only on a later update (opencode's
		// opening `tool_call` has `rawInput` `{cwd}`, the next `{command, cwd}`;
		// kimi's has none). Read in the started input's form, so an unchanged
		// repeat says nothing new.
		if input := detail(rawInput, fields["rawInput"]); input != nil && !sameText(input, tool.input) {
			tool.input = input
			events = append(events, oar.ToolCallInput{CallID: callID, Input: *input})
		}
	}
	status := update["status"]
	terminal := status == "completed" || status == "failed" || status == "cancelled"
	rawOutput, hasOutput := update["rawOutput"]
	if !tool.ended && !terminal && !opening && hasOutput {
		// A later non-terminal update with rawOutput is streamed output.
		// `content` is NOT used here: kimi streams the call's ARGUMENTS as
		// content while in_progress, which is input, not output.
		events = append(events, oar.ToolCallProgress{CallID: callID, Output: detail(rawOutput, fields["rawOutput"])})
	}
	if !tool.ended && terminal {
		tool.ended = true
		// `content` is what the runtime wants shown; each ToolCallContent
		// wraps its ContentBlock as `{type: "content", content}`. Without
		// content, `rawOutput` is the result.
		content := oar.ToolContentUnwrap(update["content"], func(item any) any {
			if wrapper := jsonx.AsRecord(item); wrapper != nil && wrapper["type"] == "content" {
				return wrapper["content"]
			}
			return item
		})
		if content == nil {
			content = oar.ToolContent(rawOutput)
		}
		for index, part := range content {
			if part.Type == "text" {
				content[index].Text = truncate(part.Text)
			}
		}
		ended := oar.ToolCallEnded{CallID: callID, Content: content, ExitCode: rawOutputExitCode(rawOutput)}
		if status == "completed" {
			ended.Result = "ok"
		} else if status == "failed" {
			ended.Result = "failed"
		}
		events = append(events, ended)
	}
	return events
}

// rawOutputExitCode is the exit status a vendor puts on a completed
// command's `rawOutput` (grok 1.0.25: `{type: "Bash", exit_code: 0, …}`).
// ACP defines none, so the key is read only when present; null is the
// runtime's own "no code".
func rawOutputExitCode(rawOutput any) *oar.NullInt {
	record := jsonx.AsRecord(rawOutput)
	if record == nil {
		return nil
	}
	value, ok := record["exit_code"]
	if !ok {
		value, ok = record["exitCode"]
	}
	if !ok {
		return nil
	}
	if number, isNumber := jsonx.AsNumber(value); isNumber {
		return oar.IntOf(int(number))
	}
	return oar.NullOf()
}

func optionalInt(value any) *int64 {
	number, ok := jsonx.AsNumber(value)
	if !ok {
		return nil
	}
	out := int64(number)
	return &out
}

// RoundedPercent is Math.round((tokens / window) * 100), nil when either is unknown or the window is 0.
func RoundedPercent(tokens, window *int64) *float64 {
	if tokens == nil || window == nil || *window == 0 {
		return nil
	}
	percent := math.Floor(float64(*tokens)/float64(*window)*100 + 0.5)
	return &percent
}

// ContextUsageOf is context fullness from a `usage_update` (`used` / `size`), nil when it carries none.
func ContextUsageOf(update jsonx.Record) *oar.ContextUsage {
	tokens := optionalInt(update["used"])
	window := optionalInt(update["size"])
	if tokens == nil && window == nil {
		return nil
	}
	return &oar.ContextUsage{Tokens: tokens, ContextWindow: window, Percent: RoundedPercent(tokens, window)}
}

// PromptUsage is a prompt answer's `usage` event from the profile's readings
// of it: the context, and the prompt's own ledger added to the session's
// `billed` total (cache parts included) and stamped cumulative. No event
// (nil) when the answer carried neither.
func PromptUsage(context *oar.ContextUsage, prompted *oar.TokenTotals, billed oar.TokenTotals) (oar.EventBody, oar.TokenTotals) {
	next := billed
	if prompted != nil {
		next = observe.AddTokens(billed, *prompted)
	}
	if context == nil && prompted == nil {
		return nil, next
	}
	report := oar.UsageReport{Context: context}
	if prompted != nil {
		tokens := next
		report.Tokens = &tokens
	}
	return oar.Usage{Usage: report}, next
}

func reasoningView(value any) oar.EventBody {
	text, ok := textContent(value)
	switch {
	case !ok:
		return oar.Reasoning{Content: oar.ReasoningContent{Kind: "redacted"}}
	case text == "":
		return oar.Reasoning{Content: oar.ReasoningContent{Kind: "empty"}}
	default:
		return oar.Reasoning{Content: oar.ReasoningContent{Kind: "text", Text: text}}
	}
}

// ProjectUpdate is the events OAR reads out of one `session/update`'s
// `update` (raw JSON); the update itself is recorded verbatim by the caller.
func ProjectUpdate(state *ProjectionState, raw json.RawMessage) []oar.EventBody {
	update := jsonx.ParseRecord(raw)
	if update == nil {
		return nil
	}
	events := []oar.EventBody{}
	switch update["sessionUpdate"] {
	case "usage_update":
		if context := ContextUsageOf(update); context != nil {
			events = append(events, oar.Usage{Usage: oar.UsageReport{Context: context}})
		}
	case "agent_message_chunk":
		if text, ok := textContent(update["content"]); ok && text != "" {
			events = append(events, oar.TextDelta{Text: text})
		}
	case "agent_thought_chunk":
		events = append(events, reasoningView(update["content"]))
	case "tool_call", "tool_call_update":
		events = append(events, projectTool(state, update, jsonx.RawFields(raw))...)
	}
	// Any frame that names the effective model (kimi's config_option_update,
	// grok's `_meta.model`) is also a model report; one whose `thought_level`
	// option names a current value is an effort one.
	if model, ok := ReportedModel(update); ok {
		events = append(events, oar.Model{Model: model})
	}
	if effort, ok := ReportedEffort(update); ok {
		events = append(events, oar.Effort{Effort: effort})
	}
	return events
}

// DefaultPromptOutcome is the outcome an ACP prompt answer reports:
// `cancelled` is the runtime honoring session/cancel.
func DefaultPromptOutcome(response jsonx.Record) oar.TurnOutcome {
	if response["stopReason"] == "cancelled" {
		return oar.AbortedOutcome()
	}
	return oar.Completed()
}

// namedError is an error with a JS name (TypeError for a malformed answer).
type namedError struct {
	name    string
	message string
}

func (e *namedError) Error() string { return e.message }

// ErrorNative is a JSON-safe rendering of an RPC error for the native of a
// prompt-error frame.
func ErrorNative(err error) json.RawMessage {
	var acpErr *Error
	if errors.As(err, &acpErr) {
		native := map[string]any{"name": "AcpError", "kind": acpErr.Kind, "message": acpErr.Message, "exitCode": acpErr.ExitCode, "method": nil, "timeoutMs": nil}
		if acpErr.Method != "" {
			native["method"] = acpErr.Method
		}
		if acpErr.Timeout > 0 {
			native["timeoutMs"] = acpErr.Timeout.Milliseconds()
		}
		return jsonx.Marshal(native)
	}
	var requestErr *RequestError
	if errors.As(err, &requestErr) {
		native := map[string]any{"code": requestErr.Code, "name": "RequestError", "message": requestErr.Message}
		if requestErr.HasData {
			native["data"] = requestErr.Data
		}
		return jsonx.Marshal(native)
	}
	var named *namedError
	if errors.As(err, &named) {
		return jsonx.Marshal(map[string]any{"name": named.name, "message": named.message})
	}
	return jsonx.Marshal(map[string]any{"name": "Error", "message": err.Error()})
}
