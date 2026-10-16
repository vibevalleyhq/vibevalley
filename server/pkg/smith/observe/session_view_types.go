package observe

import (
	"encoding/json"

	"vibevalley/pkg/smith/oar"
)

// The chat-UI projection's types (observe/session-view.ts). Each TS union is
// one flat struct with a Kind (or Cause) discriminator and a MarshalJSON that
// writes exactly the TS member's fields.

// ViewNotice is a notice part or message. Cause says which fields are set:
//   - "compaction_started": Trigger
//   - "compaction_ended": CompactionOutcome ("completed" | "aborted" | "failed"), Trigger, Reason
//   - "retry": Attempt, MaxAttempts, DelayMs, Reason
//   - "control_rejected": Action, Reason
//   - "child_turn_ended": Outcome
//   - "exited": Code (nil: no exit code)
type ViewNotice struct {
	Cause             string
	Trigger           string
	CompactionOutcome string
	Reason            string
	Attempt           int
	MaxAttempts       *int
	DelayMs           *int64
	Action            oar.ControlAction
	Outcome           oar.TurnOutcome
	Code              *int
}

func (n ViewNotice) MarshalJSON() ([]byte, error) {
	out := map[string]any{"cause": n.Cause}
	switch n.Cause {
	case "compaction_started":
		if n.Trigger != "" {
			out["trigger"] = n.Trigger
		}
	case "compaction_ended":
		out["outcome"] = n.CompactionOutcome
		if n.Trigger != "" {
			out["trigger"] = n.Trigger
		}
		if n.Reason != "" {
			out["reason"] = n.Reason
		}
	case "retry":
		out["attempt"] = n.Attempt
		if n.MaxAttempts != nil {
			out["maxAttempts"] = *n.MaxAttempts
		}
		if n.DelayMs != nil {
			out["delayMs"] = *n.DelayMs
		}
		if n.Reason != "" {
			out["reason"] = n.Reason
		}
	case "control_rejected":
		out["action"] = n.Action
		out["reason"] = n.Reason
	case "child_turn_ended":
		out["outcome"] = n.Outcome
	case "exited":
		out["code"] = n.Code
	}
	return marshalNoEscape(out)
}

// ViewPart is one part of a section. Kind says which fields are set:
//   - "text": Text, MessageID
//   - "reasoning": Content, MessageID
//   - "tool": CallID, Tool, Input, InputPartial, Output, Content (ToolContent), Result, StartedAt, EndedAt
//   - "notice": Notice
//   - "app_request": RequestID, Type, Answered, Cancelled, Body (HasBody)
type ViewPart struct {
	Kind string

	Text      string
	MessageID string
	Content   oar.ReasoningContent

	CallID string
	Tool   string
	// The latest input: tool_call_input_delta appends raw text, tool_call_input replaces it. nil: none.
	Input *string
	// True after an argument delta, until a complete tool_call_input replaces it.
	InputPartial bool
	// Current preview: progress output replaces it, outputDelta appends. Removed when the native result arrives.
	Output *string
	// The result once the call ended (tool_call_ended.content); nil when none.
	ToolContent []oar.ToolOutputPart
	// "running" | "ok" | "failed" | "ended" (the call or its root turn ended without a known result).
	Result string
	// receivedAt of the tool_call_started record OAR observed; nil when the start was never seen.
	StartedAt *int64
	// receivedAt of the tool_call_ended record; nil while it runs or when the end was never seen.
	EndedAt *int64

	Notice *ViewNotice

	RequestID string
	Type      string
	Answered  bool
	// The runtime withdrew the request (app_request_cancelled); Answered stays false.
	Cancelled bool
	// The toApp body verbatim, once the record fold saw it.
	HasBody bool
	Body    json.RawMessage
}

func (p ViewPart) MarshalJSON() ([]byte, error) {
	out := map[string]any{"kind": p.Kind}
	switch p.Kind {
	case "text":
		out["text"] = p.Text
		if p.MessageID != "" {
			out["messageId"] = p.MessageID
		}
	case "reasoning":
		out["content"] = p.Content
		if p.MessageID != "" {
			out["messageId"] = p.MessageID
		}
	case "tool":
		out["callId"] = p.CallID
		out["tool"] = p.Tool
		if p.Input != nil {
			out["input"] = *p.Input
		}
		if p.InputPartial {
			out["inputPartial"] = true
		}
		if p.Output != nil {
			out["output"] = *p.Output
		}
		if p.ToolContent != nil {
			out["content"] = p.ToolContent
		}
		out["result"] = p.Result
		if p.StartedAt != nil {
			out["startedAt"] = *p.StartedAt
		}
		if p.EndedAt != nil {
			out["endedAt"] = *p.EndedAt
		}
	case "notice":
		out["notice"] = p.Notice
	case "app_request":
		out["requestId"] = p.RequestID
		out["type"] = p.Type
		out["answered"] = p.Answered
		if p.Cancelled {
			out["cancelled"] = true
		}
		if p.HasBody {
			out["body"] = rawOrNull(p.Body)
		}
	}
	return marshalNoEscape(out)
}

func rawOrNull(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage("null")
	}
	return raw
}

// ViewSection is one lane's parts in first-appearance order.
type ViewSection struct {
	SessionID string     `json:"sessionId"`
	AgentPath []string   `json:"agentPath"`
	Parts     []ViewPart `json:"parts"`
}

func (s ViewSection) MarshalJSON() ([]byte, error) {
	parts := s.Parts
	if parts == nil {
		parts = []ViewPart{}
	}
	return marshalNoEscape(map[string]any{"sessionId": s.SessionID, "agentPath": pathOrEmpty(s.AgentPath), "parts": parts})
}

// ViewMessage is one message. Kind says which fields are set:
//   - "input": ID, Input
//   - "turn": ID, OpenedBy (the prompt request that opened it; "" for adopted ones), Sections, Outcome
//   - "notice": ID, Notice
type ViewMessage struct {
	Kind     string
	ID       string
	Input    *ConversationInput
	OpenedBy string
	Sections []ViewSection
	// The native turn end or record-derived exit outcome; nil on intermediate sealed segments.
	Outcome *oar.TurnOutcome
	Notice  *ViewNotice
}

func (m ViewMessage) MarshalJSON() ([]byte, error) {
	out := map[string]any{"kind": m.Kind, "id": m.ID}
	switch m.Kind {
	case "input":
		out["input"] = m.Input
	case "turn":
		if m.OpenedBy != "" {
			out["openedBy"] = m.OpenedBy
		}
		sections := m.Sections
		if sections == nil {
			sections = []ViewSection{}
		}
		out["sections"] = sections
		if m.Outcome != nil {
			out["outcome"] = m.Outcome
		}
	case "notice":
		out["notice"] = m.Notice
	}
	return marshalNoEscape(out)
}

// PendingRequest is a runtime→app request nobody has answered and the runtime has not withdrawn.
type PendingRequest struct {
	RequestID string
	Type      string
	SessionID string
	AgentPath []string
	Seq       int64
	// The toApp request body verbatim; absent (HasBody false) when folded from flat events.
	HasBody bool
	Body    json.RawMessage
}

func (r PendingRequest) MarshalJSON() ([]byte, error) {
	out := map[string]any{"requestId": r.RequestID, "type": r.Type, "sessionId": r.SessionID, "agentPath": pathOrEmpty(r.AgentPath), "seq": r.Seq}
	if r.HasBody {
		out["body"] = rawOrNull(r.Body)
	}
	return marshalNoEscape(out)
}

// ExitInfo is the last observed process exit; Code nil means none (a signal).
type ExitInfo struct {
	Code *int `json:"code"`
}

// SessionView is the chat-UI projection: grouped messages, agent status,
// model/usage/context and runtime requests awaiting answers. Pure over the
// record stream: replayable from a log, no clock, no IO. A SessionView is
// immutable once returned; every reduce returns a new one.
type SessionView struct {
	Messages []ViewMessage
	// Inputs the runtime has not taken yet, in request order.
	PendingInputs []ConversationInput
	// Index of the unsealed turn segment in Messages; -1 when none.
	OpenTurn int
	Status   oar.AgentStatus
	// Latest model, effort and service tier the runtime reported for the root agent; nil before any.
	Model       *string
	Effort      *string
	ServiceTier *string
	Context     *oar.ContextUsage
	Usage       oar.SessionUsage
	// toApp requests someone is waited on for: unanswered, not withdrawn, emptied on exit.
	PendingRequests []PendingRequest
	// The last observed process exit; nil when the stream recorded none.
	Exited *ExitInfo
	// The fold internals, all derivable.
	Conversation ConversationState
	// sessionId of the latest prompt request: whose turn_ended closes turns ("" before any record).
	RootSessionID string
	// Native lineage and every observed session's latest totals.
	SessionGraph   oar.SessionGraph
	UsageBySession *OrderedMap[*SessionTokens]
	UsageByAgent   *OrderedMap[oar.AgentTotal]
	// The runtime's own session total when it reports one beyond its agents'; nil otherwise.
	UsageTotal *oar.TokenTotals
}

func (v SessionView) MarshalJSON() ([]byte, error) {
	out := map[string]any{
		"messages":        nonNilSlice(v.Messages),
		"pendingInputs":   nonNilSlice(v.PendingInputs),
		"openTurn":        v.OpenTurn,
		"status":          v.Status,
		"model":           v.Model,
		"effort":          v.Effort,
		"serviceTier":     v.ServiceTier,
		"context":         v.Context,
		"usage":           v.Usage,
		"pendingRequests": nonNilSlice(v.PendingRequests),
		"exited":          v.Exited,
		"conversation":    v.Conversation,
		"sessionGraph":    graphJSON(v.SessionGraph),
		"usageBySession":  orEmpty(v.UsageBySession),
		"usageByAgent":    orEmpty(v.UsageByAgent),
		"usageTotal":      v.UsageTotal,
	}
	if v.RootSessionID != "" {
		out["rootSessionId"] = v.RootSessionID
	}
	return marshalNoEscape(out)
}

func nonNilSlice[T any](values []T) []T {
	if values == nil {
		return []T{}
	}
	return values
}

func orEmpty[V any](m *OrderedMap[V]) *OrderedMap[V] {
	if m == nil {
		return NewOrderedMap[V]()
	}
	return m
}

func graphJSON(graph oar.SessionGraph) oar.SessionGraph {
	return oar.SessionGraph{Nodes: nonNilSlice(graph.Nodes), Edges: nonNilSlice(graph.Edges)}
}

// MarshalJSON writes SessionTokens as TS does: {agents: [[key, total]...], total}.
func (s *SessionTokens) MarshalJSON() ([]byte, error) {
	if s == nil {
		return []byte("null"), nil
	}
	return marshalNoEscape(map[string]any{"agents": s.agentsMap(), "total": s.total})
}

func (s *SessionTokens) agentsMap() *OrderedMap[oar.AgentTotal] {
	m := NewOrderedMap[oar.AgentTotal]()
	if s == nil {
		return m
	}
	for _, key := range s.order {
		m.set(key, s.agents[key])
	}
	return m
}

// Total is the runtime's own session total, when it reported one.
func (s *SessionTokens) Total() *oar.TokenTotals {
	if s == nil {
		return nil
	}
	return s.total
}

// Agents is each agent's latest running total, in first-report order.
func (s *SessionTokens) Agents() []oar.AgentTotal {
	if s == nil {
		return nil
	}
	return s.byAgent()
}
