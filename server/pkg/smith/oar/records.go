package oar

import (
	"encoding/json"
	"fmt"
)

// The record stream (contracts/records.ts). Three layers:
//   - Event: the consumer face, one flat attributed fact (Session.Events).
//   - RawEvent: one record of the stream, a frame, a request or a response
//     (Session.RawEvents / Records).
//   - Frame: a RawEvent carrying one runtime frame verbatim plus the events
//     OAR read out of it.
// Semantics live in docs/spec.

// Envelope is the self-certifying envelope on every record.
type Envelope struct {
	// Runtime-native session the record belongs to.
	SessionID string
	// Sub-agent lineage; empty is the root agent.
	AgentPath []string
	// Runtime-native turn/span id; empty when the runtime reported none.
	SpanID string
	// Monotonic per stream; the cursor anchor and the total order.
	Seq int64
	// Unix epoch milliseconds stamped at adapter ingress.
	ReceivedAt int64
}

// IsRoot reports whether the record belongs to the root agent.
func (e Envelope) IsRoot() bool { return len(e.AgentPath) == 0 }

func (e Envelope) fields(o *object) error {
	if err := o.field("sessionId", e.SessionID); err != nil {
		return err
	}
	path := e.AgentPath
	if path == nil {
		path = []string{}
	}
	if err := o.field("agentPath", path); err != nil {
		return err
	}
	if e.SpanID != "" {
		if err := o.field("spanId", e.SpanID); err != nil {
			return err
		}
	}
	if err := o.field("seq", e.Seq); err != nil {
		return err
	}
	return o.field("receivedAt", e.ReceivedAt)
}

type wireEnvelope struct {
	SessionID  string   `json:"sessionId"`
	AgentPath  []string `json:"agentPath"`
	SpanID     string   `json:"spanId"`
	Seq        float64  `json:"seq"`
	ReceivedAt float64  `json:"receivedAt"`
}

func (w wireEnvelope) envelope() Envelope {
	path := w.AgentPath
	if path == nil {
		path = []string{}
	}
	return Envelope{SessionID: w.SessionID, AgentPath: path, SpanID: w.SpanID, Seq: int64(w.Seq), ReceivedAt: int64(w.ReceivedAt)}
}

// RecordKind is "frame", "request" or "response".
type RecordKind string

const (
	KindFrame    RecordKind = "frame"
	KindRequest  RecordKind = "request"
	KindResponse RecordKind = "response"
)

// RequestDirection is "toRuntime" (a control this Session issued) or
// "toApp" (the runtime asking the application something).
type RequestDirection string

const (
	ToRuntime RequestDirection = "toRuntime"
	ToApp     RequestDirection = "toApp"
)

// RawEvent is one record of the stream. Kind says which of the body groups is set:
//   - frame: Frame
//   - request: ID, Direction, Request
//   - response: RequestID, Response
type RawEvent struct {
	Envelope
	Kind RecordKind

	Frame FrameBody

	ID        string
	Direction RequestDirection
	Request   RequestBody

	RequestID string
	Response  ResponseBody
}

func (r RawEvent) MarshalJSON() ([]byte, error) {
	o := newObject()
	if err := r.Envelope.fields(o); err != nil {
		return nil, err
	}
	if err := o.field("kind", r.Kind); err != nil {
		return nil, err
	}
	switch r.Kind {
	case KindFrame:
		if err := o.field("body", r.Frame); err != nil {
			return nil, err
		}
	case KindRequest:
		if err := o.field("id", r.ID); err != nil {
			return nil, err
		}
		if err := o.field("direction", r.Direction); err != nil {
			return nil, err
		}
		if err := o.field("body", r.Request); err != nil {
			return nil, err
		}
	case KindResponse:
		if err := o.field("requestId", r.RequestID); err != nil {
			return nil, err
		}
		if err := o.field("body", r.Response); err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("record of unknown kind %q", r.Kind)
	}
	return o.bytes(), nil
}

func (r *RawEvent) UnmarshalJSON(data []byte) error {
	var wire struct {
		wireEnvelope
		Kind      RecordKind       `json:"kind"`
		ID        string           `json:"id"`
		Direction RequestDirection `json:"direction"`
		RequestID string           `json:"requestId"`
		Body      json.RawMessage  `json:"body"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	*r = RawEvent{Envelope: wire.wireEnvelope.envelope(), Kind: wire.Kind}
	switch wire.Kind {
	case KindFrame:
		return json.Unmarshal(wire.Body, &r.Frame)
	case KindRequest:
		r.ID, r.Direction = wire.ID, wire.Direction
		return json.Unmarshal(wire.Body, &r.Request)
	case KindResponse:
		r.RequestID = wire.RequestID
		return json.Unmarshal(wire.Body, &r.Response)
	default:
		return fmt.Errorf("record of unknown kind %q", wire.Kind)
	}
}

// FrameBody carries the runtime's frame plus OAR's typed reading. Native is
// the source of truth, verbatim except documented credential redaction.
type FrameBody struct {
	// Runtime-native discriminator: claude `type[/subtype]`, codex method, pi event type, ACP sessionUpdate.
	Type string
	// The frame as sent (JSON).
	Native json.RawMessage
	// What OAR read out of the frame, in frame order.
	Events []EventBody
}

func (f FrameBody) MarshalJSON() ([]byte, error) {
	o := newObject()
	if err := o.field("type", f.Type); err != nil {
		return nil, err
	}
	native := f.Native
	if len(native) == 0 {
		native = json.RawMessage("null")
	}
	o.raw("native", native)
	events := f.Events
	if events == nil {
		events = []EventBody{}
	}
	if err := o.field("events", events); err != nil {
		return nil, err
	}
	return o.bytes(), nil
}

func (f *FrameBody) UnmarshalJSON(data []byte) error {
	var wire struct {
		Type   string            `json:"type"`
		Native json.RawMessage   `json:"native"`
		Events []json.RawMessage `json:"events"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	*f = FrameBody{Type: wire.Type, Native: wire.Native, Events: make([]EventBody, 0, len(wire.Events))}
	for _, raw := range wire.Events {
		event, err := DecodeEventBody(raw)
		if err != nil {
			return err
		}
		f.Events = append(f.Events, event)
	}
	return nil
}

// ControlAction is a toRuntime control a Session issues.
type ControlAction string

const (
	ActionPrompt   ControlAction = "prompt"
	ActionSteer    ControlAction = "steer"
	ActionQueue    ControlAction = "queue"
	ActionWithdraw ControlAction = "withdraw"
	ActionAbort    ControlAction = "abort"
	ActionDispose  ControlAction = "dispose"
)

// RequestKind is a ControlAction or "native" (a runtime→app request).
type RequestKind string

const (
	RequestPrompt   RequestKind = "prompt"
	RequestSteer    RequestKind = "steer"
	RequestQueue    RequestKind = "queue"
	RequestWithdraw RequestKind = "withdraw"
	RequestAbort    RequestKind = "abort"
	RequestDispose  RequestKind = "dispose"
	RequestNative   RequestKind = "native"
)

// RequestBody: prompt/steer/queue carry Input (+InputID, Images, Origin);
// withdraw carries InputID; native carries Type and Native.
type RequestBody struct {
	Kind    RequestKind
	InputID string
	Input   string
	Images  []InputImage
	Origin  *InputOrigin
	Type    string
	Native  json.RawMessage
}

// IsInput reports a prompt, steer or queue body.
func (b RequestBody) IsInput() bool {
	return b.Kind == RequestPrompt || b.Kind == RequestSteer || b.Kind == RequestQueue
}

func (b RequestBody) MarshalJSON() ([]byte, error) {
	o := newObject()
	if err := o.field("kind", b.Kind); err != nil {
		return nil, err
	}
	switch b.Kind {
	case RequestPrompt, RequestSteer, RequestQueue:
		if b.InputID != "" {
			if err := o.field("inputId", b.InputID); err != nil {
				return nil, err
			}
		}
		if err := o.field("input", b.Input); err != nil {
			return nil, err
		}
		if b.Images != nil {
			if err := o.field("images", b.Images); err != nil {
				return nil, err
			}
		}
		if b.Origin != nil {
			if err := o.field("origin", b.Origin); err != nil {
				return nil, err
			}
		}
	case RequestWithdraw:
		if err := o.field("inputId", b.InputID); err != nil {
			return nil, err
		}
	case RequestNative:
		if err := o.field("type", b.Type); err != nil {
			return nil, err
		}
		native := b.Native
		if len(native) == 0 {
			native = json.RawMessage("null")
		}
		o.raw("native", native)
	}
	return o.bytes(), nil
}

func (b *RequestBody) UnmarshalJSON(data []byte) error {
	var wire struct {
		Kind    RequestKind     `json:"kind"`
		InputID string          `json:"inputId"`
		Input   string          `json:"input"`
		Images  []InputImage    `json:"images"`
		Origin  *InputOrigin    `json:"origin"`
		Type    string          `json:"type"`
		Native  json.RawMessage `json:"native"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	*b = RequestBody(wire)
	return nil
}

// RejectionCode is why a control action was not taken over.
type RejectionCode string

const (
	CodeBusy           RejectionCode = "busy"
	CodeNoActiveTurn   RejectionCode = "no_active_turn"
	CodeNotQueued      RejectionCode = "not_queued"
	CodeUnsupported    RejectionCode = "unsupported"
	CodeRuntimeExited  RejectionCode = "runtime_exited"
	CodeDisposed       RejectionCode = "disposed"
	CodeRuntimeRefused RejectionCode = "runtime_refused"
	CodeError          RejectionCode = "error"
)

// ResponseKind is "accepted", "rejected", "answered" or "exited".
type ResponseKind string

const (
	ResponseAccepted ResponseKind = "accepted"
	ResponseRejected ResponseKind = "rejected"
	ResponseAnswered ResponseKind = "answered"
	ResponseExited   ResponseKind = "exited"
)

// ResponseBody: rejected carries Code and Reason; exited carries ExitCode
// (nil: no code); accepted/rejected may carry Native; answered carries Native.
type ResponseBody struct {
	Kind     ResponseKind
	Code     RejectionCode
	Reason   string
	ExitCode *int
	Native   json.RawMessage
}

// Accepted is an accepted response body.
func Accepted() ResponseBody { return ResponseBody{Kind: ResponseAccepted} }

// Rejected is a rejected response body.
func Rejected(code RejectionCode, reason string) ResponseBody {
	return ResponseBody{Kind: ResponseRejected, Code: code, Reason: reason}
}

// ExitedBody is an exited response body.
func ExitedBody(code *int) ResponseBody { return ResponseBody{Kind: ResponseExited, ExitCode: code} }

func (b ResponseBody) MarshalJSON() ([]byte, error) {
	o := newObject()
	if err := o.field("kind", b.Kind); err != nil {
		return nil, err
	}
	switch b.Kind {
	case ResponseAccepted:
		if len(b.Native) > 0 {
			o.raw("native", b.Native)
		}
	case ResponseRejected:
		if err := o.field("code", b.Code); err != nil {
			return nil, err
		}
		if err := o.field("reason", b.Reason); err != nil {
			return nil, err
		}
		if len(b.Native) > 0 {
			o.raw("native", b.Native)
		}
	case ResponseAnswered:
		native := b.Native
		if len(native) == 0 {
			native = json.RawMessage("null")
		}
		o.raw("native", native)
	case ResponseExited:
		if err := o.field("code", b.ExitCode); err != nil {
			return nil, err
		}
	}
	return o.bytes(), nil
}

func (b *ResponseBody) UnmarshalJSON(data []byte) error {
	var wire struct {
		Kind   ResponseKind    `json:"kind"`
		Code   json.RawMessage `json:"code"`
		Reason string          `json:"reason"`
		Native json.RawMessage `json:"native"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	*b = ResponseBody{Kind: wire.Kind, Reason: wire.Reason, Native: wire.Native}
	if wire.Kind == ResponseExited {
		if len(wire.Code) > 0 && string(wire.Code) != "null" {
			var code float64
			if err := json.Unmarshal(wire.Code, &code); err != nil {
				return err
			}
			value := int(code)
			b.ExitCode = &value
		}
		return nil
	}
	if len(wire.Code) > 0 {
		return json.Unmarshal(wire.Code, &b.Code)
	}
	return nil
}

// ─── Outcomes, usage, tool output ──────────────────────────────────────────

// FailureClass is a coarse failure classification (contracts/failure.ts).
type FailureClass string

const (
	FailureAuth             FailureClass = "auth"
	FailureQuota            FailureClass = "quota"
	FailureRateLimited      FailureClass = "rate_limited"
	FailureBilling          FailureClass = "billing"
	FailureModelUnavailable FailureClass = "model_unavailable"
	FailureInputTooLarge    FailureClass = "input_too_large"
	FailureInvalidRequest   FailureClass = "invalid_request"
	FailureOverloaded       FailureClass = "overloaded"
	FailureProvider         FailureClass = "provider"
	FailureRuntimeExited    FailureClass = "runtime_exited"
	FailureLimitReached     FailureClass = "limit_reached"
	FailureOutputSchema     FailureClass = "output_schema"
	FailureUnknown          FailureClass = "unknown"
)

// CredentialProblem is "missing" or "rejected".
type CredentialProblem string

// TurnOutcome is how a turn ended: "completed" (StructuredOutput when the
// runtime reported one; nil is absent, `null` is a reported null), "aborted",
// or "failed" (Failure, Reason, and Status / Credential / ResetsAt where the
// failure carries them).
type TurnOutcome struct {
	Kind             string
	StructuredOutput json.RawMessage
	Failure          FailureClass
	Reason           string
	Status           *int
	Credential       CredentialProblem
	ResetsAt         string
}

// Completed, Aborted and Failed build outcomes.
func Completed() TurnOutcome      { return TurnOutcome{Kind: "completed"} }
func AbortedOutcome() TurnOutcome { return TurnOutcome{Kind: "aborted"} }
func Failed(failure FailureClass, reason string) TurnOutcome {
	return TurnOutcome{Kind: "failed", Failure: failure, Reason: reason}
}

func (t TurnOutcome) MarshalJSON() ([]byte, error) {
	o := newObject()
	if err := o.field("kind", t.Kind); err != nil {
		return nil, err
	}
	switch t.Kind {
	case "completed":
		if len(t.StructuredOutput) > 0 {
			o.raw("structuredOutput", t.StructuredOutput)
		}
	case "failed":
		if err := o.field("failure", t.Failure); err != nil {
			return nil, err
		}
		if err := o.field("reason", t.Reason); err != nil {
			return nil, err
		}
		if t.Status != nil {
			if err := o.field("status", *t.Status); err != nil {
				return nil, err
			}
		}
		if t.Credential != "" && t.Failure == FailureAuth {
			if err := o.field("credential", t.Credential); err != nil {
				return nil, err
			}
		}
		if t.ResetsAt != "" && t.Failure == FailureQuota {
			if err := o.field("resetsAt", t.ResetsAt); err != nil {
				return nil, err
			}
		}
	}
	return o.bytes(), nil
}

func (t *TurnOutcome) UnmarshalJSON(data []byte) error {
	var wire struct {
		Kind             string            `json:"kind"`
		StructuredOutput json.RawMessage   `json:"structuredOutput"`
		Failure          FailureClass      `json:"failure"`
		Reason           string            `json:"reason"`
		Status           *float64          `json:"status"`
		Credential       CredentialProblem `json:"credential"`
		ResetsAt         string            `json:"resetsAt"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	*t = TurnOutcome{Kind: wire.Kind, StructuredOutput: wire.StructuredOutput, Failure: wire.Failure, Reason: wire.Reason, Credential: wire.Credential, ResetsAt: wire.ResetsAt}
	if wire.Status != nil {
		status := int(*wire.Status)
		t.Status = &status
	}
	return nil
}

// TokenTotals are runtime-reported totals counted from this Session's
// opening. Cache counts are parts of input; reasoning is part of output.
// Optional parts are nil until a report carried them.
type TokenTotals struct {
	Input      int64  `json:"input"`
	Output     int64  `json:"output"`
	Reasoning  *int64 `json:"reasoning,omitempty"`
	CacheRead  *int64 `json:"cacheRead,omitempty"`
	CacheWrite *int64 `json:"cacheWrite,omitempty"`
}

// ContextUsage is current context fullness; nil fields are unknown.
type ContextUsage struct {
	Tokens        *int64   `json:"tokens"`
	ContextWindow *int64   `json:"contextWindow"`
	Percent       *float64 `json:"percent"`
}

// UsageReport is what a usage-bearing frame says.
type UsageReport struct {
	Context *ContextUsage `json:"context,omitempty"`
	Tokens  *TokenTotals  `json:"tokens,omitempty"`
	Total   *TokenTotals  `json:"total,omitempty"`
}

// ToolOutputPart is "text" (Text), "image" (MediaType, Data base64) or
// "other" (Value, the block kept whole).
type ToolOutputPart struct {
	Type      string
	Text      string
	MediaType string
	Data      string
	Value     json.RawMessage
}

func (p ToolOutputPart) MarshalJSON() ([]byte, error) {
	o := newObject()
	if err := o.field("type", p.Type); err != nil {
		return nil, err
	}
	switch p.Type {
	case "text":
		if err := o.field("text", p.Text); err != nil {
			return nil, err
		}
	case "image":
		if err := o.field("mediaType", p.MediaType); err != nil {
			return nil, err
		}
		if err := o.field("data", p.Data); err != nil {
			return nil, err
		}
	default:
		value := p.Value
		if len(value) == 0 {
			value = json.RawMessage("null")
		}
		o.raw("value", value)
	}
	return o.bytes(), nil
}

func (p *ToolOutputPart) UnmarshalJSON(data []byte) error {
	var wire struct {
		Type      string          `json:"type"`
		Text      string          `json:"text"`
		MediaType string          `json:"mediaType"`
		Data      string          `json:"data"`
		Value     json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	*p = ToolOutputPart(wire)
	return nil
}

// ToolOutputPartOf reads one content block as a tool output part
// (shared/tool-output.ts toolOutputPart): text, an Anthropic or MCP-shaped
// image, or the block kept whole as "other".
func ToolOutputPartOf(block any) ToolOutputPart {
	if record, ok := block.(map[string]any); ok {
		if record["type"] == "text" {
			if text, isString := record["text"].(string); isString {
				return ToolOutputPart{Type: "text", Text: text}
			}
		}
		if record["type"] == "image" {
			if source, isMap := record["source"].(map[string]any); isMap && source["type"] == "base64" {
				data, dataOK := source["data"].(string)
				mediaType, typeOK := source["media_type"].(string)
				if dataOK && typeOK {
					return ToolOutputPart{Type: "image", MediaType: mediaType, Data: data}
				}
			}
			data, dataOK := record["data"].(string)
			mimeType, typeOK := record["mimeType"].(string)
			if dataOK && typeOK {
				return ToolOutputPart{Type: "image", MediaType: mimeType, Data: data}
			}
		}
	}
	value, _ := json.Marshal(block)
	return ToolOutputPart{Type: "other", Value: value}
}

// ToolContent reads a tool result value as content parts
// (shared/tool-output.ts toolContent): a string is one text part, an array
// its blocks in order, anything else one "other" part; nil or an empty array
// is no content (nil).
func ToolContent(value any) []ToolOutputPart {
	return ToolContentUnwrap(value, nil)
}

// ToolContentUnwrap is ToolContent with a function reaching the block a
// wrapper carries (ACP's {type: "content", content}).
func ToolContentUnwrap(value any, unwrap func(any) any) []ToolOutputPart {
	switch v := value.(type) {
	case nil:
		return nil
	case string:
		return []ToolOutputPart{{Type: "text", Text: v}}
	case []any:
		if len(v) == 0 {
			return nil
		}
		parts := make([]ToolOutputPart, 0, len(v))
		for _, block := range v {
			if unwrap != nil {
				block = unwrap(block)
			}
			parts = append(parts, ToolOutputPartOf(block))
		}
		return parts
	default:
		encoded, _ := json.Marshal(v)
		return []ToolOutputPart{{Type: "other", Value: encoded}}
	}
}

// ToolResultText joins a tool result's text parts by newlines; "" and false when it has none.
func ToolResultText(content []ToolOutputPart) (string, bool) {
	text := ""
	found := false
	for _, part := range content {
		if part.Type != "text" {
			continue
		}
		if found {
			text += "\n"
		}
		text += part.Text
		found = true
	}
	return text, found
}

// InputImage is an image file handed to the runtime with an input.
type InputImage struct {
	// Absolute path on the machine the runtime runs on.
	Path string `json:"path"`
	// image/png, image/jpeg, image/gif or image/webp; read from the extension when empty.
	MediaType string `json:"mediaType,omitempty"`
}

// InputOrigin says who an input comes from ("user", "notification", "automation").
type InputOrigin struct {
	Kind   string `json:"kind"`
	Source string `json:"source,omitempty"`
}

// ─── The consumer face ─────────────────────────────────────────────────────

// Event is an EventBody plus the envelope of the record it was read from.
type Event struct {
	Envelope
	Body EventBody
}

// Kind is the body's kind.
func (e Event) Kind() string { return e.Body.EventKind() }

func (e Event) MarshalJSON() ([]byte, error) {
	body, err := json.Marshal(e.Body)
	if err != nil {
		return nil, err
	}
	o := newObject()
	if err := e.Envelope.fields(o); err != nil {
		return nil, err
	}
	envelope := o.bytes()
	// Body fields first (kind leads), then the envelope.
	if len(body) <= 2 {
		return envelope, nil
	}
	merged := append([]byte{}, body[:len(body)-1]...)
	merged = append(merged, ',')
	merged = append(merged, envelope[1:]...)
	return merged, nil
}

func (e *Event) UnmarshalJSON(data []byte) error {
	var wire wireEnvelope
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	body, err := DecodeEventBody(data)
	if err != nil {
		return err
	}
	*e = Event{Envelope: wire.envelope(), Body: body}
	return nil
}
