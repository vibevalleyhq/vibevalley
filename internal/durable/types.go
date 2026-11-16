package durable

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
)

var (
	ErrPhaseNotRegistered       = errors.New("durable: phase handler not registered")
	ErrRestartLimitExceeded     = errors.New("durable: consecutive unprogressed restart limit exceeded")
	ErrPermissionDenied         = errors.New("durable: tool permission denied")
	ErrPermissionNotOverridable = errors.New("durable: hard permission denial cannot be overridden by client")
	ErrContextOverflow          = errors.New("durable: model context window overflow")
	ErrStepQuotaExceeded        = errors.New("durable: codemode step quota exceeded")
	ErrScriptSyntax             = errors.New("durable: codemode script syntax error")
	ErrScriptQuotaExceeded      = errors.New("durable: codemode memory or variable quota exceeded")
	ErrUnknownTool              = errors.New("durable: unknown tool")
)

// TransitionKind identifies the explicit phase transition returned by a PhaseFunc.
type TransitionKind string

const (
	TransitionNext      TransitionKind = "next"
	TransitionSleep     TransitionKind = "sleep"
	TransitionWaitTasks TransitionKind = "wait_tasks"
	TransitionComplete  TransitionKind = "complete"
	TransitionFail      TransitionKind = "fail"
)

// SleepOptions configures TransSleep wakeup triggers without holding any goroutine.
type SleepOptions struct {
	WakeAfter   time.Duration
	WakeUntilMs int64
	SignalName  string
}

// Transition instructs the scheduler how to atomically advance a task after a phase finishes.
type Transition struct {
	Kind           TransitionKind
	NextPhase      string
	Checkpoint     any
	HasCheckpoint  bool
	Sleep          SleepOptions
	WaitMode       store.WaitMode
	WaitTaskIDs    []string
	Result         any
	TerminalReason string
	Err            error
}

// TransNext advances the task immediately to nextPhase with an updated checkpoint (resetting restart_count).
func TransNext(nextPhase string, checkpoint any) Transition {
	return Transition{
		Kind:          TransitionNext,
		NextPhase:     nextPhase,
		Checkpoint:    checkpoint,
		HasCheckpoint: checkpoint != nil,
	}
}

// TransSleep persists sleeping state (waiting on timer and/or signalName) and releases the worker goroutine.
func TransSleep(nextPhase string, checkpoint any, opts SleepOptions) Transition {
	return Transition{
		Kind:          TransitionSleep,
		NextPhase:     nextPhase,
		Checkpoint:    checkpoint,
		HasCheckpoint: checkpoint != nil,
		Sleep:         opts,
	}
}

// TransWaitTasks persists waiting state on childIDs with waitMode and releases the worker goroutine.
func TransWaitTasks(nextPhase string, checkpoint any, mode store.WaitMode, childIDs []string) Transition {
	return Transition{
		Kind:          TransitionWaitTasks,
		NextPhase:     nextPhase,
		Checkpoint:    checkpoint,
		HasCheckpoint: checkpoint != nil,
		WaitMode:      mode,
		WaitTaskIDs:   append([]string(nil), childIDs...),
	}
}

// TransComplete transitions the task to terminal/completed and wakes any waiting parent task.
func TransComplete(result any) Transition {
	return Transition{
		Kind:   TransitionComplete,
		Result: result,
	}
}

// TransFail transitions the task to terminal failure with reason (defaults to store.ReasonFailed).
func TransFail(reason string, err error) Transition {
	if reason == "" {
		reason = store.ReasonFailed
	}
	return Transition{
		Kind:           TransitionFail,
		TerminalReason: reason,
		Err:            err,
	}
}

// PhaseFunc executes a single non-blocking phase step for a durable task.
type PhaseFunc func(ctx context.Context, tc *TaskContext) (Transition, error)

// ChildTaskSpec defines parameters for spawning a durable child task owned by a parent task.
type ChildTaskSpec struct {
	ConversationID string
	DedupKey       string
	Kind           string
	IsModelTask    bool
	PhaseName      string
	Checkpoint     any
	RestartLimit   int
}

// AlertKind categorizes durable scheduler and governance alerts persisted to pi.inbox.
type AlertKind string

const (
	AlertRestartLimit   AlertKind = "restart_limit"
	AlertBudgetReached  AlertKind = "budget_reached"
	AlertPermissionPark AlertKind = "permission_park"
)

// Alert is emitted on circuit breaks, budget pauses, and human-in-the-loop permission parks.
type Alert struct {
	Kind           AlertKind       `json:"kind"`
	TaskID         string          `json:"taskId,omitempty"`
	ConversationID string          `json:"conversationId,omitempty"`
	Title          string          `json:"title"`
	Message        string          `json:"message"`
	Payload        json.RawMessage `json:"payload,omitempty"`
	CreatedAtMs    int64           `json:"createdAtMs"`
}

// AlertSink receives real-time scheduler/governance alerts in addition to pi.inbox persistence.
type AlertSink interface {
	OnAlert(alert Alert)
}

// AlertSinkFunc adapts a function to AlertSink.
type AlertSinkFunc func(alert Alert)

func (f AlertSinkFunc) OnAlert(a Alert) { f(a) }

// Lease tracks an active remote or local execution environment lease without coupling to machine transport.
type Lease struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversationId"`
	Active         bool   `json:"active"`
	ReleasedReason string `json:"releasedReason,omitempty"`
	AcquiredAtMs   int64  `json:"acquiredAtMs"`
	ReleasedAtMs   int64  `json:"releasedAtMs,omitempty"`
}

// LeaseStore tracks workspace leases so BudgetGate can prove leases stay intact during budget_reached sleep.
type LeaseStore struct {
	mu     sync.RWMutex
	leases map[string]*Lease
}

// NewLeaseStore creates an in-memory LeaseStore.
func NewLeaseStore() *LeaseStore {
	return &LeaseStore{leases: make(map[string]*Lease)}
}

func (l *LeaseStore) Acquire(convID, leaseID string, nowMs int64) Lease {
	l.mu.Lock()
	defer l.mu.Unlock()
	cp := &Lease{
		ID:             leaseID,
		ConversationID: convID,
		Active:         true,
		AcquiredAtMs:   nowMs,
	}
	l.leases[convID] = cp
	return *cp
}

func (l *LeaseStore) Release(convID, reason string, nowMs int64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if cur, ok := l.leases[convID]; ok {
		cur.Active = false
		cur.ReleasedReason = reason
		cur.ReleasedAtMs = nowMs
	}
}

func (l *LeaseStore) Get(convID string) (Lease, bool) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	cur, ok := l.leases[convID]
	if !ok {
		return Lease{}, false
	}
	return *cur, true
}
