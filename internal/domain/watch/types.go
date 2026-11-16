package watch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/domain/channel"
	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

var (
	ErrNotFound             = errors.New("watch: record not found")
	ErrInvalidArgument      = errors.New("watch: invalid argument")
	ErrSeatCapacityReached  = errors.New("watch: seat capacity reached")
	ErrStoreClosed          = errors.New("watch: store is closed")
	ErrDispatcherRequired   = errors.New("watch: dispatcher not configured")
	ErrConversationRequired = errors.New("watch: seat conversationId is required for dispatch")
)

const (
	DefaultMaxConsecutiveAgentTurns = 4
	DefaultCooldownWindow           = 60 * time.Second
	DefaultWakeBreakerLimit         = 3
	DefaultOwnerActorID             = "user"
)

// BrakeKind identifies which wakeup brake blocked or gated a candidate delivery.
type BrakeKind string

const (
	BrakeNone         BrakeKind = ""
	BrakeHopLimit     BrakeKind = "hop_limit"
	BrakeCooldown     BrakeKind = "cooldown"
	BrakeMentionScope BrakeKind = "mention_scope"
	BrakeWakeBreaker  BrakeKind = "wake_breaker"
)

// BrakeConfig configures the three wakeup brakes and optional wake breaker.
type BrakeConfig struct {
	MaxConsecutiveAgentTurns       int
	CooldownWindow                 time.Duration
	OrchestratorExemptFromCooldown bool
	WakeBreakerLimit               int
	OwnerActorIDs                  []string
}

// DefaultBrakeConfig returns VibeValley's default brake settings (4 hops, 60s cooldown, mention/thread scope gate).
func DefaultBrakeConfig() BrakeConfig {
	return BrakeConfig{
		MaxConsecutiveAgentTurns:       DefaultMaxConsecutiveAgentTurns,
		CooldownWindow:                 DefaultCooldownWindow,
		OrchestratorExemptFromCooldown: true,
		WakeBreakerLimit:               DefaultWakeBreakerLimit,
		OwnerActorIDs:                  []string{DefaultOwnerActorID, "owner"},
	}
}

func (c BrakeConfig) withDefaults() BrakeConfig {
	if c.MaxConsecutiveAgentTurns <= 0 {
		c.MaxConsecutiveAgentTurns = DefaultMaxConsecutiveAgentTurns
	}
	if c.CooldownWindow <= 0 {
		c.CooldownWindow = DefaultCooldownWindow
	}
	if c.WakeBreakerLimit <= 0 {
		c.WakeBreakerLimit = DefaultWakeBreakerLimit
	}
	if len(c.OwnerActorIDs) == 0 {
		c.OwnerActorIDs = []string{DefaultOwnerActorID, "owner"}
	}
	return c
}

// Seat binds an agent profile or worker session to a channel or thread.
type Seat struct {
	ChannelID      string            `json:"channelId"`
	AgentID        string            `json:"agentId"`
	Role           channel.ActorRole `json:"role"`
	ConversationID string            `json:"conversationId"`
	SessionID      string            `json:"sessionId,omitempty"`
	ThreadOwner    bool              `json:"threadOwner,omitempty"`
	HomeChannelID  string            `json:"homeChannelId,omitempty"`
	Active         bool              `json:"active"`
	SeatedAtMs     int64             `json:"seatedAtMs"`
}

// BrakeState persists per-scope consecutive agent turns, per-agent cooldown timestamps, and empty-wake counts.
type BrakeState struct {
	ConsecutiveAgentTurns map[string]int   `json:"consecutiveAgentTurns"`
	LastAgentWakeAtMs     map[string]int64 `json:"lastAgentWakeAtMs"`
	EmptyWakes            map[string]int   `json:"emptyWakes"`
	BrokenAgents          map[string]bool  `json:"brokenAgents"`
}

func newBrakeState() BrakeState {
	return BrakeState{
		ConsecutiveAgentTurns: make(map[string]int),
		LastAgentWakeAtMs:     make(map[string]int64),
		EmptyWakes:            make(map[string]int),
		BrokenAgents:          make(map[string]bool),
	}
}

func cloneBrakeState(s BrakeState) BrakeState {
	out := newBrakeState()
	for k, v := range s.ConsecutiveAgentTurns {
		out.ConsecutiveAgentTurns[k] = v
	}
	for k, v := range s.LastAgentWakeAtMs {
		out.LastAgentWakeAtMs[k] = v
	}
	for k, v := range s.EmptyWakes {
		out.EmptyWakes[k] = v
	}
	for k, v := range s.BrokenAgents {
		out.BrokenAgents[k] = v
	}
	return out
}

// WakeDecision records the evaluation result of the three brakes for one recipient on an event.
type WakeDecision struct {
	RecipientID    string    `json:"recipientId"`
	ConversationID string    `json:"conversationId,omitempty"`
	SessionID      string    `json:"sessionId,omitempty"`
	Allowed        bool      `json:"allowed"`
	Brake          BrakeKind `json:"brake,omitempty"`
	Reason         string    `json:"reason"`
	RequestID      string    `json:"requestId"`
}

// DispatchRequest is submitted idempotently to durable (or a narrow sink) when a wakeup passes all brakes.
type DispatchRequest struct {
	ConversationID string `json:"conversationId"`
	RequestID      string `json:"requestId"`
	ChannelID      string `json:"channelId"`
	EventSeq       int64  `json:"eventSeq"`
	RecipientID    string `json:"recipientId"`
	SessionID      string `json:"sessionId,omitempty"`
	IssueID        string `json:"issueId,omitempty"`
	AuthorID       string `json:"authorId"`
	Text           string `json:"text"`
	CreatedAtMs    int64  `json:"createdAtMs"`
}

// DispatchResult reports submission outcome and whether requestId deduplicated an earlier dispatch.
type DispatchResult struct {
	SubmissionID string `json:"submissionId"`
	Deduplicated bool   `json:"deduplicated"`
}

// Dispatcher submits a wake request anchored by requestId = "chan_evt:<channelId>:<seq>".
type Dispatcher interface {
	Dispatch(ctx context.Context, req DispatchRequest) (DispatchResult, error)
}

// DispatcherFunc adapts a function to Dispatcher.
type DispatcherFunc func(ctx context.Context, req DispatchRequest) (DispatchResult, error)

func (f DispatcherFunc) Dispatch(ctx context.Context, req DispatchRequest) (DispatchResult, error) {
	return f(ctx, req)
}

// DurableDispatcher submits idempotent channel wake requests into durable_submission
// using requestId = "chan_evt:<channelId>:<seq>" and invokes OnDispatched ONLY on fresh (non-deduplicated) commits.
type DurableDispatcher struct {
	Store        *store.Store
	NotifyTaskID string
	OnDispatched func(ctx context.Context, req DispatchRequest, sub store.Submission) error
}

// Dispatch persists the submission idempotently by (conversation_id, request_id) and runs OnDispatched
// strictly when the submission was not previously committed.
func (d *DurableDispatcher) Dispatch(ctx context.Context, req DispatchRequest) (DispatchResult, error) {
	if d == nil || d.Store == nil {
		return DispatchResult{}, ErrDispatcherRequired
	}
	if req.ConversationID == "" {
		return DispatchResult{}, ErrConversationRequired
	}
	payload, err := json.Marshal(req)
	if err != nil {
		return DispatchResult{}, err
	}
	res, err := d.Store.Submit(ctx, store.Submission{
		ConversationID: req.ConversationID,
		RequestID:      req.RequestID,
		Kind:           "channel_wake",
		PayloadJSON:    payload,
		NotifyTaskID:   d.NotifyTaskID,
	})
	if err != nil {
		return DispatchResult{}, err
	}
	if !res.Deduplicated && d.OnDispatched != nil {
		if err := d.OnDispatched(ctx, req, res.Submission); err != nil {
			return DispatchResult{}, err
		}
	}
	return DispatchResult{
		SubmissionID: res.Submission.ID,
		Deduplicated: res.Deduplicated,
	}, nil
}

// EventOutcome summarizes the routing, brake evaluations, inbox items, and dispatches for one channel event.
type EventOutcome struct {
	GlobalSeq    int64                    `json:"globalSeq"`
	ChannelID    string                   `json:"channelId"`
	Seq          int64                    `json:"seq"`
	Decisions    []WakeDecision           `json:"decisions,omitempty"`
	Dispatched   []DispatchResult         `json:"dispatched,omitempty"`
	InboxCreated []contract.InboxItemView `json:"inboxCreated,omitempty"`
}

// RequestIDForEvent builds the canonical crash-safe idempotency key "chan_evt:<channelId>:<seq>".
func RequestIDForEvent(channelID string, seq int64) string {
	return fmt.Sprintf("chan_evt:%s:%d", channelID, seq)
}

func cloneSeat(s Seat) Seat { return s }

func cloneInboxItem(it contract.InboxItemView) contract.InboxItemView { return it }

// WatchStore abstracts in-memory and SQLite persistence for watch cursors, seats, brake state, and inbox items.
type watchBackend interface {
	getCursor(ctx context.Context) (int64, error)
	setCursor(ctx context.Context, globalSeq, nowMs int64) error
	upsertSeat(ctx context.Context, seat Seat, maxPerChan, maxActive int) error
	vacateSeat(ctx context.Context, channelID, agentID string) error
	getSeat(ctx context.Context, channelID, agentID string) (Seat, bool, error)
	listSeats(ctx context.Context, channelID string) ([]Seat, error)
	homeOf(ctx context.Context, agentID string) (string, bool, error)
	loadBrakes(ctx context.Context) (BrakeState, error)
	saveBrakes(ctx context.Context, state BrakeState) error
	upsertInbox(ctx context.Context, item contract.InboxItemView) error
	upsertInboxWithChannel(ctx context.Context, item contract.InboxItemView, channelID string, eventSeq int64) error
	resolveInbox(ctx context.Context, id string) (bool, error)
	resolveChannelInboxUpTo(ctx context.Context, channelID string, maxSeq int64) error
	listInbox(ctx context.Context, includeResolved bool) ([]contract.InboxItemView, error)
	close() error
}

// Option configures a watch Service.
type Option func(*serviceConfig)

type serviceConfig struct {
	clock                      channel.Clock
	brakes                     BrakeConfig
	dispatcher                 Dispatcher
	maxConcurrentSeatsPerChan  int
	maxActiveSeats             int
	beforeCursorAdvanceFailure func(channel.Event) error
}

// WithClock overrides the clock used by cooldown calculations and timestamps.
func WithClock(clock channel.Clock) Option {
	return func(c *serviceConfig) {
		if clock != nil {
			c.clock = clock
		}
	}
}

// WithBrakeConfig configures the three wakeup brakes.
func WithBrakeConfig(cfg BrakeConfig) Option {
	return func(c *serviceConfig) {
		c.brakes = cfg
	}
}

// WithDispatcher configures the submission dispatcher invoked on allowed wakeups.
func WithDispatcher(d Dispatcher) Option {
	return func(c *serviceConfig) {
		c.dispatcher = d
	}
}

// WithSeatLimits bounds concurrent active worker seats per channel and globally.
func WithSeatLimits(perChannel, totalActive int) Option {
	return func(c *serviceConfig) {
		c.maxConcurrentSeatsPerChan = perChannel
		c.maxActiveSeats = totalActive
	}
}

// WithCursorHook installs a test hook invoked after dispatch and before watch_cursor advances,
// allowing crash-before-cursor-commit tests to verify zero double dispatches.
func WithCursorHook(fn func(channel.Event) error) Option {
	return func(c *serviceConfig) {
		c.beforeCursorAdvanceFailure = fn
	}
}

func containsFold(list []string, target string) bool {
	return slices.Contains(list, target)
}
