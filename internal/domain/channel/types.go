package channel

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

var (
	ErrNotFound            = errors.New("channel: record not found")
	ErrInvalidArgument     = errors.New("channel: invalid argument")
	ErrInvalidEventKind    = errors.New("channel: invalid social event kind (internal durable_entry kinds are forbidden)")
	ErrDuplicateChannel    = errors.New("channel: channel already exists")
	ErrAppendOnlyImmutable = errors.New("channel: channel_event ledger is append-only")
	ErrStoreClosed         = errors.New("channel: store is closed")
)

// ChannelType distinguishes public channels, 1:1 direct chats, and issue threads.
type ChannelType string

const (
	TypePublic ChannelType = "channel"
	TypeDirect ChannelType = "direct"
	TypeThread ChannelType = "thread"
)

// ActorKind identifies who emitted a social channel event.
type ActorKind string

const (
	ActorUser   ActorKind = "user"
	ActorAgent  ActorKind = "agent"
	ActorSystem ActorKind = "system"
)

// ActorRole distinguishes orchestrator profiles from worker sessions.
type ActorRole string

const (
	RoleNone         ActorRole = ""
	RoleOrchestrator ActorRole = "orchestrator"
	RoleWorker       ActorRole = "worker"
)

// Clock supplies timestamps for channel events and read cursors.
type Clock interface {
	Now() time.Time
	NowMs() int64
}

// RealClock uses the system wall clock.
type RealClock struct{}

func (RealClock) Now() time.Time { return time.Now() }
func (RealClock) NowMs() int64   { return time.Now().UnixMilli() }

// Channel represents a public channel, direct message stream, or issue thread.
type Channel struct {
	ID              string      `json:"id"`
	Type            ChannelType `json:"type"`
	Name            string      `json:"name"`
	Topic           string      `json:"topic,omitempty"`
	RepoID          string      `json:"repoId,omitempty"`
	DefaultAgentID  string      `json:"defaultAgentId,omitempty"`
	PeerID          string      `json:"peerId,omitempty"`
	ParentChannelID string      `json:"parentChannelId,omitempty"`
	ParentEventSeq  int64       `json:"parentEventSeq,omitempty"`
	IssueID         string      `json:"issueId,omitempty"`
	IsDefault       bool        `json:"isDefault,omitempty"`
	NotifyMode      string      `json:"notifyMode,omitempty"`
	CreatedAtMs     int64       `json:"createdAtMs"`
	UpdatedAtMs     int64       `json:"updatedAtMs"`
}

// QuestionCard captures a structured question prompt surfaced in a channel timeline.
type QuestionCard struct {
	QuestionID    string   `json:"questionId"`
	Prompt        string   `json:"prompt"`
	Options       []string `json:"options,omitempty"`
	AllowFreeText bool     `json:"allowFreeText,omitempty"`
}

// ReportSummary captures a concise final outcome summary without internal reasoning traces.
type ReportSummary struct {
	IssueID   string `json:"issueId,omitempty"`
	Outcome   string `json:"outcome"` // completed, failed, interrupted
	Summary   string `json:"summary"`
	Delivered string `json:"delivered,omitempty"`
}

// ReactionMeta binds a reaction event to a prior event sequence in the same channel.
type ReactionMeta struct {
	TargetSeq int64  `json:"targetSeq"`
	Emoji     string `json:"emoji"`
}

// Event is an immutable append-only social row committed to channel_event.
// Internal tool reasoning, tool results, and transcripts are never stored here;
// SessionID is stored strictly as an opaque cross-reference.
type Event struct {
	GlobalSeq     int64                     `json:"globalSeq"`
	ChannelID     string                    `json:"channelId"`
	Seq           int64                     `json:"seq"`
	Kind          contract.ChannelEventKind `json:"kind"`
	AuthorID      string                    `json:"authorId"`
	ActorKind     ActorKind                 `json:"actorKind"`
	ActorRole     ActorRole                 `json:"actorRole,omitempty"`
	Text          string                    `json:"text"`
	SessionID     string                    `json:"sessionId,omitempty"`
	IssueID       string                    `json:"issueId,omitempty"`
	Mentions      []string                  `json:"mentions,omitempty"`
	TargetAgentID string                    `json:"targetAgentId,omitempty"`
	SendKey       string                    `json:"sendKey,omitempty"`
	Question      *QuestionCard             `json:"question,omitempty"`
	Report        *ReportSummary            `json:"report,omitempty"`
	Reaction      *ReactionMeta             `json:"reaction,omitempty"`
	CreatedAtMs   int64                     `json:"createdAtMs"`
}

// View projects the social event onto the public cross-end contract.ChannelEventView.
func (e Event) View() contract.ChannelEventView {
	return contract.ChannelEventView{
		ChannelID:   e.ChannelID,
		Seq:         e.Seq,
		Kind:        e.Kind,
		AuthorID:    e.AuthorID,
		Text:        e.Text,
		SessionID:   e.SessionID,
		CreatedAtMs: e.CreatedAtMs,
	}
}

// ReadCursor tracks how far an actor has read inside a channel.
type ReadCursor struct {
	ChannelID   string `json:"channelId"`
	ActorID     string `json:"actorId"`
	ReadSeq     int64  `json:"readSeq"`
	UpdatedAtMs int64  `json:"updatedAtMs"`
}

// AppendRequest appends an immutable social event to a channel.
type AppendRequest struct {
	ChannelID     string
	Kind          contract.ChannelEventKind
	AuthorID      string
	ActorKind     ActorKind
	ActorRole     ActorRole
	Text          string
	SessionID     string
	IssueID       string
	Mentions      []string
	TargetAgentID string
	SendKey       string
	Question      *QuestionCard
	Report        *ReportSummary
	Reaction      *ReactionMeta
}

// AppendResult returns the committed event and whether sendKey deduplicated it.
type AppendResult struct {
	Event        Event
	Deduplicated bool
}

// Option configures a channel Store.
type Option func(*storeConfig)

type storeConfig struct {
	clock Clock
}

// WithClock overrides the clock used for event and cursor timestamps.
func WithClock(clock Clock) Option {
	return func(c *storeConfig) {
		if clock != nil {
			c.clock = clock
		}
	}
}

// ValidEventKind reports whether kind is one of the four public social ChannelEventKinds.
func ValidEventKind(kind contract.ChannelEventKind) bool {
	switch kind {
	case contract.ChannelEventMessage,
		contract.ChannelEventQuestion,
		contract.ChannelEventReport,
		contract.ChannelEventReaction:
		return true
	default:
		return false
	}
}

func validateAppendRequest(req AppendRequest) error {
	if strings.TrimSpace(req.ChannelID) == "" {
		return fmtInvalid("channelId is required")
	}
	if strings.TrimSpace(req.AuthorID) == "" {
		return fmtInvalid("authorId is required")
	}
	if !ValidEventKind(req.Kind) {
		return ErrInvalidEventKind
	}
	switch req.ActorKind {
	case "":
		// Defaults to user when omitted if needed; require valid value if supplied.
	case ActorUser, ActorAgent, ActorSystem:
	default:
		return fmtInvalid("invalid actorKind %q", req.ActorKind)
	}
	switch req.Kind {
	case contract.ChannelEventQuestion:
		if req.Question == nil && strings.TrimSpace(req.Text) == "" {
			return fmtInvalid("question card or text is required")
		}
	case contract.ChannelEventReport:
		if req.Report == nil && strings.TrimSpace(req.Text) == "" {
			return fmtInvalid("report summary or text is required")
		}
	case contract.ChannelEventReaction:
		if req.Reaction == nil || req.Reaction.TargetSeq <= 0 || strings.TrimSpace(req.Reaction.Emoji) == "" {
			return fmtInvalid("reaction requires targetSeq > 0 and non-empty emoji")
		}
	}
	return nil
}

func fmtInvalid(msg string, args ...any) error {
	if len(args) == 0 {
		return fmt.Errorf("%w: %s", ErrInvalidArgument, msg)
	}
	return fmt.Errorf("%w: "+msg, append([]any{ErrInvalidArgument}, args...)...)
}

func cloneChannel(c Channel) Channel {
	return c
}

func cloneEvent(e Event) Event {
	e.Mentions = slices.Clone(e.Mentions)
	if e.Question != nil {
		q := *e.Question
		q.Options = slices.Clone(q.Options)
		e.Question = &q
	}
	if e.Report != nil {
		r := *e.Report
		e.Report = &r
	}
	if e.Reaction != nil {
		rc := *e.Reaction
		e.Reaction = &rc
	}
	return e
}

func normalizeMentions(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, m := range in {
		m = strings.TrimSpace(strings.TrimPrefix(m, "@"))
		if m == "" || seen[m] {
			continue
		}
		seen[m] = true
		out = append(out, m)
	}
	return out
}

// Backend abstracts memory and SQL persistence for channel state.
type backend interface {
	createChannel(ctx context.Context, ch Channel) error
	ensureChannel(ctx context.Context, ch Channel) (Channel, bool, error)
	getChannel(ctx context.Context, id string) (Channel, bool, error)
	getThreadByIssue(ctx context.Context, issueID string) (Channel, bool, error)
	listChannels(ctx context.Context) ([]Channel, error)
	addMember(ctx context.Context, channelID, memberID string, nowMs int64) error
	removeMember(ctx context.Context, channelID, memberID string) error
	listMembers(ctx context.Context, channelID string) ([]string, error)
	appendEvent(ctx context.Context, req AppendRequest, nowMs int64) (AppendResult, error)
	getEvent(ctx context.Context, channelID string, seq int64) (Event, bool, error)
	listEvents(ctx context.Context, channelID string, afterSeq int64, limit int) ([]Event, error)
	eventsAfterGlobal(ctx context.Context, afterGlobalSeq int64, limit int) ([]Event, error)
	advanceReadCursor(ctx context.Context, channelID, actorID string, seq, nowMs int64) (ReadCursor, error)
	getReadCursor(ctx context.Context, channelID, actorID string) (ReadCursor, bool, error)
	listReadCursors(ctx context.Context, channelID string) ([]ReadCursor, error)
	unreadCount(ctx context.Context, channelID, actorID string) (int64, error)
	close() error
}

// EventObserver receives committed channel events strictly after persistence succeeds.
type EventObserver func(Event)

var _ context.Context = (context.Context)(nil)
