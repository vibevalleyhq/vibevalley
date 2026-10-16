// Package agentcore is the agent loop, after pi-agent-core 1.1.0: a run is turns; a turn puts in what is waiting,
// asks the model once, runs the tools it asked for and gives back their results. Events, the two ways to cut in
// (steer, followUp), hooks and how tools run are named and ordered as pi's. Ported from the TypeScript @heybro/agent-core (removed): Effect's
// interruption is the run's context being cancelled; hooks and tools take a context.Context; streams of events are
// subscriptions with an explicit Close.
package agentcore

import (
	"context"
	"encoding/json"

	"vibevalley/pkg/ai"
)

type ThinkingLevel = string

// ToolExecutionMode is "parallel" (default) or "sequential".
type ToolExecutionMode = string

const (
	ToolParallel   ToolExecutionMode = "parallel"
	ToolSequential ToolExecutionMode = "sequential"
)

// QueueMode is "one-at-a-time" (default) or "all".
type QueueMode = string

const (
	OneAtATime QueueMode = "one-at-a-time"
	QueueAll   QueueMode = "all"
)

// AgentMessage is a message in the agent's transcript: the model's kinds (ai.Message), and whatever the
// application adds (TS's CustomAgentMessages). They are kept in the transcript and shown in events; ConvertToLlm
// decides what the model reads of them. An application's kind marshals itself to JSON with its `role`.
type AgentMessage interface {
	Role() string
	Time() int64
}

// UnknownMessage is a transcript line of a role nobody here knows: kept as it was, never shown to the model.
type UnknownMessage struct {
	RoleName  string
	Timestamp int64
	Raw       json.RawMessage
}

func (m UnknownMessage) Role() string                 { return m.RoleName }
func (m UnknownMessage) Time() int64                  { return m.Timestamp }
func (m UnknownMessage) MarshalJSON() ([]byte, error) { return m.Raw, nil }

// AgentToolResult is what a tool gives back.
type AgentToolResult struct {
	Content []ai.Content
	Details any
	Usage   *ai.Usage
	IsError bool
	// Do not ask the model again after this batch, if every result in it says so.
	Terminate bool
}

// AgentToolUpdateCallback reports a tool's partial result while it runs.
type AgentToolUpdateCallback func(partialResult AgentToolResult)

// JsonSchemaObject is a tool's parameters as JSON Schema.
type JsonSchemaObject = map[string]any

// AgentTool is a tool the agent can run.
type AgentTool struct {
	Name string
	// What a person reads for it.
	Label       string
	Description string
	// JSON Schema of the arguments, as the model sees it.
	Parameters JsonSchemaObject
	// Check the arguments against Parameters before Execute (TS: an Effect Schema tool); false takes them as they
	// come (a tool found at run time, MCP's).
	CheckArguments bool
	ExecutionMode  ToolExecutionMode
	// Runs it. An error is a sentence for the model, given back as an error result; a panic is said as 工具出错.
	// ctx is cancelled when the run is stopped.
	Execute func(ctx context.Context, toolCallID string, params json.RawMessage, onUpdate AgentToolUpdateCallback) (AgentToolResult, error)
}

// AgentContext is what a run starts from.
type AgentContext struct {
	SystemPrompt string
	Messages     []AgentMessage
	Tools        []AgentTool
}

// ── Hooks ───────────────────────────────────────────────────────────────

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

// AgentTurnDecision is "continue" or "end".
type AgentTurnDecision struct {
	Action string
}

var (
	TurnContinue = &AgentTurnDecision{Action: "continue"}
	TurnEnd      = &AgentTurnDecision{Action: "end"}
)

// FinishTurn decides after a turn; nil leaves it to the loop.
type FinishTurn func(ctx context.Context, turn AgentTurnContext) *AgentTurnDecision

type PrepareRequestContext struct {
	Context       AgentContext
	Model         ai.Model
	ThinkingLevel ThinkingLevel
}

// AgentRequestUpdate changes one request; nil and "" leave a part as it is.
type AgentRequestUpdate struct {
	Context       *AgentContext
	Model         *ai.Model
	ThinkingLevel ThinkingLevel
}

type PrepareRequest func(ctx context.Context, request PrepareRequestContext) *AgentRequestUpdate

// StreamFn is how a request is made: ai.Stream unless a host says otherwise.
type StreamFn func(ctx context.Context, model ai.Model, c ai.Context, options ai.StreamOptions) <-chan ai.AssistantMessageEvent

// AgentLoopConfig is a run's model and hooks. Every hook may be nil.
type AgentLoopConfig struct {
	Model         ai.Model
	ThinkingLevel ThinkingLevel
	// The key, retries, max tokens...: passed to every request. Reasoning comes from ThinkingLevel.
	StreamOptions ai.StreamOptions
	// The key for each request, asked anew every time (a key changed while it runs is used at once); "":
	// StreamOptions' or the environment's. As pi's.
	GetApiKey func(ctx context.Context, provider string) string
	StreamFn  StreamFn
	// The transcript as the model reads it: the application's own messages turned into the model's, or left out.
	ConvertToLlm func(ctx context.Context, messages []AgentMessage) []ai.Message
	// Before ConvertToLlm, on every request: prune, or add what the model should know now. Not kept.
	TransformContext func(ctx context.Context, messages []AgentMessage) []AgentMessage
	FinishTurn       FinishTurn
	PrepareRequest   PrepareRequest
	// Asked after each turn: messages to put in before the next request.
	GetSteeringMessages func() []AgentMessage
	// Asked when the agent would stop: messages to go on with.
	GetFollowUpMessages func() []AgentMessage
	ToolExecution       ToolExecutionMode
	BeforeToolCall      func(ctx context.Context, c BeforeToolCallContext) *BeforeToolCallResult
	AfterToolCall       func(ctx context.Context, c AfterToolCallContext) *AfterToolCallResult
}

// ── Events and state ────────────────────────────────────────────────────

// Event types.
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

// AgentEvent is one event of a run, TS's union flat; the fields its Type has are set.
type AgentEvent struct {
	Type string
	// message_start / message_update / message_end; turn_end (the answer).
	Message AgentMessage
	// message_update.
	AssistantMessageEvent *ai.AssistantMessageEvent
	// tool_execution_*.
	ToolCallID string
	ToolName   string
	Args       json.RawMessage
	// tool_execution_update.
	PartialResult *AgentToolResult
	// tool_execution_end.
	Result     *AgentToolResult
	IsError    bool
	DurationMs *int64
	// agent_end: the messages the run added.
	Messages []AgentMessage
	// turn_end.
	ToolResults []ai.ToolResultMessage
}

// AgentState is the agent's state; State() gives a copy.
type AgentState struct {
	SystemPrompt  string
	Model         ai.Model
	ThinkingLevel ThinkingLevel
	Tools         []AgentTool
	Messages      []AgentMessage
	// True from agent_start until agent_end.
	IsStreaming bool
	// The answer being said; nil when none.
	StreamingMessage AgentMessage
	PendingToolCalls map[string]bool
	// Why the last answer failed.
	ErrorMessage string
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
