package oar

import (
	"context"
	"errors"
)

// Session contract: one ordered, resumable record stream
// (contracts/session.ts). Everything the runtime said is in the stream,
// nothing OAR did not observe is in it, every record knows whose it is, and
// the stream is readable again from any position.
//
// Go specifics:
//   - Control methods take a context, used only to bound waits for the
//     runtime's answer; they never return an error for a refusal: a refusal is
//     a rejected ControlOutcome with a typed Code.
//   - A control the runtime cannot do at all (TS: an absent member) returns
//     ErrControlUnsupported; CanSteer / CanWithdraw tell beforehand.
//   - Observers (RawEvents, Events) run on a delivery goroutine of their own
//     subscription, one record at a time, in seq order, never concurrently
//     with themselves, and never on the goroutine that appended the record. A
//     panicking observer is recovered and cannot touch the run. With a
//     cursor, retained records after AfterSeq are replayed synchronously
//     inside the subscribing call before it returns, then delivery continues
//     live: no loss, no duplication.

// ErrControlUnsupported answers a control the session does not have
// (steer where the runtime cannot inject, withdraw where OAR does not hold
// the queue, resources / context breakdown where the runtime has none).
var ErrControlUnsupported = errors.New("oar: the session does not support this control")

// Cursor resumes reading after AfterSeq; -1 reads from the start.
type Cursor struct {
	SessionID string `json:"sessionId"`
	AfterSeq  int64  `json:"afterSeq"`
}

// SessionNode is a true session: the root or a derived child.
type SessionNode struct {
	ID string `json:"id"`
}

// SessionEdge is runtime-reported lineage.
type SessionEdge struct {
	Parent string `json:"parent"`
	Child  string `json:"child"`
	Via    string `json:"via"`
}

// SessionGraph holds true sessions only.
type SessionGraph struct {
	Nodes []SessionNode `json:"nodes"`
	Edges []SessionEdge `json:"edges"`
}

// QueryResult is a fold's current value and the seq of the last consumed record (-1 before any).
type QueryResult[T any] struct {
	Value T     `json:"value"`
	Seq   int64 `json:"seq"`
}

// InputOptions for prompt, steer and queue. Empty text requires at least one image.
type InputOptions struct {
	// UUID identifying one logical input across delivery attempts; generated when empty.
	InputID string
	// Images that travel with the input; rejected unsupported when capabilities say no images.
	Images []InputImage
	// Who the input comes from; recorded, never sent to the runtime.
	Origin *InputOrigin
}

// ControlResult holds both records a control call produced (the SPI face).
type ControlResult struct {
	Request  RawEvent
	Response RawEvent
}

// ControlOutcome is what Session controls return (the API face): the answer
// read off the two records. Kind is "accepted" or "rejected"; Code and
// Reason are set when rejected. Seq is the request's position.
type ControlOutcome struct {
	ControlResult
	Kind      ResponseKind
	Seq       int64
	RequestID string
	Code      RejectionCode
	Reason    string
}

// IsAccepted reports an accepted control.
func (o ControlOutcome) IsAccepted() bool { return o.Kind == ResponseAccepted }

// AttributionTier is "none", "opaque", "attributed" or "nested".
type AttributionTier string

// SessionCapabilities are per-session facts a host reads before acting.
type SessionCapabilities struct {
	// Whether input held for a later turn survives a process restart.
	QueueDurable bool            `json:"-"`
	Attribution  AttributionTier `json:"attribution"`
	Images       bool            `json:"images"`
}

// SessionResources is the host memory a session's runtime takes.
type SessionResources struct {
	RSS       int64 `json:"rss"`
	Processes int   `json:"processes"`
}

// ContextBreakdown is what fills a session's context window, by the runtime's own categories.
type ContextBreakdown struct {
	Tokens        int64             `json:"tokens"`
	ContextWindow int64             `json:"contextWindow"`
	Categories    []ContextCategory `json:"categories"`
}

type ContextCategory struct {
	Name   string `json:"name"`
	Tokens int64  `json:"tokens"`
	// "used" | "deferred" | "reserved" | "free" | "unknown"
	Kind  string        `json:"kind"`
	Items []ContextItem `json:"items,omitempty"`
}

type ContextItem struct {
	Name   string `json:"name"`
	Tokens int64  `json:"tokens"`
}

// RawEventObserver receives one record at a time.
type RawEventObserver func(RawEvent)

// EventObserver receives one event at a time.
type EventObserver func(Event)

// Unsubscribe stops a subscription. A delivery already in progress completes;
// none begins after it returns (unless called from inside that observer).
type Unsubscribe func()

// EventsOptions for Session.Events.
type EventsOptions struct {
	// Replay retained records after AfterSeq first, then continue live.
	Cursor *Cursor
	// Merge consecutive text_delta (and readable reasoning) events of one agent.
	CoalesceText bool
	// With CoalesceText, flush a held piece after the stream is quiet this long (0: never).
	MaxHoldMs int64
}

// AdapterSession is the SPI face: what an adapter builds.
type AdapterSession interface {
	// Runtime-native persistent identity; pass to SessionOptions.Resume to reattach.
	ID() string
	Capabilities() SessionCapabilities
	// ≤1 active turn: rejected busy while one runs; never queues implicitly.
	Prompt(ctx context.Context, input string, options InputOptions) (ControlResult, error)
	// Input for a later turn, held by the runtime or the adapter.
	Queue(ctx context.Context, input string, options InputOptions) (ControlResult, error)
	// Interrupt the active turn; accepted means the interrupt was delivered.
	Abort(ctx context.Context) (ControlResult, error)
	RawEvents(observer RawEventObserver, cursor *Cursor) Unsubscribe
	// Every record this process observed, in seq order. The slice is a snapshot; never modify it.
	Records() []RawEvent
	Graph() SessionGraph
	// Records a dispose request, interrupts active work, releases the runtime
	// and every process it started, records the exit; idempotent; always settles.
	Dispose(ctx context.Context) error
}

// Steerer is an AdapterSession that can inject into an active turn.
type Steerer interface {
	Steer(ctx context.Context, input string, options InputOptions) (ControlResult, error)
}

// Withdrawer is an AdapterSession that holds its queue and can take an entry back.
type Withdrawer interface {
	Withdraw(ctx context.Context, inputID string) (ControlResult, error)
}

// ResourceReader is an AdapterSession whose runtime has a process of its own.
type ResourceReader interface {
	// nil once the process has exited, and where no reader exists.
	Resources(ctx context.Context) (*SessionResources, error)
}

// ContextBreakdownReader is an AdapterSession that can itemize its context.
type ContextBreakdownReader interface {
	ContextBreakdown(ctx context.Context) (*ContextBreakdown, error)
}

// Session is the API face: the SPI plus derivations over the stream.
type Session interface {
	ID() string
	Capabilities() SessionCapabilities

	Prompt(ctx context.Context, input string, options InputOptions) (ControlOutcome, error)
	// ErrControlUnsupported when CanSteer is false.
	Steer(ctx context.Context, input string, options InputOptions) (ControlOutcome, error)
	Queue(ctx context.Context, input string, options InputOptions) (ControlOutcome, error)
	// ErrControlUnsupported when CanWithdraw is false.
	Withdraw(ctx context.Context, inputID string) (ControlOutcome, error)
	Abort(ctx context.Context) (ControlOutcome, error)
	CanSteer() bool
	CanWithdraw() bool

	RawEvents(observer RawEventObserver, cursor *Cursor) Unsubscribe
	Events(observer EventObserver, options EventsOptions) Unsubscribe
	Records() []RawEvent
	Graph() SessionGraph

	Model() QueryResult[*string]
	Effort() QueryResult[*string]
	ServiceTier() QueryResult[*string]
	Usage() QueryResult[SessionUsage]
	ContextUsage() QueryResult[*ContextUsage]
	Status() QueryResult[AgentStatus]

	// Steer when the session can and the steer is accepted, otherwise queue.
	SteerOrQueue(ctx context.Context, input string, options InputOptions) (SteerOrQueueResult, error)
	// Put an input into the session at the moment When names.
	Deliver(ctx context.Context, input string, options DeliverOptions) (DeliverResult, error)

	// Whether Resources and ContextBreakdown are present.
	CanReadResources() bool
	CanReadContextBreakdown() bool
	// ErrControlUnsupported where the runtime has no process of its own.
	Resources(ctx context.Context) (*SessionResources, error)
	// ErrControlUnsupported where the runtime cannot itemize its context.
	ContextBreakdown(ctx context.Context) (*ContextBreakdown, error)

	Dispose(ctx context.Context) error
}

// SessionUsage is this session's token total with a per-agent breakdown.
type SessionUsage struct {
	// nil until the runtime has reported token totals.
	Total        *TokenTotals `json:"total"`
	ByAgent      []AgentTotal `json:"byAgent,omitempty"`
	Unattributed *TokenTotals `json:"unattributed,omitempty"`
	WithChildren *TokenTotals `json:"withChildren,omitempty"`
}

// AgentTotal is one agent's latest running total.
type AgentTotal struct {
	AgentPath []string    `json:"agentPath"`
	Tokens    TokenTotals `json:"tokens"`
}

// SteerOrQueueResult: Landed is "steered", "queued" or "rejected".
type SteerOrQueueResult struct {
	Landed string
	Result ControlOutcome
	Code   RejectionCode
	Reason string
}

// DeliverWhen is "now" (default), "after_turn" or "when_idle".
type DeliverWhen string

// DeliverOptions for Session.Deliver.
type DeliverOptions struct {
	InputOptions
	When DeliverWhen
}

// DeliverResult: Landed is "prompted", "steered", "queued" or "rejected".
// Result is nil only on a rejection where no attempt was made to stick.
type DeliverResult struct {
	Landed  string
	InputID string
	Result  *ControlOutcome
	Code    RejectionCode
	Reason  string
}

// StartSession opens a session. It returns an error only on operational
// failure (spawn, load, auth), or the typed errors in errors.go.
type StartSession func(ctx context.Context, installation AvailableInstallation, options SessionOptions) (Session, error)

func (u SessionUsage) MarshalJSON() ([]byte, error) {
	o := newObject()
	if err := o.field("total", u.Total); err != nil {
		return nil, err
	}
	if u.ByAgent != nil {
		if err := o.field("byAgent", u.ByAgent); err != nil {
			return nil, err
		}
	}
	if u.Unattributed != nil {
		if err := o.field("unattributed", u.Unattributed); err != nil {
			return nil, err
		}
	}
	if u.WithChildren != nil {
		if err := o.field("withChildren", u.WithChildren); err != nil {
			return nil, err
		}
	}
	return o.bytes(), nil
}
