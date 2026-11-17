package issue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/durable"
	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

var (
	ErrNotFound            = errors.New("issue: record not found")
	ErrInvalidArgument     = errors.New("issue: invalid argument")
	ErrDuplicate           = errors.New("issue: duplicate record")
	ErrInvalidTransition   = errors.New("issue: invalid status transition")
	ErrInvalidCronSchedule = errors.New("issue: invalid cron schedule")
	ErrStoreClosed         = errors.New("issue: store is closed")
)

const (
	TaskKindIssueWatch   = "issue.watch"
	PhaseAwaitSettlement = "await_settlement"

	defaultMaxIterations = 3
)

// Clock provides wall or virtual time for issue updates and cron schedule evaluation.
type Clock interface {
	Now() time.Time
	NowMs() int64
}

// RealClock delegates to the system clock.
type RealClock struct{}

func (RealClock) Now() time.Time { return time.Now() }
func (RealClock) NowMs() int64   { return time.Now().UnixMilli() }

// PRCheckStatus tracks delivery verification after Rubric satisfaction.
type PRCheckStatus string

const (
	PRCheckNone    PRCheckStatus = "none"
	PRCheckPending PRCheckStatus = "pending"
	PRCheckPassed  PRCheckStatus = "passed"
	PRCheckFailed  PRCheckStatus = "failed"
)

// Issue is a serializable issue record operating purely via durable signals and data,
// holding zero reverse callback pointers into execution.
type Issue struct {
	ID                   string                   `json:"id"`
	Title                string                   `json:"title"`
	Description          string                   `json:"description,omitempty"`
	Prompt               string                   `json:"prompt,omitempty"`
	Status               contract.IssueStatus     `json:"status"`
	RepoID               string                   `json:"repoId"`
	AssigneeID           string                   `json:"assigneeId,omitempty"`
	SessionID            string                   `json:"sessionId,omitempty"`
	ConversationID       string                   `json:"conversationId,omitempty"`
	NotifyTaskID         string                   `json:"notifyTaskId,omitempty"`
	ChannelID            string                   `json:"channelId,omitempty"`
	Rubric               *contract.RubricSpec     `json:"rubric,omitempty"`
	Iteration            int                      `json:"iteration"`
	MaxIterationsReached bool                     `json:"maxIterationsReached,omitempty"`
	LastVerdict          *contract.RubricVerdict  `json:"lastVerdict,omitempty"`
	Verdicts             []contract.RubricVerdict `json:"verdicts,omitempty"`
	PRCheckStatus        PRCheckStatus            `json:"prCheckStatus,omitempty"`
	PRCheckSummary       string                   `json:"prCheckSummary,omitempty"`
	PRURL                string                   `json:"prUrl,omitempty"`
	LastSubmissionID     string                   `json:"lastSubmissionId,omitempty"`
	ProcessedSubmissions []string                 `json:"processedSubmissions,omitempty"`
	LastTriggerKey       string                   `json:"lastTriggerKey,omitempty"`
	FailureReason        string                   `json:"failureReason,omitempty"`
	CreatedAtMs          int64                    `json:"createdAtMs"`
	UpdatedAtMs          int64                    `json:"updatedAtMs"`
}

// View projects the issue onto the cross-end contract.IssueView.
func (i Issue) View() contract.IssueView {
	var rubricCopy *contract.RubricSpec
	if i.Rubric != nil {
		cp := *i.Rubric
		rubricCopy = &cp
	}
	return contract.IssueView{
		ID:          i.ID,
		Title:       i.Title,
		Status:      i.Status,
		RepoID:      i.RepoID,
		AssigneeID:  i.AssigneeID,
		SessionID:   i.SessionID,
		Rubric:      rubricCopy,
		UpdatedAtMs: i.UpdatedAtMs,
	}
}

// DispatchCommand is the immutable outbound request handed to a submission sink when queuing work.
type DispatchCommand struct {
	IssueID        string               `json:"issueId"`
	ConversationID string               `json:"conversationId"`
	RequestID      string               `json:"requestId"`
	Iteration      int                  `json:"iteration"`
	Prompt         string               `json:"prompt"`
	Feedback       string               `json:"feedback,omitempty"`
	UnmetItems     []string             `json:"unmetItems,omitempty"`
	Rubric         *contract.RubricSpec `json:"rubric,omitempty"`
	NotifyTaskID   string               `json:"notifyTaskId,omitempty"`
	RepoID         string               `json:"repoId"`
	AssigneeID     string               `json:"assigneeId,omitempty"`
	CreatedAtMs    int64                `json:"createdAtMs"`
}

// DispatchReceipt acknowledges an outbound issue dispatch.
type DispatchReceipt struct {
	SubmissionID   string `json:"submissionId"`
	ConversationID string `json:"conversationId"`
	SessionID      string `json:"sessionId,omitempty"`
	Deduplicated   bool   `json:"deduplicated"`
}

// DispatchSink submits issue execution work without holding reverse pointers into execution.
type DispatchSink interface {
	Dispatch(ctx context.Context, cmd DispatchCommand) (DispatchReceipt, error)
}

// DispatchSinkFunc adapts a function to DispatchSink.
type DispatchSinkFunc func(ctx context.Context, cmd DispatchCommand) (DispatchReceipt, error)

func (f DispatchSinkFunc) Dispatch(ctx context.Context, cmd DispatchCommand) (DispatchReceipt, error) {
	return f(ctx, cmd)
}

// DurableDispatchSink persists issue dispatches as idempotent durable_submissions
// anchored by RequestID ("issue:<id>:iter:<k>" or "cron:<id>:<dueMs>").
type DurableDispatchSink struct {
	Store        *store.Store
	OnDispatched func(ctx context.Context, cmd DispatchCommand, sub store.Submission) error
}

func (d *DurableDispatchSink) Dispatch(ctx context.Context, cmd DispatchCommand) (DispatchReceipt, error) {
	if d == nil || d.Store == nil {
		return DispatchReceipt{}, fmt.Errorf("%w: durable store required", ErrInvalidArgument)
	}
	convID := cmd.ConversationID
	if convID == "" {
		convID = "conv-issue-" + cmd.IssueID
	}
	if _, err := d.Store.GetConversation(ctx, convID); errors.Is(err, store.ErrNotFound) {
		if _, cErr := d.Store.CreateConversation(ctx, store.Conversation{
			ID:               convID,
			OwnerTaskID:      cmd.NotifyTaskID,
			ProviderAffinity: "default",
		}); cErr != nil && !errors.Is(cErr, store.ErrDuplicate) {
			return DispatchReceipt{}, cErr
		}
	}
	payload, err := json.Marshal(cmd)
	if err != nil {
		return DispatchReceipt{}, err
	}
	res, err := d.Store.Submit(ctx, store.Submission{
		ConversationID: convID,
		RequestID:      cmd.RequestID,
		Kind:           "issue_dispatch",
		PayloadJSON:    payload,
		NotifyTaskID:   cmd.NotifyTaskID,
	})
	if err != nil {
		return DispatchReceipt{}, err
	}
	if !res.Deduplicated && d.OnDispatched != nil {
		if err := d.OnDispatched(ctx, cmd, res.Submission); err != nil {
			return DispatchReceipt{}, err
		}
	}
	return DispatchReceipt{
		SubmissionID:   res.Submission.ID,
		ConversationID: convID,
		Deduplicated:   res.Deduplicated,
	}, nil
}

// PRCheckResult represents the outcome of PR/merge verification once Rubric is satisfied.
type PRCheckResult struct {
	Passed  bool   `json:"passed"`
	Pending bool   `json:"pending"`
	Summary string `json:"summary,omitempty"`
	PRURL   string `json:"prUrl,omitempty"`
}

// PRChecker verifies repository/PR readiness after outcome grading passes.
type PRChecker interface {
	CheckPR(ctx context.Context, iss Issue) (PRCheckResult, error)
}

// PRCheckerFunc adapts a function to PRChecker.
type PRCheckerFunc func(ctx context.Context, iss Issue) (PRCheckResult, error)

func (f PRCheckerFunc) CheckPR(ctx context.Context, iss Issue) (PRCheckResult, error) {
	return f(ctx, iss)
}

// Settlement represents an incoming execution settlement signal consumed by an Issue.
type Settlement struct {
	IssueID        string                  `json:"issueId,omitempty"`
	SubmissionID   string                  `json:"submissionId,omitempty"`
	ConversationID string                  `json:"conversationId,omitempty"`
	SessionID      string                  `json:"sessionId,omitempty"`
	Status         string                  `json:"status"` // done, unanswered, failed
	Output         string                  `json:"output,omitempty"`
	Deliverables   string                  `json:"deliverables,omitempty"`
	Verdict        *contract.RubricVerdict `json:"verdict,omitempty"`
	PRPassed       *bool                   `json:"prPassed,omitempty"`
	PRSummary      string                  `json:"prSummary,omitempty"`
	ErrorText      string                  `json:"errorText,omitempty"`
}

// SettlementAction classifies the state transition caused by consuming a Settlement.
type SettlementAction string

const (
	ActionNoop                SettlementAction = "noop"
	ActionRevisionDispatched  SettlementAction = "revision_dispatched"
	ActionMaxIterationsReview SettlementAction = "max_iterations_review"
	ActionPRCheckPending      SettlementAction = "pr_check_pending"
	ActionCompletedDone       SettlementAction = "completed_done"
	ActionFailedReview        SettlementAction = "failed_review"
)

// SettlementOutcome reports the resulting Issue state and optional revision dispatch.
type SettlementOutcome struct {
	Action   SettlementAction        `json:"action"`
	Issue    Issue                   `json:"issue"`
	Verdict  *contract.RubricVerdict `json:"verdict,omitempty"`
	Dispatch *DispatchReceipt        `json:"dispatch,omitempty"`
}

// CronKind identifies the five supported schedule kinds.
type CronKind string

const (
	CronOnce   CronKind = "once"
	CronEvery  CronKind = "every"
	CronDaily  CronKind = "daily"
	CronWeekly CronKind = "weekly"
	CronExpr   CronKind = "cron"
)

// CronSchedule defines a persistent recurring or one-shot issue trigger with a next-run cursor.
type CronSchedule struct {
	ID              string               `json:"id"`
	Name            string               `json:"name"`
	ChannelID       string               `json:"channelId,omitempty"`
	IssueID         string               `json:"issueId,omitempty"`
	RepoID          string               `json:"repoId"`
	AssigneeID      string               `json:"assigneeId,omitempty"`
	Title           string               `json:"title"`
	Prompt          string               `json:"prompt"`
	Rubric          *contract.RubricSpec `json:"rubric,omitempty"`
	Kind            CronKind             `json:"kind"`
	AtMs            int64                `json:"atMs,omitempty"`
	EveryMinutes    int                  `json:"everyMinutes,omitempty"`
	EveryMs         int64                `json:"everyMs,omitempty"`
	TimeOfDay       string               `json:"timeOfDay,omitempty"` // HH:MM
	Weekdays        []int                `json:"weekdays,omitempty"`  // 0=Sunday..6=Saturday
	Expr            string               `json:"expr,omitempty"`      // 5-field cron
	Timezone        string               `json:"timezone,omitempty"`  // IANA or fixed offset
	Enabled         bool                 `json:"enabled"`
	PendingApproval bool                 `json:"pendingApproval,omitempty"`
	LastRunAtMs     int64                `json:"lastRunAtMs,omitempty"`
	NextRunAtMs     int64                `json:"nextRunAtMs,omitempty"`
	LastTriggerKey  string               `json:"lastTriggerKey,omitempty"`
	CreatedAtMs     int64                `json:"createdAtMs"`
	UpdatedAtMs     int64                `json:"updatedAtMs"`
}

// CronFire records one executed cron cursor firing.
type CronFire struct {
	ScheduleID  string           `json:"scheduleId"`
	IssueID     string           `json:"issueId"`
	DueAtMs     int64            `json:"dueAtMs"`
	FiredAtMs   int64            `json:"firedAtMs"`
	NextRunAtMs int64            `json:"nextRunAtMs"`
	TriggerKey  string           `json:"triggerKey"`
	Dispatch    *DispatchReceipt `json:"dispatch,omitempty"`
}

// Option configures an issue Service.
type Option func(*serviceConfig)

type serviceConfig struct {
	clock     Clock
	sink      DispatchSink
	grader    *durable.OutcomeGrader
	prChecker PRChecker
}

// WithClock overrides the clock used for issue timestamps and cron scheduling.
func WithClock(clock Clock) Option {
	return func(c *serviceConfig) {
		if clock != nil {
			c.clock = clock
		}
	}
}

// WithDispatchSink configures the outbound submission sink for queued/revision dispatches.
func WithDispatchSink(sink DispatchSink) Option {
	return func(c *serviceConfig) {
		c.sink = sink
	}
}

// WithOutcomeGrader attaches a durable.OutcomeGrader invoked when a settlement carries no precomputed RubricVerdict.
func WithOutcomeGrader(g *durable.OutcomeGrader) Option {
	return func(c *serviceConfig) {
		c.grader = g
	}
}

// WithPRChecker configures PR/delivery verification before transitioning satisfied issues to done.
func WithPRChecker(p PRChecker) Option {
	return func(c *serviceConfig) {
		c.prChecker = p
	}
}

func cloneIssue(i Issue) Issue {
	if i.Rubric != nil {
		cp := *i.Rubric
		i.Rubric = &cp
	}
	if i.LastVerdict != nil {
		cp := *i.LastVerdict
		cp.UnmetItems = slices.Clone(cp.UnmetItems)
		i.LastVerdict = &cp
	}
	if len(i.Verdicts) > 0 {
		out := make([]contract.RubricVerdict, len(i.Verdicts))
		for idx, v := range i.Verdicts {
			v.UnmetItems = slices.Clone(v.UnmetItems)
			out[idx] = v
		}
		i.Verdicts = out
	}
	i.ProcessedSubmissions = slices.Clone(i.ProcessedSubmissions)
	return i
}

func cloneCron(c CronSchedule) CronSchedule {
	c.Weekdays = slices.Clone(c.Weekdays)
	if c.Rubric != nil {
		cp := *c.Rubric
		c.Rubric = &cp
	}
	return c
}

// ValidStatus reports whether s is a supported contract.IssueStatus.
func ValidStatus(s contract.IssueStatus) bool {
	switch s {
	case contract.IssueDraft,
		contract.IssueQueued,
		contract.IssueInProgress,
		contract.IssueReview,
		contract.IssueDone:
		return true
	default:
		return false
	}
}

// issueBackend abstracts in-memory and SQLite persistence for issues and cron schedules.
type issueBackend interface {
	createIssue(ctx context.Context, iss Issue) error
	upsertIssue(ctx context.Context, iss Issue) error
	getIssue(ctx context.Context, id string) (Issue, bool, error)
	findIssueByConversationOrSession(ctx context.Context, conversationID, sessionID string) (Issue, bool, error)
	listIssues(ctx context.Context, statuses ...contract.IssueStatus) ([]Issue, error)
	createCron(ctx context.Context, c CronSchedule) error
	updateCron(ctx context.Context, c CronSchedule) error
	getCron(ctx context.Context, id string) (CronSchedule, bool, error)
	listCrons(ctx context.Context) ([]CronSchedule, error)
	dueCrons(ctx context.Context, nowMs int64) ([]CronSchedule, error)
	close() error
}
