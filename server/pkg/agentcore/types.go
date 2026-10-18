// Package agentcore follows pi-agent-core 1.1.0: events, steer and followUp, hooks and how tools run are named and ordered as pi's.
package agentcore

import (
	"context"
	"encoding/json"

	"vibevalley/pkg/ai"
)

type ThinkingLevel = string

// "parallel" (default) or "sequential".
type ToolExecutionMode = string

const (
	ToolParallel   ToolExecutionMode = "parallel"
	ToolSequential ToolExecutionMode = "sequential"
)

// "one-at-a-time" (default) or "all".
type QueueMode = string

const (
	OneAtATime QueueMode = "one-at-a-time"
	QueueAll   QueueMode = "all"
)

// ConvertToLlm decides what the model reads of an application's own kinds. Each marshals itself to JSON with its `role`.
type AgentMessage interface {
	Role() string
	Time() int64
}

// Kept as it was, never shown to the model.
type UnknownMessage struct {
	RoleName  string
	Timestamp int64
	Raw       json.RawMessage
}

func (m UnknownMessage) Role() string                 { return m.RoleName }
func (m UnknownMessage) Time() int64                  { return m.Timestamp }
func (m UnknownMessage) MarshalJSON() ([]byte, error) { return m.Raw, nil }

type AgentToolResult struct {
	Content []ai.Content
	Details any
	Usage   *ai.Usage
	IsError bool
	// Do not ask the model again after this batch, if every result in it says so.
	Terminate bool
}

type AgentToolUpdateCallback func(partialResult AgentToolResult)

type JsonSchemaObject = map[string]any

type AgentTool struct {
	Name        string
	Label       string
	Description string
	Parameters  JsonSchemaObject
	// Check the arguments against Parameters before Execute; false takes them as they
	// come (a tool found at run time, MCP's).
	CheckArguments bool
	ExecutionMode  ToolExecutionMode
	// Runs it. An error is a sentence for the model, given back as an error result; a panic is said as 工具出错.
	// ctx is cancelled when the run is stopped.
	Execute func(ctx context.Context, toolCallID string, params json.RawMessage, onUpdate AgentToolUpdateCallback) (AgentToolResult, error)
}

type AgentContext struct {
	SystemPrompt string
	Messages     []AgentMessage
	Tools        []AgentTool
}

type BeforeToolCallResult struct {
	Block     bool
	Reason    string
	Terminate bool
}

// AfterToolCallResult changes a result; nil fields leave it as it is (HasDetails: Details replaces, even nil).
type AfterToolCallResult struct {
	Content    []ai.Content
	Details    any
	HasDetails bool
	IsError    *bool
	Usage      *ai.Usage
	Terminate  *bool
}

type BeforeToolCallContext struct {
	AssistantMessage ai.AssistantMessage
	ToolCall         ai.Content
	Args             json.RawMessage
	Context          AgentContext
}

type AfterToolCallContext struct {
	BeforeToolCallContext
	Result  AgentToolResult
	IsError bool
}

type AgentTurnContext struct {
	Message     ai.AssistantMessage
	ToolResults []ai.ToolResultMessage
	Context     AgentContext
	NewMessages []AgentMessage
}

type AgentTurnDecision struct {
	Action string
}

var (
	TurnContinue = &AgentTurnDecision{Action: "continue"}
	TurnEnd      = &AgentTurnDecision{Action: "end"}
)

// nil leaves it to the loop.
type FinishTurn func(ctx context.Context, turn AgentTurnContext) *AgentTurnDecision

type PrepareRequestContext struct {
	Context       AgentContext
	Model         ai.Model
	ThinkingLevel ThinkingLevel
}

// nil and "" leave a part as it is.
type AgentRequestUpdate struct {
	Context       *AgentContext
	Model         *ai.Model
	ThinkingLevel ThinkingLevel
}

type PrepareRequest func(ctx context.Context, request PrepareRequestContext) *AgentRequestUpdate

type StreamFn func(ctx context.Context, model ai.Model, c ai.Context, options ai.StreamOptions) <-chan ai.AssistantMessageEvent

// Every hook may be nil.
type AgentConfig struct {
	// Reasoning comes from ThinkingLevel.
	StreamOptions ai.StreamOptions
	// The key for each request, asked anew every time (a key changed while it runs is used at once); "":
	// StreamOptions' or the environment's. As pi's.
	GetApiKey    func(ctx context.Context, provider string) string
	StreamFn     StreamFn
	ConvertToLlm func(ctx context.Context, messages []AgentMessage) []ai.Message
	// Before ConvertToLlm, on every request: prune, or add what the model should know now. Not kept.
	TransformContext func(ctx context.Context, messages []AgentMessage) []AgentMessage
	FinishTurn       FinishTurn
	PrepareRequest   PrepareRequest
	ToolExecution    ToolExecutionMode
	BeforeToolCall   func(ctx context.Context, c BeforeToolCallContext) *BeforeToolCallResult
	AfterToolCall    func(ctx context.Context, c AfterToolCallContext) *AfterToolCallResult
}

// A standalone loop owns its model and queues; a stateful Agent supplies these itself.
type AgentLoopConfig struct {
	AgentConfig
	Model         ai.Model
	ThinkingLevel ThinkingLevel
	// Asked after each turn: messages to put in before the next request.
	GetSteeringMessages func() []AgentMessage
	// Asked when the agent would stop: messages to go on with.
	GetFollowUpMessages func() []AgentMessage
}

const (
	EventAgentStart          = "agent_start"
	EventAgentEnd            = "agent_end"
	EventTurnStart           = "turn_start"
	EventTurnEnd             = "turn_end"
	EventMessageStart        = "message_start"
	EventMessageUpdate       = "message_update"
	EventMessageEnd          = "message_end"
	EventToolExecutionStart  = "tool_execution_start"
	EventToolExecutionUpdate = "tool_execution_update"
	EventToolExecutionEnd    = "tool_execution_end"
)

type EventKind string

// AgentEvent is open so higher-level agents can add domain events without nullable payload fields.
type AgentEvent interface{ Kind() EventKind }

type AgentStarted struct{}
type AgentEnded struct {
	Messages []AgentMessage
	Aborted  bool
}
type TurnStarted struct{}
type TurnEnded struct {
	Message     ai.AssistantMessage
	ToolResults []ai.ToolResultMessage
}
type MessageStarted struct{ Message AgentMessage }
type MessageUpdated struct {
	Message ai.AssistantMessage
	Delta   ai.AssistantMessageEvent
}
type MessageEnded struct{ Message AgentMessage }
type ToolStarted struct {
	ToolCallID, ToolName string
	Args                 json.RawMessage
}
type ToolUpdated struct {
	ToolCallID, ToolName string
	Args                 json.RawMessage
	PartialResult        AgentToolResult
}
type ToolEnded struct {
	ToolCallID, ToolName string
	Result               AgentToolResult
	IsError              bool
	DurationMs           *int64
}

func (AgentStarted) Kind() EventKind   { return EventAgentStart }
func (AgentEnded) Kind() EventKind     { return EventAgentEnd }
func (TurnStarted) Kind() EventKind    { return EventTurnStart }
func (TurnEnded) Kind() EventKind      { return EventTurnEnd }
func (MessageStarted) Kind() EventKind { return EventMessageStart }
func (MessageUpdated) Kind() EventKind { return EventMessageUpdate }
func (MessageEnded) Kind() EventKind   { return EventMessageEnd }
func (ToolStarted) Kind() EventKind    { return EventToolExecutionStart }
func (ToolUpdated) Kind() EventKind    { return EventToolExecutionUpdate }
func (ToolEnded) Kind() EventKind      { return EventToolExecutionEnd }

// State() gives a copy.
type AgentState struct {
	SystemPrompt  string
	Model         ai.Model
	ThinkingLevel ThinkingLevel
	Tools         []AgentTool
	Messages      []AgentMessage
	// True from agent_start until agent_end.
	IsStreaming      bool
	StreamingMessage AgentMessage
	PendingToolCalls map[string]bool
	ErrorMessage     string
}

func (s AgentState) clone() AgentState {
	out := s
	out.Tools = append([]AgentTool(nil), s.Tools...)
	out.Messages = append([]AgentMessage(nil), s.Messages...)
	out.PendingToolCalls = make(map[string]bool, len(s.PendingToolCalls))
	for k := range s.PendingToolCalls {
		out.PendingToolCalls[k] = true
	}
	return out
}

type AgentToolCallOutcome struct {
	ToolCall   ai.Content
	Result     AgentToolResult
	IsError    bool
	DurationMs *int64
}
