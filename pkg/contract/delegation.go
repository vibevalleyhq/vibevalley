package contract

// ControlAction names a runtime control operation sent to a delegated agent driver.
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

// ControlStatus describes whether an agent driver accepted or rejected a control action.
type ControlStatus string

const (
	ControlAccepted    ControlStatus = "accepted"
	ControlRejected    ControlStatus = "rejected"
	ControlUnsupported ControlStatus = "unsupported"
	ControlNotRunning  ControlStatus = "not_running"
)

// ControlOutcome captures the typed result of a runtime control command without silent failures.
type ControlOutcome struct {
	Status  ControlStatus `json:"status"`
	Reason  string        `json:"reason,omitempty"`
	SpanID  string        `json:"spanId,omitempty"`
	Message string        `json:"message,omitempty"`
}

// UsageTotals records incremental token accounting; unknown fields remain nil or omit false estimates.
type UsageTotals struct {
	InputTokens      int64  `json:"inputTokens"`
	OutputTokens     int64  `json:"outputTokens"`
	CacheReadTokens  int64  `json:"cacheReadTokens"`
	CacheWriteTokens int64  `json:"cacheWriteTokens"`
	ReasoningTokens  int64  `json:"reasoningTokens"`
	CostMicros       *int64 `json:"costMicros,omitempty"`
}

// DelegationRequest configures an external or subagent harness invocation across process boundaries.
type DelegationRequest struct {
	TaskID          string            `json:"taskId"`
	Runtime         string            `json:"runtime"`
	Prompt          string            `json:"prompt"`
	WorkDir         string            `json:"workDir,omitempty"`
	ResumeSessionID string            `json:"resumeSessionId,omitempty"`
	AllowedTools    []string          `json:"allowedTools,omitempty"`
	Env             []string          `json:"env,omitempty"`
	TimeoutMs       int64             `json:"timeoutMs,omitempty"`
	SpanID          string            `json:"spanId,omitempty"`
	Metadata        map[string]string `json:"metadata,omitempty"`
}

// DelegationResult reports completion status and incremental cost attribution of a delegated run.
type DelegationResult struct {
	SessionID   string       `json:"sessionId,omitempty"`
	Success     bool         `json:"success"`
	ExitCode    int          `json:"exitCode"`
	Summary     string       `json:"summary,omitempty"`
	Usage       *UsageTotals `json:"usage,omitempty"`
	Interrupted bool         `json:"interrupted"`
	Error       string       `json:"error,omitempty"`
}
