package oar

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"time"
)

const (
	// VoyageFormat identifies the JSONL stream persistence format compatible with @botiverse/oar-cli.
	VoyageFormat = "oar-voyage/3"
	// VoyageVersion is the numeric format version matching VoyageFormat.
	VoyageVersion = 3

	// EnvSubagentDepth tracks recursive subagent nesting depth across spawned processes.
	EnvSubagentDepth = "OAR_SUBAGENT_DEPTH"
	// EnvQoderExposeTokenUsage enables real token accounting in Qoder CLI output.
	EnvQoderExposeTokenUsage = "QODER_EXPOSE_TOKEN_USAGE"

	// DefaultMaxSubagentDepth is the default OAR_SUBAGENT_DEPTH nesting limit.
	DefaultMaxSubagentDepth = 1
	// DefaultMaxSubagentConcurrency is the default maximum number of concurrent subagents.
	DefaultMaxSubagentConcurrency = 4

	defaultBaselineTimeout = 5 * time.Second
	defaultRequestTimeout  = 30 * time.Second
)

// RecordKind distinguishes native wire frames from runtime control traces and lifecycle markers.
type RecordKind string

const (
	RecordFrame   RecordKind = "frame"
	RecordControl RecordKind = "control"
	RecordMarker  RecordKind = "marker"
)

// RecordEnvelope is a self-proving, monotonically sequenced record in a unified OAR stream.
// Root records always encode AgentPath as an empty slice `[]`, never `null`.
type RecordEnvelope struct {
	Seq        int64         `json:"seq"`
	Kind       RecordKind    `json:"kind"`
	SessionID  string        `json:"sessionId"`
	SpanID     string        `json:"spanId,omitempty"`
	AgentPath  []string      `json:"agentPath"`
	ReceivedAt int64         `json:"receivedAt"`
	FrameType  string        `json:"frameType,omitempty"`
	Raw        []byte        `json:"raw,omitempty"`
	Events     []Event       `json:"events,omitempty"`
	Control    *ControlTrace `json:"control,omitempty"`
	Marker     *MarkerRecord `json:"marker,omitempty"`
}

// MarshalJSON encodes RecordEnvelope while guaranteeing root AgentPath serializes as [] rather than null.
func (e RecordEnvelope) MarshalJSON() ([]byte, error) {
	type alias RecordEnvelope
	out := alias(e)
	if out.AgentPath == nil {
		out.AgentPath = []string{}
	}
	return json.Marshal(out)
}

// UnmarshalJSON decodes RecordEnvelope and preserves whether AgentPath was explicitly supplied.
func (e *RecordEnvelope) UnmarshalJSON(data []byte) error {
	type alias RecordEnvelope
	var tmp alias
	if err := json.Unmarshal(data, &tmp); err != nil {
		return err
	}
	*e = RecordEnvelope(tmp)
	return nil
}

// Validate verifies the self-proving invariants of a RecordEnvelope.
func (e RecordEnvelope) Validate() error {
	if e.Seq < 0 {
		return fmt.Errorf("oar: invalid negative seq %d", e.Seq)
	}
	if strings.TrimSpace(e.SessionID) == "" {
		return errors.New("oar: missing sessionId in RecordEnvelope")
	}
	if e.AgentPath == nil {
		return errors.New("oar: agentPath must be non-nil ([] for root)")
	}
	switch e.Kind {
	case RecordFrame, RecordControl, RecordMarker:
	default:
		return fmt.Errorf("oar: invalid record kind %q", e.Kind)
	}
	return nil
}

// IsRoot reports whether the record originated from the root session rather than a subagent.
func (e RecordEnvelope) IsRoot() bool {
	return len(e.AgentPath) == 0
}

// Clone returns an isolated copy so callers and subscribers cannot race on shared slice backing arrays.
func (e RecordEnvelope) Clone() RecordEnvelope {
	out := e
	if e.AgentPath == nil {
		out.AgentPath = []string{}
	} else {
		out.AgentPath = slices.Clone(e.AgentPath)
	}
	if e.Raw != nil {
		out.Raw = slices.Clone(e.Raw)
	}
	if e.Events != nil {
		out.Events = slices.Clone(e.Events)
		for i := range out.Events {
			out.Events[i] = out.Events[i].Clone()
		}
	}
	if e.Control != nil {
		cp := *e.Control
		out.Control = &cp
	}
	if e.Marker != nil {
		cp := *e.Marker
		out.Marker = &cp
	}
	return out
}

// ControlTrace records a control operation dispatched to a session in the event stream.
type ControlTrace struct {
	Action  ControlAction  `json:"action"`
	InputID string         `json:"inputId,omitempty"`
	TaskID  string         `json:"taskId,omitempty"`
	Outcome ControlOutcome `json:"outcome"`
}

// MarkerRecord captures synthetic lifecycle milestones such as session initialization or exit.
type MarkerRecord struct {
	Name   string `json:"name"`
	Detail string `json:"detail,omitempty"`
}

// ControlAction names a runtime control operation sent to a session.
type ControlAction string

const (
	ControlPrompt   ControlAction = "prompt"
	ControlSteer    ControlAction = "steer"
	ControlQueue    ControlAction = "queue"
	ControlWithdraw ControlAction = "withdraw"
	ControlAbort    ControlAction = "abort"
	ControlCompact  ControlAction = "compact"
	ControlStopTask ControlAction = "stop_task"
)

// ControlStatus describes whether a runtime driver accepted or rejected a control action.
type ControlStatus string

const (
	ControlAccepted    ControlStatus = "accepted"
	ControlRejected    ControlStatus = "rejected"
	ControlUnsupported ControlStatus = "unsupported"
	ControlNotRunning  ControlStatus = "not_running"
)

// ControlOutcome is the typed, non-throwing result of any session control call.
type ControlOutcome struct {
	Action  ControlAction `json:"action"`
	Status  ControlStatus `json:"status"`
	Code    string        `json:"code,omitempty"`
	Reason  string        `json:"reason,omitempty"`
	SpanID  string        `json:"spanId,omitempty"`
	InputID string        `json:"inputId,omitempty"`
	Message string        `json:"message,omitempty"`
}

// Accepted reports whether the control operation was accepted by the runtime.
func (o ControlOutcome) Accepted() bool {
	return o.Status == ControlAccepted
}

// EventKind identifies normalized runtime events embedded inside RecordEnvelope.Events.
type EventKind string

const (
	EventTurnStarted       EventKind = "turn_started"
	EventTurnEnded         EventKind = "turn_ended"
	EventTextDelta         EventKind = "text_delta"
	EventReasoning         EventKind = "reasoning"
	EventToolCallStarted   EventKind = "tool_call_started"
	EventToolCallInput     EventKind = "tool_call_input"
	EventToolCallEnded     EventKind = "tool_call_ended"
	EventUsage             EventKind = "usage"
	EventModel             EventKind = "model"
	EventEffort            EventKind = "effort"
	EventRetry             EventKind = "retry"
	EventCompactionStarted EventKind = "compaction_started"
	EventCompactionEnded   EventKind = "compaction_ended"
	EventTaskStarted       EventKind = "task_started"
	EventTaskUpdated       EventKind = "task_updated"
	EventTaskEnded         EventKind = "task_ended"
	EventChildSession      EventKind = "child_session"
	EventExited            EventKind = "exited"
)

// FailureClass categorizes failed turn outcomes across providers.
type FailureClass string

const (
	FailureAuth             FailureClass = "auth"
	FailureBilling          FailureClass = "billing"
	FailureQuota            FailureClass = "quota"
	FailureRateLimit        FailureClass = "rate_limit"
	FailureOverloaded       FailureClass = "overloaded"
	FailureModelUnavailable FailureClass = "model_unavailable"
	FailureContextLength    FailureClass = "context_length"
	FailureNetwork          FailureClass = "network"
	FailureTimeout          FailureClass = "timeout"
	FailureCancelled        FailureClass = "cancelled"
	FailureUnknown          FailureClass = "unknown"
)

// TurnOutcome describes how a turn completed, aborted, or failed.
type TurnOutcome struct {
	Kind    string       `json:"kind"` // "completed" | "aborted" | "failed"
	Failure FailureClass `json:"failure,omitempty"`
	Reason  string       `json:"reason,omitempty"`
	Status  *int         `json:"status,omitempty"`
}

// ToolOutputPart holds one chunk of tool result content.
type ToolOutputPart struct {
	Type string `json:"type"` // "text" | "image"
	Text string `json:"text,omitempty"`
}

// TokenTotals records incremental token accounting; a nil pointer indicates unknown totals.
type TokenTotals struct {
	InputTokens      int64  `json:"inputTokens"`
	OutputTokens     int64  `json:"outputTokens"`
	CacheReadTokens  int64  `json:"cacheReadTokens"`
	CacheWriteTokens int64  `json:"cacheWriteTokens"`
	ReasoningTokens  int64  `json:"reasoningTokens"`
	CostMicros       *int64 `json:"costMicros,omitempty"`
}

// Subtract returns non-negative incremental deltas relative to baseline.
// CostMicros is only reported when both receiver and baseline include a known cost.
func (t TokenTotals) Subtract(baseline TokenTotals) TokenTotals {
	out := TokenTotals{
		InputTokens:      max(0, t.InputTokens-baseline.InputTokens),
		OutputTokens:     max(0, t.OutputTokens-baseline.OutputTokens),
		CacheReadTokens:  max(0, t.CacheReadTokens-baseline.CacheReadTokens),
		CacheWriteTokens: max(0, t.CacheWriteTokens-baseline.CacheWriteTokens),
		ReasoningTokens:  max(0, t.ReasoningTokens-baseline.ReasoningTokens),
	}
	if t.CostMicros != nil && baseline.CostMicros != nil {
		delta := max(0, *t.CostMicros-*baseline.CostMicros)
		out.CostMicros = &delta
	}
	return out
}

// Add accumulates other into t. CostMicros is preserved only if both operands report it or t was zero.
func (t TokenTotals) Add(other TokenTotals) TokenTotals {
	out := TokenTotals{
		InputTokens:      t.InputTokens + other.InputTokens,
		OutputTokens:     t.OutputTokens + other.OutputTokens,
		CacheReadTokens:  t.CacheReadTokens + other.CacheReadTokens,
		CacheWriteTokens: t.CacheWriteTokens + other.CacheWriteTokens,
		ReasoningTokens:  t.ReasoningTokens + other.ReasoningTokens,
	}
	if t.CostMicros != nil && other.CostMicros != nil {
		sum := *t.CostMicros + *other.CostMicros
		out.CostMicros = &sum
	} else if t.CostMicros != nil && other.InputTokens == 0 && other.OutputTokens == 0 && other.CacheReadTokens == 0 && other.CacheWriteTokens == 0 && other.ReasoningTokens == 0 {
		v := *t.CostMicros
		out.CostMicros = &v
	} else if other.CostMicros != nil && t.InputTokens == 0 && t.OutputTokens == 0 && t.CacheReadTokens == 0 && t.CacheWriteTokens == 0 && t.ReasoningTokens == 0 {
		v := *other.CostMicros
		out.CostMicros = &v
	}
	return out
}

// Clone returns an independent copy of TokenTotals.
func (t *TokenTotals) Clone() *TokenTotals {
	if t == nil {
		return nil
	}
	cp := *t
	if t.CostMicros != nil {
		v := *t.CostMicros
		cp.CostMicros = &v
	}
	return &cp
}

// ContextUsage reports active context window utilization without fabricating token deltas.
type ContextUsage struct {
	Tokens        int64   `json:"tokens"`
	ContextWindow int64   `json:"contextWindow"`
	Percent       float64 `json:"percent"`
}

// UsageReport carries incremental token totals (explicitly nil when unknown) and optional context window info.
type UsageReport struct {
	Tokens        *TokenTotals  `json:"tokens"`
	Context       *ContextUsage `json:"context,omitempty"`
	UnknownReason string        `json:"unknownReason,omitempty"`
}

// Event is a provider-independent normalized event derived from one native runtime frame.
type Event struct {
	Kind              EventKind        `json:"kind"`
	Input             string           `json:"input,omitempty"`
	RequestID         string           `json:"requestId,omitempty"`
	Outcome           *TurnOutcome     `json:"outcome,omitempty"`
	Text              string           `json:"text,omitempty"`
	ReasoningKind     string           `json:"reasoningKind,omitempty"`
	CallID            string           `json:"callId,omitempty"`
	Tool              string           `json:"tool,omitempty"`
	Result            string           `json:"result,omitempty"`
	ExitCode          *int             `json:"exitCode,omitempty"`
	Content           []ToolOutputPart `json:"content,omitempty"`
	Usage             *UsageReport     `json:"usage,omitempty"`
	Model             string           `json:"model,omitempty"`
	Effort            string           `json:"effort,omitempty"`
	Attempt           int              `json:"attempt,omitempty"`
	MaxAttempts       int              `json:"maxAttempts,omitempty"`
	DelayMs           int64            `json:"delayMs,omitempty"`
	Reason            string           `json:"reason,omitempty"`
	Trigger           string           `json:"trigger,omitempty"`
	CompactionOutcome string           `json:"compactionOutcome,omitempty"`
	TaskID            string           `json:"taskId,omitempty"`
	TaskKind          string           `json:"taskKind,omitempty"`
	Label             string           `json:"label,omitempty"`
	Status            string           `json:"status,omitempty"`
	Summary           string           `json:"summary,omitempty"`
	Ambient           bool             `json:"ambient,omitempty"`
	ChildSessionID    string           `json:"childSessionId,omitempty"`
	ParentSessionID   string           `json:"parentSessionId,omitempty"`
	Code              *int             `json:"code,omitempty"`
	Signal            string           `json:"signal,omitempty"`
}

// Clone returns a deep copy of Event.
func (e Event) Clone() Event {
	out := e
	if e.Outcome != nil {
		cp := *e.Outcome
		if e.Outcome.Status != nil {
			v := *e.Outcome.Status
			cp.Status = &v
		}
		out.Outcome = &cp
	}
	if e.ExitCode != nil {
		v := *e.ExitCode
		out.ExitCode = &v
	}
	if e.Content != nil {
		out.Content = slices.Clone(e.Content)
	}
	if e.Usage != nil {
		cp := *e.Usage
		cp.Tokens = e.Usage.Tokens.Clone()
		if e.Usage.Context != nil {
			c := *e.Usage.Context
			cp.Context = &c
		}
		out.Usage = &cp
	}
	if e.Code != nil {
		v := *e.Code
		out.Code = &v
	}
	return out
}

// RefusableOption names a session configuration option that a runtime driver may statically refuse.
type RefusableOption string

const (
	OptionSystemPrompt          RefusableOption = "systemPrompt"
	OptionAppendSystemPrompt    RefusableOption = "appendSystemPrompt"
	OptionEffort                RefusableOption = "effort"
	OptionEnv                   RefusableOption = "env"
	OptionMCPServers            RefusableOption = "mcpServers"
	OptionMCPServerCredentials  RefusableOption = "mcpServerCredentials"
	OptionDisallowedTools       RefusableOption = "disallowedTools"
	OptionAllowedTools          RefusableOption = "allowedTools"
	OptionName                  RefusableOption = "name"
	OptionServiceTier           RefusableOption = "serviceTier"
	OptionAdditionalDirectories RefusableOption = "additionalDirectories"
	OptionOutputSchema          RefusableOption = "outputSchema"
	OptionLaunchArgs            RefusableOption = "launchArgs"
)

// RefusedOptions declares every SessionOptions field a driver refuses before spawning any process.
type RefusedOptions map[RefusableOption]string

// UnsupportedOptionError is returned before process spawn when a caller passes an option refused by the driver.
type UnsupportedOptionError struct {
	Runtime string
	Option  RefusableOption
	Reason  string
}

func (e *UnsupportedOptionError) Error() string {
	if e.Reason == "" {
		return fmt.Sprintf("oar: runtime %q refuses option %q", e.Runtime, e.Option)
	}
	return fmt.Sprintf("oar: runtime %q refuses option %q: %s", e.Runtime, e.Option, e.Reason)
}

// MCPServerType identifies the transport kind for a configured MCP server.
type MCPServerType string

const (
	MCPStdio MCPServerType = "stdio"
	MCPHTTP  MCPServerType = "http"
)

// MCPServer describes an MCP tool server mounted into an agent session.
type MCPServer struct {
	Type    MCPServerType     `json:"type"`
	Name    string            `json:"name"`
	Command string            `json:"command,omitempty"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	URL     string            `json:"url,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}

// HasCredentials reports whether the MCP server definition includes secret env vars or HTTP headers.
func (m MCPServer) HasCredentials() bool {
	return len(m.Env) > 0 || len(m.Headers) > 0
}

// SessionOptions configures opening or resuming a runtime session.
type SessionOptions struct {
	CWD                   string            `json:"cwd,omitempty"`
	BinPath               string            `json:"binPath,omitempty"`
	Model                 string            `json:"model,omitempty"`
	Effort                string            `json:"effort,omitempty"`
	SystemPrompt          string            `json:"systemPrompt,omitempty"`
	AppendSystemPrompt    string            `json:"appendSystemPrompt,omitempty"`
	Env                   map[string]string `json:"env,omitempty"`
	UnsetEnv              []string          `json:"unsetEnv,omitempty"`
	MCPServers            []MCPServer       `json:"mcpServers,omitempty"`
	DisallowedTools       []string          `json:"disallowedTools,omitempty"`
	AllowedTools          []string          `json:"allowedTools,omitempty"`
	ResumeSessionID       string            `json:"resumeSessionId,omitempty"`
	Name                  string            `json:"name,omitempty"`
	ServiceTier           string            `json:"serviceTier,omitempty"`
	AdditionalDirectories []string          `json:"additionalDirectories,omitempty"`
	OutputSchema          []byte            `json:"outputSchema,omitempty"`
	LaunchArgs            []string          `json:"launchArgs,omitempty"`

	// BaseEnv overrides inherited os.Environ() when building child process env (useful in tests).
	BaseEnv []string `json:"-"`
	// Launcher injects process execution (defaults to ExecLauncher).
	Launcher Launcher `json:"-"`
	// Now returns Unix millisecond timestamps (defaults to time.Now().UnixMilli).
	Now func() int64 `json:"-"`
	// BaselineTimeout bounds pre-turn Resume usage probes (defaults to 5s).
	BaselineTimeout time.Duration `json:"-"`
	// RequestTimeout bounds RPC handshake requests (defaults to 30s).
	RequestTimeout time.Duration `json:"-"`
}

func (o SessionOptions) nowMillis() int64 {
	if o.Now != nil {
		return o.Now()
	}
	return time.Now().UnixMilli()
}

func (o SessionOptions) baselineTimeout() time.Duration {
	if o.BaselineTimeout > 0 {
		return o.BaselineTimeout
	}
	return defaultBaselineTimeout
}

func (o SessionOptions) requestTimeout() time.Duration {
	if o.RequestTimeout > 0 {
		return o.RequestTimeout
	}
	return defaultRequestTimeout
}

func (o SessionOptions) launcher() Launcher {
	if o.Launcher != nil {
		return o.Launcher
	}
	return ExecLauncher{}
}

// InputOptions configures a Prompt, Steer, or Queue invocation.
type InputOptions struct {
	InputID string
	SpanID  string
}

// InputOption mutates InputOptions.
type InputOption func(*InputOptions)

// WithInputID binds a caller-chosen identifier to a queued input for later Withdraw calls.
func WithInputID(id string) InputOption {
	return func(o *InputOptions) {
		o.InputID = id
	}
}

// WithSpanID binds a caller-chosen span identifier to a prompt or steer turn.
func WithSpanID(id string) InputOption {
	return func(o *InputOptions) {
		o.SpanID = id
	}
}

func resolveInputOptions(opts []InputOption) InputOptions {
	var out InputOptions
	for _, fn := range opts {
		if fn != nil {
			fn(&out)
		}
	}
	return out
}

// LaunchSpec captures the shell-free command invocation passed to a Launcher.
type LaunchSpec struct {
	Command string
	Args    []string
	Dir     string
	Env     []string
}

// ExitStatus reports how a child process exited.
type ExitStatus struct {
	Code   int
	Signal string
}

// Process abstracts a bidirectional stdio subprocess handle.
type Process interface {
	Stdin() io.WriteCloser
	Stdout() io.ReadCloser
	Stderr() io.ReadCloser
	Wait() (ExitStatus, error)
	Interrupt() error
	Close() error
}

// Launcher spawns a Process for a LaunchSpec.
type Launcher interface {
	Launch(ctx context.Context, spec LaunchSpec) (Process, error)
}

// Driver opens sessions for a specific external coding agent CLI.
type Driver interface {
	ID() string
	RefusedOptions() RefusedOptions
	Open(ctx context.Context, opts SessionOptions) (Session, error)
}

// Session represents one running or resumed agent CLI session over a multiplexed stream.
type Session interface {
	ID() string
	Runtime() string

	Prompt(ctx context.Context, input string, opts ...InputOption) (ControlOutcome, error)
	Steer(ctx context.Context, input string, opts ...InputOption) (ControlOutcome, error)
	Queue(ctx context.Context, input string, opts ...InputOption) (ControlOutcome, error)
	Withdraw(ctx context.Context, inputID string) (ControlOutcome, error)
	Abort(ctx context.Context) (ControlOutcome, error)
	Compact(ctx context.Context) (ControlOutcome, error)
	StopTask(ctx context.Context, taskID string) (ControlOutcome, error)
	Control(ctx context.Context, action ControlAction, arg string, opts ...InputOption) (ControlOutcome, error)

	Records() []RecordEnvelope
	Subscribe(afterSeq int64, fn func(RecordEnvelope)) (stop func())
	Usage() *TokenTotals
	Wait(ctx context.Context) error
	Dispose(ctx context.Context) error
}
