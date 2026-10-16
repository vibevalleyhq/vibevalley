package oar

import (
	"encoding/json"
	"fmt"
)

// EventBody is one fact OAR read: a runtime-said kind carried by a Frame
// (RuntimeEventBody in TS) or a control fact read off a request or response
// record (ControlEventBody). Switch on the concrete type:
//
//	switch e := body.(type) {
//	case oar.TextDelta: ...
//	case oar.TurnEnded: ...
//	}
//
// A kind this version does not know decodes as UnknownEvent and round-trips
// unchanged.
type EventBody interface {
	EventKind() string
}

// NullInt is a number that may be an explicit JSON null. A *NullInt field
// has three states: absent (nil), null (Valid false) and a number.
type NullInt struct {
	Valid bool
	Int   int
}

// IntOf is a present number.
func IntOf(v int) *NullInt { return &NullInt{Valid: true, Int: v} }

// NullOf is a present null.
func NullOf() *NullInt { return &NullInt{} }

func (n NullInt) MarshalJSON() ([]byte, error) {
	if !n.Valid {
		return []byte("null"), nil
	}
	return json.Marshal(n.Int)
}

func (n *NullInt) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		*n = NullInt{}
		return nil
	}
	var f float64
	if err := json.Unmarshal(data, &f); err != nil {
		return err
	}
	*n = NullInt{Valid: true, Int: int(f)}
	return nil
}

// Bool is a helper for optional booleans.
func Bool(v bool) *bool { return &v }

// Int64 is a helper for optional counts.
func Int64(v int64) *int64 { return &v }

// Float is a helper for optional fractions.
func Float(v float64) *float64 { return &v }

// ─── Runtime-said kinds ────────────────────────────────────────────────────

// UserMessage is a native user-message observation, not proof of model consumption.
type UserMessage struct {
	Input           string `json:"input"`
	InputID         string `json:"inputId,omitempty"`
	NativeMessageID string `json:"nativeMessageId,omitempty"`
	TurnID          string `json:"turnId,omitempty"`
	// "acknowledged" | "turn_item" | "conversation"
	Evidence string `json:"evidence"`
}

// SessionLinked is native evidence of true session lineage.
type SessionLinked struct {
	Parent string `json:"parent"`
	Child  string `json:"child"`
	Via    string `json:"via"`
}

// TurnActive: the runtime reports an active turn; InputID names the input it started for.
type TurnActive struct {
	InputID string `json:"inputId,omitempty"`
}

// InputQueued: the runtime holds this input and has not started its turn.
type InputQueued struct {
	InputID string `json:"inputId"`
}

// InputDropped: the runtime discarded ("turn_interrupted") or refused
// ("runtime_refused") an accepted input. Failure and Message only on a refusal.
type InputDropped struct {
	InputID string       `json:"inputId"`
	Reason  string       `json:"reason"`
	Failure FailureClass `json:"failure,omitempty"`
	Message string       `json:"message,omitempty"`
}

// TextDelta is assistant text at the granularity the runtime emits.
type TextDelta struct {
	Text      string `json:"text"`
	MessageID string `json:"messageId,omitempty"`
}

// ReasoningContent is "text" (with Text), "redacted" or "empty".
type ReasoningContent struct {
	Kind string `json:"kind"`
	Text string `json:"text,omitempty"`
}

func (c ReasoningContent) MarshalJSON() ([]byte, error) {
	o := newObject()
	if err := o.field("kind", c.Kind); err != nil {
		return nil, err
	}
	if c.Kind == "text" {
		if err := o.field("text", c.Text); err != nil {
			return nil, err
		}
	}
	return o.bytes(), nil
}

// Reasoning is a reasoning output item.
type Reasoning struct {
	Content   ReasoningContent `json:"content"`
	MessageID string           `json:"messageId,omitempty"`
}

type ToolCallStarted struct {
	CallID string `json:"callId"`
	Tool   string `json:"tool"`
	// Best-effort human-readable invocation detail; nil when the runtime gave none.
	Input *string `json:"input,omitempty"`
}

// ToolCallInput carries complete arguments reported after the call started.
type ToolCallInput struct {
	CallID string `json:"callId"`
	Input  string `json:"input"`
}

// ToolCallInputDelta is append-only argument text, verbatim.
type ToolCallInputDelta struct {
	CallID string `json:"callId"`
	Delta  string `json:"delta"`
}

type ToolCallEnded struct {
	CallID  string           `json:"callId"`
	Content []ToolOutputPart `json:"content,omitempty"`
	// "ok" | "failed"; empty when the runtime reported none.
	Result string `json:"result,omitempty"`
	// Absent (nil), null (the command ended without one) or the exit status.
	ExitCode *NullInt `json:"exitCode,omitempty"`
	// A pre-0.14.0 record's `output`, kept so the stored record round-trips;
	// Content holds its upgraded reading.
	legacyOutput *string
}

// ToolCallProgress is partial tool output: Output replaces, OutputDelta appends.
type ToolCallProgress struct {
	CallID      string  `json:"callId"`
	Output      *string `json:"output,omitempty"`
	OutputDelta *string `json:"outputDelta,omitempty"`
}

// TurnEnded is the runtime's OWN completion report for a turn.
type TurnEnded struct {
	Outcome TurnOutcome `json:"outcome"`
}

type CompactionStarted struct {
	Trigger string `json:"trigger,omitempty"`
}

type CompactionEnded struct {
	// "completed" | "aborted" | "failed"
	Outcome string `json:"outcome"`
	Trigger string `json:"trigger,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

type Retry struct {
	Attempt     int    `json:"attempt"`
	MaxAttempts *int   `json:"maxAttempts,omitempty"`
	DelayMs     *int64 `json:"delayMs,omitempty"`
	Reason      string `json:"reason,omitempty"`
}

type Usage struct {
	Usage UsageReport `json:"usage"`
}

type Model struct {
	Model string `json:"model"`
}

type Effort struct {
	Effort string `json:"effort"`
}

type ServiceTier struct {
	ServiceTier string `json:"serviceTier"`
}

type AppRequestCancelled struct {
	RequestID string `json:"requestId"`
}

// TaskType: "shell" | "agent" | "tool" | "workflow" | "other".
type TaskType = string

// TaskStatus: "pending" | "running" | "paused" | "completed" | "failed" | "stopped".
type TaskStatus = string

type TaskStarted struct {
	TaskID         string   `json:"taskId"`
	TaskType       TaskType `json:"taskType"`
	NativeType     string   `json:"nativeType,omitempty"`
	Description    string   `json:"description,omitempty"`
	ToolCallID     string   `json:"toolCallId,omitempty"`
	ChildSessionID string   `json:"childSessionId,omitempty"`
	Background     *bool    `json:"background,omitempty"`
	Ambient        *bool    `json:"ambient,omitempty"`
}

type TaskUpdated struct {
	TaskID      string     `json:"taskId"`
	Status      TaskStatus `json:"status,omitempty"`
	Background  *bool      `json:"background,omitempty"`
	Description *string    `json:"description,omitempty"`
	Error       *string    `json:"error,omitempty"`
}

type TaskEnded struct {
	TaskID     string `json:"taskId"`
	Status     string `json:"status"`
	Summary    string `json:"summary,omitempty"`
	OutputFile string `json:"outputFile,omitempty"`
}

// ─── Control kinds (read off request and response records) ─────────────────

type TurnStarted struct {
	RequestID string `json:"requestId"`
	Input     string `json:"input"`
}

type InputWithdrawn struct {
	RequestID string `json:"requestId"`
	InputID   string `json:"inputId"`
}

type ControlRejected struct {
	RequestID string        `json:"requestId"`
	Action    ControlAction `json:"action"`
	Code      RejectionCode `json:"code"`
	Reason    string        `json:"reason"`
}

type AppRequest struct {
	RequestID string `json:"requestId"`
	Type      string `json:"type"`
}

type AppAnswered struct {
	RequestID string `json:"requestId"`
}

// Exited: the runtime process exited; Code nil means no exit code (a signal).
type Exited struct {
	Code *int `json:"code"`
}

// UnknownEvent keeps a kind this version does not know, verbatim.
type UnknownEvent struct {
	Kind string
	Raw  json.RawMessage
}

func (e UnknownEvent) MarshalJSON() ([]byte, error) { return e.Raw, nil }

func (UserMessage) EventKind() string         { return "user_message" }
func (SessionLinked) EventKind() string       { return "session_linked" }
func (TurnActive) EventKind() string          { return "turn_active" }
func (InputQueued) EventKind() string         { return "input_queued" }
func (InputDropped) EventKind() string        { return "input_dropped" }
func (TextDelta) EventKind() string           { return "text_delta" }
func (Reasoning) EventKind() string           { return "reasoning" }
func (ToolCallStarted) EventKind() string     { return "tool_call_started" }
func (ToolCallInput) EventKind() string       { return "tool_call_input" }
func (ToolCallInputDelta) EventKind() string  { return "tool_call_input_delta" }
func (ToolCallEnded) EventKind() string       { return "tool_call_ended" }
func (ToolCallProgress) EventKind() string    { return "tool_call_progress" }
func (TurnEnded) EventKind() string           { return "turn_ended" }
func (CompactionStarted) EventKind() string   { return "compaction_started" }
func (CompactionEnded) EventKind() string     { return "compaction_ended" }
func (Retry) EventKind() string               { return "retry" }
func (Usage) EventKind() string               { return "usage" }
func (Model) EventKind() string               { return "model" }
func (Effort) EventKind() string              { return "effort" }
func (ServiceTier) EventKind() string         { return "service_tier" }
func (AppRequestCancelled) EventKind() string { return "app_request_cancelled" }
func (TaskStarted) EventKind() string         { return "task_started" }
func (TaskUpdated) EventKind() string         { return "task_updated" }
func (TaskEnded) EventKind() string           { return "task_ended" }
func (TurnStarted) EventKind() string         { return "turn_started" }
func (InputWithdrawn) EventKind() string      { return "input_withdrawn" }
func (ControlRejected) EventKind() string     { return "control_rejected" }
func (AppRequest) EventKind() string          { return "app_request" }
func (AppAnswered) EventKind() string         { return "app_answered" }
func (Exited) EventKind() string              { return "exited" }
func (e UnknownEvent) EventKind() string      { return e.Kind }

func (e UserMessage) MarshalJSON() ([]byte, error) {
	type t UserMessage
	return withKind(e.EventKind(), t(e))
}
func (e SessionLinked) MarshalJSON() ([]byte, error) {
	type t SessionLinked
	return withKind(e.EventKind(), t(e))
}
func (e TurnActive) MarshalJSON() ([]byte, error) {
	type t TurnActive
	return withKind(e.EventKind(), t(e))
}
func (e InputQueued) MarshalJSON() ([]byte, error) {
	type t InputQueued
	return withKind(e.EventKind(), t(e))
}
func (e InputDropped) MarshalJSON() ([]byte, error) {
	type t InputDropped
	return withKind(e.EventKind(), t(e))
}
func (e TextDelta) MarshalJSON() ([]byte, error) {
	type t TextDelta
	return withKind(e.EventKind(), t(e))
}
func (e Reasoning) MarshalJSON() ([]byte, error) {
	type t Reasoning
	return withKind(e.EventKind(), t(e))
}
func (e ToolCallStarted) MarshalJSON() ([]byte, error) {
	type t ToolCallStarted
	return withKind(e.EventKind(), t(e))
}
func (e ToolCallInput) MarshalJSON() ([]byte, error) {
	type t ToolCallInput
	return withKind(e.EventKind(), t(e))
}
func (e ToolCallInputDelta) MarshalJSON() ([]byte, error) {
	type t ToolCallInputDelta
	return withKind(e.EventKind(), t(e))
}

// Upgraded is the event as the folds read it: a pre-0.14.0 end keeps only
// its upgraded Content (observe/legacy.ts upgradeLegacyBody). Records keep
// their stored shape; events read off them are upgraded.
func (e ToolCallEnded) Upgraded() ToolCallEnded {
	e.legacyOutput = nil
	return e
}

func (e ToolCallEnded) MarshalJSON() ([]byte, error) {
	type t ToolCallEnded
	if e.legacyOutput != nil {
		return withKind(e.EventKind(), struct {
			CallID   string   `json:"callId"`
			Output   string   `json:"output"`
			Result   string   `json:"result,omitempty"`
			ExitCode *NullInt `json:"exitCode,omitempty"`
		}{e.CallID, *e.legacyOutput, e.Result, e.ExitCode})
	}
	return withKind(e.EventKind(), t(e))
}
func (e ToolCallProgress) MarshalJSON() ([]byte, error) {
	type t ToolCallProgress
	return withKind(e.EventKind(), t(e))
}
func (e TurnEnded) MarshalJSON() ([]byte, error) {
	type t TurnEnded
	return withKind(e.EventKind(), t(e))
}
func (e CompactionStarted) MarshalJSON() ([]byte, error) {
	type t CompactionStarted
	return withKind(e.EventKind(), t(e))
}
func (e CompactionEnded) MarshalJSON() ([]byte, error) {
	type t CompactionEnded
	return withKind(e.EventKind(), t(e))
}
func (e Retry) MarshalJSON() ([]byte, error) {
	type t Retry
	return withKind(e.EventKind(), t(e))
}
func (e Usage) MarshalJSON() ([]byte, error) {
	type t Usage
	return withKind(e.EventKind(), t(e))
}
func (e Model) MarshalJSON() ([]byte, error) {
	type t Model
	return withKind(e.EventKind(), t(e))
}
func (e Effort) MarshalJSON() ([]byte, error) {
	type t Effort
	return withKind(e.EventKind(), t(e))
}
func (e ServiceTier) MarshalJSON() ([]byte, error) {
	type t ServiceTier
	return withKind(e.EventKind(), t(e))
}
func (e AppRequestCancelled) MarshalJSON() ([]byte, error) {
	type t AppRequestCancelled
	return withKind(e.EventKind(), t(e))
}
func (e TaskStarted) MarshalJSON() ([]byte, error) {
	type t TaskStarted
	return withKind(e.EventKind(), t(e))
}
func (e TaskUpdated) MarshalJSON() ([]byte, error) {
	type t TaskUpdated
	return withKind(e.EventKind(), t(e))
}
func (e TaskEnded) MarshalJSON() ([]byte, error) {
	type t TaskEnded
	return withKind(e.EventKind(), t(e))
}
func (e TurnStarted) MarshalJSON() ([]byte, error) {
	type t TurnStarted
	return withKind(e.EventKind(), t(e))
}
func (e InputWithdrawn) MarshalJSON() ([]byte, error) {
	type t InputWithdrawn
	return withKind(e.EventKind(), t(e))
}
func (e ControlRejected) MarshalJSON() ([]byte, error) {
	type t ControlRejected
	return withKind(e.EventKind(), t(e))
}
func (e AppRequest) MarshalJSON() ([]byte, error) {
	type t AppRequest
	return withKind(e.EventKind(), t(e))
}
func (e AppAnswered) MarshalJSON() ([]byte, error) {
	type t AppAnswered
	return withKind(e.EventKind(), t(e))
}
func (e Exited) MarshalJSON() ([]byte, error) {
	type t Exited
	return withKind(e.EventKind(), t(e))
}

// DecodeEventBody reads one event body by its "kind". Unknown kinds are kept
// as UnknownEvent. A pre-0.14.0 tool_call_ended with `output` is upgraded the
// way the TS folds read it (observe/legacy.ts).
func DecodeEventBody(raw []byte) (EventBody, error) {
	kind, err := kindOf(raw)
	if err != nil {
		return nil, err
	}
	decode := func(target any) error { return json.Unmarshal(raw, target) }
	switch kind {
	case "user_message":
		var e UserMessage
		return e, decode(&e)
	case "session_linked":
		var e SessionLinked
		return e, decode(&e)
	case "turn_active":
		var e TurnActive
		return e, decode(&e)
	case "input_queued":
		var e InputQueued
		return e, decode(&e)
	case "input_dropped":
		var e InputDropped
		return e, decode(&e)
	case "text_delta":
		var e TextDelta
		return e, decode(&e)
	case "reasoning":
		var e Reasoning
		return e, decode(&e)
	case "tool_call_started":
		var e ToolCallStarted
		return e, decode(&e)
	case "tool_call_input":
		var e ToolCallInput
		return e, decode(&e)
	case "tool_call_input_delta":
		var e ToolCallInputDelta
		return e, decode(&e)
	case "tool_call_ended":
		var e struct {
			ToolCallEnded
			Output   *string         `json:"output"`
			ExitCode json.RawMessage `json:"exitCode"`
		}
		if err := decode(&e); err != nil {
			return nil, err
		}
		// encoding/json sets a pointer field to nil for an explicit null
		// without calling UnmarshalJSON, so the three states are read here.
		if string(e.ExitCode) == "null" {
			e.ToolCallEnded.ExitCode = NullOf()
		} else if len(e.ExitCode) > 0 {
			var code NullInt
			if err := json.Unmarshal(e.ExitCode, &code); err != nil {
				return nil, err
			}
			e.ToolCallEnded.ExitCode = &code
		}
		if e.Content == nil && e.Output != nil {
			e.ToolCallEnded.Content = ContentOfLegacyOutput(*e.Output)
			e.ToolCallEnded.legacyOutput = e.Output
		}
		return e.ToolCallEnded, nil
	case "tool_call_progress":
		var e ToolCallProgress
		return e, decode(&e)
	case "turn_ended":
		var e TurnEnded
		return e, decode(&e)
	case "compaction_started":
		var e CompactionStarted
		return e, decode(&e)
	case "compaction_ended":
		var e CompactionEnded
		return e, decode(&e)
	case "retry":
		var e Retry
		return e, decode(&e)
	case "usage":
		var e Usage
		return e, decode(&e)
	case "model":
		var e Model
		return e, decode(&e)
	case "effort":
		var e Effort
		return e, decode(&e)
	case "service_tier":
		var e ServiceTier
		return e, decode(&e)
	case "app_request_cancelled":
		var e AppRequestCancelled
		return e, decode(&e)
	case "task_started":
		var e TaskStarted
		return e, decode(&e)
	case "task_updated":
		var e TaskUpdated
		return e, decode(&e)
	case "task_ended":
		var e TaskEnded
		return e, decode(&e)
	case "turn_started":
		var e TurnStarted
		return e, decode(&e)
	case "input_withdrawn":
		var e InputWithdrawn
		return e, decode(&e)
	case "control_rejected":
		var e ControlRejected
		return e, decode(&e)
	case "app_request":
		var e AppRequest
		return e, decode(&e)
	case "app_answered":
		var e AppAnswered
		return e, decode(&e)
	case "exited":
		var e Exited
		return e, decode(&e)
	case "":
		return nil, fmt.Errorf("event body without kind: %s", raw)
	default:
		return UnknownEvent{Kind: kind, Raw: append(json.RawMessage(nil), raw...)}, nil
	}
}

// ContentOfLegacyOutput reads a pre-0.14.0 tool_call_ended `output` string as
// content parts (observe/legacy.ts contentOfLegacyOutput).
func ContentOfLegacyOutput(output string) []ToolOutputPart {
	var parsed any
	if err := json.Unmarshal([]byte(output), &parsed); err != nil {
		return []ToolOutputPart{{Type: "text", Text: output}}
	}
	if blocks, ok := parsed.([]any); ok && len(blocks) > 0 {
		all := true
		for _, block := range blocks {
			m, isMap := block.(map[string]any)
			if !isMap {
				all = false
				break
			}
			if _, isString := m["type"].(string); !isString {
				all = false
				break
			}
		}
		if all {
			if parts := ToolContent(parsed); parts != nil {
				return parts
			}
			return []ToolOutputPart{{Type: "text", Text: output}}
		}
	}
	if text, ok := parsed.(string); ok {
		return []ToolOutputPart{{Type: "text", Text: text}}
	}
	return []ToolOutputPart{{Type: "text", Text: output}}
}
