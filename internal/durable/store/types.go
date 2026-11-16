package store

import (
	"encoding/json"
	"errors"
)

var (
	ErrNotFound            = errors.New("durable/store: record not found")
	ErrDeferredOnlyForLive = errors.New("durable/store: deferred flush is only permitted for pi.live documents")
	ErrDuplicate           = errors.New("durable/store: duplicate key")
	ErrConflict            = errors.New("durable/store: conflict")
	ErrImmutableLedger     = errors.New("durable/store: entry ledger is immutable")
	ErrStoreClosed         = errors.New("durable/store: store is closed")
	ErrInvalidWaitMode     = errors.New("durable/store: invalid wait mode")
	ErrInvalidTransition   = errors.New("durable/store: invalid state transition")
	ErrInvalidArgument     = errors.New("durable/store: invalid argument")
)

// Entry kinds in durable_entry.
const (
	EntryUser       = "pi.user"
	EntryAssistant  = "pi.assistant"
	EntryToolResult = "pi.tool_result"
	EntrySystem     = "pi.system"
	EntryCompaction = "pi.compaction"
	EntryReset      = "pi.reset"
)

// Built-in document kinds and scope kinds in durable_document.
const (
	DocAgent      = "pi.agent"
	DocLive       = "pi.live"
	DocInbox      = "pi.inbox"
	DocUsage      = "pi.usage"
	DocGovernance = "pi.governance"

	ScopeConversation = "conversation"
	ScopeTask         = "task"
	ScopeGlobal       = "global"
	ScopeSession      = "session"
)

// Submission statuses and settlement signal name.
const (
	SubmissionQueued     = "queued"
	SubmissionPlaced     = "placed"
	SubmissionDone       = "done"
	SubmissionUnanswered = "unanswered"

	SignalSubmissionSettled = "pi.submission_settled"
)

// TaskStatus captures the explicit phase state machine lifecycle.
type TaskStatus string

const (
	TaskPending    TaskStatus = "pending"
	TaskRunning    TaskStatus = "running"
	TaskSleeping   TaskStatus = "sleeping"
	TaskWaiting    TaskStatus = "waiting"
	TaskCompleting TaskStatus = "completing"
	TaskTerminal   TaskStatus = "terminal"
)

// Terminal reasons for durable_task.
const (
	ReasonCompleted    = "completed"
	ReasonFailed       = "failed"
	ReasonAborted      = "aborted"
	ReasonRestartLimit = "restart_limit"
)

// WaitMode specifies child task completion semantics for TransWaitTasks.
type WaitMode string

const (
	WaitAllSettled WaitMode = "allSettled"
	WaitFailFast   WaitMode = "failFast"
	WaitAny        WaitMode = "any"
)

// Valid reports whether w is one of the supported WaitMode values.
func (w WaitMode) Valid() bool {
	switch w {
	case WaitAllSettled, WaitFailFast, WaitAny:
		return true
	default:
		return false
	}
}

// Conversation represents a durable_conversation row.
type Conversation struct {
	ID               string `json:"id"`
	OwnerTaskID      string `json:"ownerTaskId,omitempty"`
	ParentID         string `json:"parentId,omitempty"`
	ForkEntrySeq     int64  `json:"forkEntrySeq,omitempty"`
	HeadSeq          int64  `json:"headSeq"`
	NextSeq          int64  `json:"nextSeq"`
	ProviderAffinity string `json:"providerAffinity"`
	MetadataJSON     []byte `json:"metadataJson,omitempty"`
	CreatedAtMs      int64  `json:"createdAtMs"`
	UpdatedAtMs      int64  `json:"updatedAtMs"`
}

// Entry represents an immutable durable_entry ledger row.
type Entry struct {
	ConversationID string `json:"conversationId"`
	Seq            int64  `json:"seq"`
	Kind           string `json:"kind"`
	PayloadJSON    []byte `json:"payloadJson"`
	CreatedAtMs    int64  `json:"createdAtMs"`
}

// CompactionPayload is the canonical JSON payload stored in pi.compaction entries.
type CompactionPayload struct {
	Level       string `json:"level"`
	BaseHeadSeq int64  `json:"baseHeadSeq"`
	FromSeq     int64  `json:"fromSeq"`
	CutSeq      int64  `json:"cutSeq"`
	Summary     string `json:"summary"`
	TokenCount  int64  `json:"tokenCount,omitempty"`
}

// CompactionCommit describes an atomic compaction commit attempt.
type CompactionCommit struct {
	ConversationID string
	Level          string
	BaseHeadSeq    int64
	FromSeq        int64
	CutSeq         int64
	Summary        string
	TokenCount     int64
}

// CompactionOutcome reports whether a compaction committed or was discarded as stale.
type CompactionOutcome struct {
	Applied    bool  `json:"applied"`
	Stale      bool  `json:"stale"`
	EntrySeq   int64 `json:"entrySeq,omitempty"`
	NewHeadSeq int64 `json:"newHeadSeq,omitempty"`
}

// DocKey uniquely addresses a durable_document row.
type DocKey struct {
	ScopeKind string `json:"scopeKind"`
	ScopeID   string `json:"scopeId"`
	DocKind   string `json:"docKind"`
}

// Document represents a durable_document snapshot row.
type Document struct {
	ScopeKind   string `json:"scopeKind"`
	ScopeID     string `json:"scopeId"`
	DocKind     string `json:"docKind"`
	Rev         int64  `json:"rev"`
	StateJSON   []byte `json:"stateJson"`
	UpdatedAtMs int64  `json:"updatedAtMs"`
}

// DocumentEvent is delivered to DocumentObservers AFTER disk commit (or on 100ms deferred pi.live memory push).
type DocumentEvent struct {
	ScopeKind   string `json:"scopeKind"`
	ScopeID     string `json:"scopeId"`
	DocKind     string `json:"docKind"`
	Rev         int64  `json:"rev"`
	StateJSON   []byte `json:"stateJson"`
	Retired     bool   `json:"retired,omitempty"`
	Durable     bool   `json:"durable"`
	UpdatedAtMs int64  `json:"updatedAtMs"`
}

// DocumentObserver receives committed document updates (and 100ms deferred live memory pushes).
type DocumentObserver interface {
	OnDocumentChange(ev DocumentEvent)
}

// DocumentObserverFunc adapts a function to DocumentObserver.
type DocumentObserverFunc func(ev DocumentEvent)

func (f DocumentObserverFunc) OnDocumentChange(ev DocumentEvent) { f(ev) }

// Submission represents a durable_submission row.
type Submission struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversationId"`
	RequestID      string `json:"requestId"`
	Kind           string `json:"kind"`
	Status         string `json:"status"`
	PayloadJSON    []byte `json:"payloadJson"`
	NotifyTaskID   string `json:"notifyTaskId,omitempty"`
	ResultJSON     []byte `json:"resultJson,omitempty"`
	CreatedAtMs    int64  `json:"createdAtMs"`
	UpdatedAtMs    int64  `json:"updatedAtMs"`
}

// SubmitResult reports the persisted submission and whether requestId deduplicated an existing row.
type SubmitResult struct {
	Submission   Submission `json:"submission"`
	Deduplicated bool       `json:"deduplicated"`
}

// Task represents a durable_task phase state machine row.
type Task struct {
	ID             string     `json:"id"`
	ConversationID string     `json:"conversationId,omitempty"`
	OwnerTaskID    string     `json:"ownerTaskId,omitempty"`
	DedupKey       string     `json:"dedupKey,omitempty"`
	Kind           string     `json:"kind"`
	IsModelTask    bool       `json:"isModelTask"`
	Status         TaskStatus `json:"status"`
	TerminalReason string     `json:"terminalReason,omitempty"`
	RestartCount   int        `json:"restartCount"`
	RestartLimit   int        `json:"restartLimit"`
	PhaseName      string     `json:"phaseName"`
	CheckpointJSON []byte     `json:"checkpointJson"`
	WakeUntilMs    int64      `json:"wakeUntilMs,omitempty"`
	WaitMode       WaitMode   `json:"waitMode,omitempty"`
	WaitTaskIDs    []string   `json:"waitTaskIds,omitempty"`
	WaitSignalName string     `json:"waitSignalName,omitempty"`
	MemoJSON       []byte     `json:"memoJson"`
	ResultJSON     []byte     `json:"resultJson,omitempty"`
	ErrorText      string     `json:"errorText,omitempty"`
	CreatedAtMs    int64      `json:"createdAtMs"`
	UpdatedAtMs    int64      `json:"updatedAtMs"`
}

// CreateTaskResult reports the created or deduplicated task.
type CreateTaskResult struct {
	Task         Task `json:"task"`
	Deduplicated bool `json:"deduplicated"`
}

// Signal represents a durable_signal row.
type Signal struct {
	ID           string `json:"id"`
	TaskID       string `json:"taskId"`
	SignalName   string `json:"signalName"`
	SignalKey    string `json:"signalKey,omitempty"`
	PayloadJSON  []byte `json:"payloadJson"`
	Consumed     bool   `json:"consumed"`
	ConsumedAtMs int64  `json:"consumedAtMs,omitempty"`
	CreatedAtMs  int64  `json:"createdAtMs"`
}

// SendSignalResult reports the persisted signal and whether (task_id, signal_name, signal_key) deduplicated.
type SendSignalResult struct {
	Signal       Signal `json:"signal"`
	Deduplicated bool   `json:"deduplicated"`
}

// GroupCommitStats exposes observability counters for batch group commit and deferred live flushing.
type GroupCommitStats struct {
	Requests            int64 `json:"requests"`
	Batches             int64 `json:"batches"`
	CommittedOps        int64 `json:"committedOps"`
	FailedOps           int64 `json:"failedOps"`
	CoalescedLiveMemory int64 `json:"coalescedLiveMemory"`
	CoalescedLiveDisk   int64 `json:"coalescedLiveDisk"`
}

func cloneBytes(b []byte) []byte {
	if len(b) == 0 {
		return nil
	}
	cp := make([]byte, len(b))
	copy(cp, b)
	return cp
}

func requireJSON(b []byte, fallback string) ([]byte, error) {
	if len(b) == 0 {
		return []byte(fallback), nil
	}
	if !json.Valid(b) {
		return nil, ErrInvalidArgument
	}
	return cloneBytes(b), nil
}
