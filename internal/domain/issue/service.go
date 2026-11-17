package issue

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/vibevalleyhq/vibevalley/internal/durable"
	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

// Service manages issue lifecycles, pure signal settlement closures with RubricVerdict,
// and persistent cron schedules with next-run cursors.
type Service struct {
	backend issueBackend
	clock   Clock
	cfg     serviceConfig

	mu sync.Mutex

	closed    atomic.Bool
	closeOnce sync.Once
	closeErr  error
}

// NewMemoryService creates an in-memory issue & cron Service.
func NewMemoryService(opts ...Option) *Service {
	return newService(newMemoryIssueBackend(), opts...)
}

// OpenSQLiteService creates or reopens a SQLite WAL issue & cron Service at path.
func OpenSQLiteService(ctx context.Context, path string, opts ...Option) (*Service, error) {
	b, err := openSQLiteIssueBackend(ctx, path)
	if err != nil {
		return nil, err
	}
	return newService(b, opts...), nil
}

// OpenDBService attaches an issue & cron Service to an existing *sql.DB.
func OpenDBService(ctx context.Context, sqlDB *sql.DB, opts ...Option) (*Service, error) {
	b, err := openSQLiteIssueFromDB(ctx, sqlDB, true, false)
	if err != nil {
		return nil, err
	}
	return newService(b, opts...), nil
}

// OpenSQLiteServiceFromDB attaches an issue & cron Service to an already-migrated *sql.DB
// without running migrations or closing sqlDB on Close.
func OpenSQLiteServiceFromDB(ctx context.Context, sqlDB *sql.DB, opts ...Option) (*Service, error) {
	b, err := openSQLiteIssueFromDB(ctx, sqlDB, false, false)
	if err != nil {
		return nil, err
	}
	return newService(b, opts...), nil
}

func newService(b issueBackend, opts ...Option) *Service {
	cfg := serviceConfig{clock: RealClock{}}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}
	return &Service{
		backend: b,
		clock:   cfg.clock,
		cfg:     cfg,
	}
}

// Close closes the underlying storage backend.
func (s *Service) Close() error {
	s.closeOnce.Do(func() {
		s.closed.Store(true)
		s.closeErr = s.backend.close()
	})
	return s.closeErr
}

// CreateIssue persists a new issue (defaulting status to draft).
func (s *Service) CreateIssue(ctx context.Context, iss Issue) (Issue, error) {
	if s.closed.Load() {
		return Issue{}, ErrStoreClosed
	}
	if strings.TrimSpace(iss.Title) == "" {
		return Issue{}, fmt.Errorf("%w: title is required", ErrInvalidArgument)
	}
	now := s.clock.NowMs()
	if strings.TrimSpace(iss.ID) == "" {
		iss.ID = newUUIDv7(now)
	}
	if iss.Status == "" {
		iss.Status = contract.IssueDraft
	}
	if !ValidStatus(iss.Status) {
		return Issue{}, fmt.Errorf("%w: invalid issue status %q", ErrInvalidArgument, iss.Status)
	}
	if iss.PRCheckStatus == "" {
		iss.PRCheckStatus = PRCheckNone
	}
	if iss.CreatedAtMs == 0 {
		iss.CreatedAtMs = now
	}
	if iss.UpdatedAtMs == 0 {
		iss.UpdatedAtMs = iss.CreatedAtMs
	}
	if err := s.backend.createIssue(ctx, iss); err != nil {
		return Issue{}, err
	}
	return cloneIssue(iss), nil
}

// GetIssue retrieves an issue by ID.
func (s *Service) GetIssue(ctx context.Context, id string) (Issue, error) {
	if s.closed.Load() {
		return Issue{}, ErrStoreClosed
	}
	iss, ok, err := s.backend.getIssue(ctx, id)
	if err != nil {
		return Issue{}, err
	}
	if !ok {
		return Issue{}, fmt.Errorf("%w: issue %q", ErrNotFound, id)
	}
	return iss, nil
}

// UpdateIssue atomically loads an issue by ID, applies mutate, updates UpdatedAtMs, and persists it.
func (s *Service) UpdateIssue(ctx context.Context, id string, mutate func(*Issue) error) (Issue, error) {
	if s.closed.Load() {
		return Issue{}, ErrStoreClosed
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	iss, ok, err := s.backend.getIssue(ctx, id)
	if err != nil {
		return Issue{}, err
	}
	if !ok {
		return Issue{}, fmt.Errorf("%w: issue %q", ErrNotFound, id)
	}
	if mutate != nil {
		if err := mutate(&iss); err != nil {
			return Issue{}, err
		}
	}
	iss.UpdatedAtMs = s.clock.NowMs()
	if err := s.backend.upsertIssue(ctx, iss); err != nil {
		return Issue{}, err
	}
	return cloneIssue(iss), nil
}

// ListIssues returns issues matching statuses (or all issues if empty).
func (s *Service) ListIssues(ctx context.Context, statuses ...contract.IssueStatus) ([]Issue, error) {
	if s.closed.Load() {
		return nil, ErrStoreClosed
	}
	return s.backend.listIssues(ctx, statuses...)
}

// ListIssueViews returns cross-end contract.IssueView projections.
func (s *Service) ListIssueViews(ctx context.Context, statuses ...contract.IssueStatus) ([]contract.IssueView, error) {
	list, err := s.ListIssues(ctx, statuses...)
	if err != nil {
		return nil, err
	}
	out := make([]contract.IssueView, len(list))
	for i, iss := range list {
		out[i] = iss.View()
	}
	return out, nil
}

// QueueAndDispatch transitions an issue to queued, dispatches iteration 1 (or next)
// via the configured DispatchSink, and moves to in_progress upon receipt.
func (s *Service) QueueAndDispatch(ctx context.Context, issueID string) (Issue, *DispatchReceipt, error) {
	if s.closed.Load() {
		return Issue{}, nil, ErrStoreClosed
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.queueAndDispatchLocked(ctx, issueID, "", nil, "")
}

func (s *Service) queueAndDispatchLocked(ctx context.Context, issueID, feedback string, unmet []string, explicitReqID string) (Issue, *DispatchReceipt, error) {
	iss, ok, err := s.backend.getIssue(ctx, issueID)
	if err != nil {
		return Issue{}, nil, err
	}
	if !ok {
		return Issue{}, nil, fmt.Errorf("%w: issue %q", ErrNotFound, issueID)
	}
	if iss.Status == contract.IssueDone {
		return Issue{}, nil, fmt.Errorf("%w: cannot dispatch already done issue %q", ErrInvalidTransition, issueID)
	}

	now := s.clock.NowMs()
	if iss.Iteration <= 0 {
		iss.Iteration = 1
	}
	iss.Status = contract.IssueQueued
	iss.UpdatedAtMs = now
	if iss.ConversationID == "" {
		iss.ConversationID = "conv-issue-" + iss.ID
	}

	if s.cfg.sink == nil {
		if err := s.backend.upsertIssue(ctx, iss); err != nil {
			return Issue{}, nil, err
		}
		return cloneIssue(iss), nil, nil
	}

	reqID := explicitReqID
	if reqID == "" {
		reqID = fmt.Sprintf("issue:%s:iter:%d", iss.ID, iss.Iteration)
	}
	prompt := iss.Prompt
	if prompt == "" {
		prompt = iss.Description
	}
	if prompt == "" {
		prompt = iss.Title
	}
	cmd := DispatchCommand{
		IssueID:        iss.ID,
		ConversationID: iss.ConversationID,
		RequestID:      reqID,
		Iteration:      iss.Iteration,
		Prompt:         prompt,
		Feedback:       feedback,
		UnmetItems:     unmet,
		Rubric:         iss.Rubric,
		NotifyTaskID:   iss.NotifyTaskID,
		RepoID:         iss.RepoID,
		AssigneeID:     iss.AssigneeID,
		CreatedAtMs:    now,
	}
	receipt, err := s.cfg.sink.Dispatch(ctx, cmd)
	if err != nil {
		return Issue{}, nil, err
	}
	iss.Status = contract.IssueInProgress
	iss.LastSubmissionID = receipt.SubmissionID
	if receipt.ConversationID != "" {
		iss.ConversationID = receipt.ConversationID
	}
	if receipt.SessionID != "" {
		iss.SessionID = receipt.SessionID
	}
	iss.UpdatedAtMs = now
	if err := s.backend.upsertIssue(ctx, iss); err != nil {
		return Issue{}, nil, err
	}
	return cloneIssue(iss), &receipt, nil
}

// HandleSettlementSignal decodes a durable.Signal (such as store.SignalSubmissionSettled)
// and processes the closed-loop issue state transition.
func (s *Service) HandleSettlementSignal(ctx context.Context, sig store.Signal) (SettlementOutcome, error) {
	if s.closed.Load() {
		return SettlementOutcome{}, ErrStoreClosed
	}

	var env struct {
		SubmissionID   string          `json:"submissionId"`
		ConversationID string          `json:"conversationId"`
		RequestID      string          `json:"requestId"`
		Status         string          `json:"status"`
		Result         json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(sig.PayloadJSON, &env); err != nil {
		return SettlementOutcome{}, fmt.Errorf("%w: invalid settlement signal payload: %v", ErrInvalidArgument, err)
	}

	settle := Settlement{
		SubmissionID:   env.SubmissionID,
		ConversationID: env.ConversationID,
		Status:         env.Status,
	}
	if strings.HasPrefix(env.RequestID, "issue:") {
		parts := strings.Split(env.RequestID, ":")
		if len(parts) >= 2 && parts[1] != "" {
			settle.IssueID = parts[1]
		}
	}

	if len(env.Result) > 0 && string(env.Result) != "{}" {
		var resultPayload struct {
			IssueID       string                  `json:"issueId"`
			SessionID     string                  `json:"sessionId"`
			Output        string                  `json:"output"`
			Deliverables  string                  `json:"deliverables"`
			Verdict       *contract.RubricVerdict `json:"verdict"`
			RubricVerdict *contract.RubricVerdict `json:"rubricVerdict"`
			PRPassed      *bool                   `json:"prPassed"`
			PRSummary     string                  `json:"prSummary"`
			ErrorText     string                  `json:"errorText"`
		}
		if err := json.Unmarshal(env.Result, &resultPayload); err != nil {
			return SettlementOutcome{}, fmt.Errorf("%w: invalid settlement result json: %v", ErrInvalidArgument, err)
		}
		if resultPayload.IssueID != "" {
			settle.IssueID = resultPayload.IssueID
		}
		if resultPayload.SessionID != "" {
			settle.SessionID = resultPayload.SessionID
		}
		settle.Output = resultPayload.Output
		settle.Deliverables = resultPayload.Deliverables
		if resultPayload.RubricVerdict != nil {
			settle.Verdict = resultPayload.RubricVerdict
		} else if resultPayload.Verdict != nil {
			settle.Verdict = resultPayload.Verdict
		}
		settle.PRPassed = resultPayload.PRPassed
		settle.PRSummary = resultPayload.PRSummary
		settle.ErrorText = resultPayload.ErrorText
	}

	return s.HandleSettlement(ctx, settle)
}

// HandleSettlement consumes an execution settlement + RubricVerdict via pure signal closure:
// - When RubricVerdict is unmet and iteration < MaxIterations, re-queues & dispatches revision;
// - When MaxIterations is reached while unmet, parks in review;
// - When Satisfied (or no rubric), runs PR check / advances to done.
func (s *Service) HandleSettlement(ctx context.Context, settle Settlement) (SettlementOutcome, error) {
	if s.closed.Load() {
		return SettlementOutcome{}, ErrStoreClosed
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	var iss Issue
	var ok bool
	var err error
	if settle.IssueID != "" {
		iss, ok, err = s.backend.getIssue(ctx, settle.IssueID)
	} else {
		iss, ok, err = s.backend.findIssueByConversationOrSession(ctx, settle.ConversationID, settle.SessionID)
	}
	if err != nil {
		return SettlementOutcome{}, err
	}
	if !ok {
		return SettlementOutcome{}, fmt.Errorf("%w: issue for settlement (%q,%q,%q)", ErrNotFound, settle.IssueID, settle.ConversationID, settle.SessionID)
	}

	if iss.Status == contract.IssueDone {
		return SettlementOutcome{Action: ActionNoop, Issue: cloneIssue(iss)}, nil
	}
	if settle.SubmissionID != "" && containsString(iss.ProcessedSubmissions, settle.SubmissionID) {
		return SettlementOutcome{Action: ActionNoop, Issue: cloneIssue(iss), Verdict: iss.LastVerdict}, nil
	}

	now := s.clock.NowMs()
	if settle.SessionID != "" {
		iss.SessionID = settle.SessionID
	}
	if settle.SubmissionID != "" {
		iss.LastSubmissionID = settle.SubmissionID
		iss.ProcessedSubmissions = append(iss.ProcessedSubmissions, settle.SubmissionID)
	}
	if iss.Iteration <= 0 {
		iss.Iteration = 1
	}

	if settle.Status == "failed" || settle.Status == store.SubmissionUnanswered {
		iss.Status = contract.IssueReview
		iss.FailureReason = settle.ErrorText
		if iss.FailureReason == "" {
			iss.FailureReason = "execution " + settle.Status
		}
		iss.UpdatedAtMs = now
		if err := s.backend.upsertIssue(ctx, iss); err != nil {
			return SettlementOutcome{}, err
		}
		return SettlementOutcome{Action: ActionFailedReview, Issue: cloneIssue(iss)}, nil
	}

	verdict := settle.Verdict
	if verdict == nil && iss.Rubric != nil && iss.Rubric.Markdown != "" && s.cfg.grader != nil {
		prompt := iss.Prompt
		if prompt == "" {
			prompt = iss.Description
		}
		if prompt == "" {
			prompt = iss.Title
		}
		convID := iss.ConversationID
		if convID == "" {
			convID = settle.ConversationID
		}
		yieldRes, err := s.cfg.grader.OnYield(ctx, durable.YieldCheckRequest{
			ConversationID:  convID,
			TaskID:          iss.NotifyTaskID,
			Rubric:          *iss.Rubric,
			TaskPrompt:      prompt,
			Deliverables:    settle.Deliverables,
			CandidateOutput: settle.Output,
			Iteration:       iss.Iteration,
		})
		if err != nil {
			return SettlementOutcome{}, err
		}
		v := yieldRes.Verdict
		verdict = &v
	}

	if verdict != nil {
		vCopy := *verdict
		vCopy.UnmetItems = slicesCopy(vCopy.UnmetItems)
		if vCopy.Iteration <= 0 {
			vCopy.Iteration = iss.Iteration
		}
		iss.LastVerdict = &vCopy
		iss.Verdicts = append(iss.Verdicts, vCopy)

		maxIter := defaultMaxIterations
		if iss.Rubric != nil && iss.Rubric.MaxIterations > 0 {
			maxIter = iss.Rubric.MaxIterations
		}

		if !vCopy.Satisfied {
			if iss.Iteration < maxIter {
				iss.Iteration++
				iss.Status = contract.IssueQueued
				iss.UpdatedAtMs = now
				if err := s.backend.upsertIssue(ctx, iss); err != nil {
					return SettlementOutcome{}, err
				}
				feedback := fmt.Sprintf("Revision %d/%d required: %s (unmet: %v)", iss.Iteration, maxIter, vCopy.Summary, vCopy.UnmetItems)
				updated, receipt, err := s.queueAndDispatchLocked(ctx, iss.ID, feedback, vCopy.UnmetItems, "")
				if err != nil {
					return SettlementOutcome{}, err
				}
				return SettlementOutcome{
					Action:   ActionRevisionDispatched,
					Issue:    updated,
					Verdict:  &vCopy,
					Dispatch: receipt,
				}, nil
			}

			iss.MaxIterationsReached = true
			iss.Status = contract.IssueReview
			iss.UpdatedAtMs = now
			if err := s.backend.upsertIssue(ctx, iss); err != nil {
				return SettlementOutcome{}, err
			}
			return SettlementOutcome{
				Action:  ActionMaxIterationsReview,
				Issue:   cloneIssue(iss),
				Verdict: &vCopy,
			}, nil
		}
	}

	// Satisfied (or no rubric): advance through PR check to done.
	iss.Status = contract.IssueReview
	iss.UpdatedAtMs = now

	if settle.PRPassed != nil {
		if *settle.PRPassed {
			iss.PRCheckStatus = PRCheckPassed
			iss.PRCheckSummary = settle.PRSummary
			iss.Status = contract.IssueDone
			if err := s.backend.upsertIssue(ctx, iss); err != nil {
				return SettlementOutcome{}, err
			}
			return SettlementOutcome{Action: ActionCompletedDone, Issue: cloneIssue(iss), Verdict: iss.LastVerdict}, nil
		}
		iss.PRCheckStatus = PRCheckFailed
		iss.PRCheckSummary = settle.PRSummary
		if err := s.backend.upsertIssue(ctx, iss); err != nil {
			return SettlementOutcome{}, err
		}
		return SettlementOutcome{Action: ActionPRCheckPending, Issue: cloneIssue(iss), Verdict: iss.LastVerdict}, nil
	}

	if s.cfg.prChecker != nil {
		prRes, err := s.cfg.prChecker.CheckPR(ctx, iss)
		if err != nil {
			iss.PRCheckStatus = PRCheckFailed
			iss.FailureReason = err.Error()
			if uErr := s.backend.upsertIssue(ctx, iss); uErr != nil {
				return SettlementOutcome{}, uErr
			}
			return SettlementOutcome{Action: ActionFailedReview, Issue: cloneIssue(iss), Verdict: iss.LastVerdict}, nil
		}
		iss.PRCheckSummary = prRes.Summary
		iss.PRURL = prRes.PRURL
		if prRes.Passed {
			iss.PRCheckStatus = PRCheckPassed
			iss.Status = contract.IssueDone
			if err := s.backend.upsertIssue(ctx, iss); err != nil {
				return SettlementOutcome{}, err
			}
			return SettlementOutcome{Action: ActionCompletedDone, Issue: cloneIssue(iss), Verdict: iss.LastVerdict}, nil
		}
		if prRes.Pending {
			iss.PRCheckStatus = PRCheckPending
		} else {
			iss.PRCheckStatus = PRCheckFailed
		}
		if err := s.backend.upsertIssue(ctx, iss); err != nil {
			return SettlementOutcome{}, err
		}
		return SettlementOutcome{Action: ActionPRCheckPending, Issue: cloneIssue(iss), Verdict: iss.LastVerdict}, nil
	}

	iss.PRCheckStatus = PRCheckNone
	iss.Status = contract.IssueDone
	if err := s.backend.upsertIssue(ctx, iss); err != nil {
		return SettlementOutcome{}, err
	}
	return SettlementOutcome{Action: ActionCompletedDone, Issue: cloneIssue(iss), Verdict: iss.LastVerdict}, nil
}

// HandlePRCheckResult advances a review-stage issue to done once an external PR/CI check passes.
func (s *Service) HandlePRCheckResult(ctx context.Context, issueID string, passed bool, summary, prURL string) (Issue, error) {
	if s.closed.Load() {
		return Issue{}, ErrStoreClosed
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	iss, ok, err := s.backend.getIssue(ctx, issueID)
	if err != nil {
		return Issue{}, err
	}
	if !ok {
		return Issue{}, fmt.Errorf("%w: issue %q", ErrNotFound, issueID)
	}
	iss.PRCheckSummary = summary
	if prURL != "" {
		iss.PRURL = prURL
	}
	if passed {
		iss.PRCheckStatus = PRCheckPassed
		iss.Status = contract.IssueDone
	} else {
		iss.PRCheckStatus = PRCheckFailed
		iss.Status = contract.IssueReview
	}
	iss.UpdatedAtMs = s.clock.NowMs()
	if err := s.backend.upsertIssue(ctx, iss); err != nil {
		return Issue{}, err
	}
	return cloneIssue(iss), nil
}

// IssueWatchCheckpoint holds serializable state for the pure signal-driven durable task phase.
type IssueWatchCheckpoint struct {
	IssueID string `json:"issueId"`
}

// RegisterIssueWatchPhase registers a durable.Scheduler phase that awaits store.SignalSubmissionSettled
// with zero active goroutines while sleeping and drives Service.HandleSettlementSignal by pure signal closure.
func RegisterIssueWatchPhase(sched *durable.Scheduler, svc *Service) {
	sched.RegisterPhase(TaskKindIssueWatch, PhaseAwaitSettlement, func(ctx context.Context, tc *durable.TaskContext) (durable.Transition, error) {
		var cp IssueWatchCheckpoint
		if err := tc.UnmarshalCheckpoint(&cp); err != nil {
			return durable.Transition{}, err
		}
		sig := tc.Signal()
		if sig == nil {
			// Initial entry: bind NotifyTaskID and park sleeping until durable settles the submission.
			if cp.IssueID != "" {
				svc.mu.Lock()
				if iss, ok, err := svc.backend.getIssue(ctx, cp.IssueID); err == nil && ok && iss.NotifyTaskID == "" {
					iss.NotifyTaskID = tc.Task().ID
					_ = svc.backend.upsertIssue(ctx, iss)
				}
				svc.mu.Unlock()
			}
			return durable.TransSleep(PhaseAwaitSettlement, cp, durable.SleepOptions{
				SignalName: store.SignalSubmissionSettled,
			}), nil
		}

		outcome, err := svc.HandleSettlementSignal(ctx, *sig)
		if err != nil {
			return durable.Transition{}, err
		}
		if outcome.Action == ActionRevisionDispatched || outcome.Action == ActionPRCheckPending {
			return durable.TransSleep(PhaseAwaitSettlement, cp, durable.SleepOptions{
				SignalName: store.SignalSubmissionSettled,
			}), nil
		}
		return durable.TransComplete(outcome), nil
	})
}

// CreateCron validates, computes the initial next-run cursor, and persists a cron schedule.
func (s *Service) CreateCron(ctx context.Context, sched CronSchedule) (CronSchedule, error) {
	if s.closed.Load() {
		return CronSchedule{}, ErrStoreClosed
	}
	now := s.clock.NowMs()
	if strings.TrimSpace(sched.ID) == "" {
		sched.ID = newUUIDv7(now)
	}
	if sched.Timezone == "" {
		sched.Timezone = "UTC"
	}
	if sched.CreatedAtMs == 0 {
		sched.CreatedAtMs = now
	}
	if sched.UpdatedAtMs == 0 {
		sched.UpdatedAtMs = sched.CreatedAtMs
	}
	if err := ValidateCron(sched, now); err != nil {
		return CronSchedule{}, err
	}
	next, err := ComputeNextRun(sched, now)
	if err != nil {
		return CronSchedule{}, err
	}
	sched.NextRunAtMs = next
	if err := s.backend.createCron(ctx, sched); err != nil {
		return CronSchedule{}, err
	}
	return cloneCron(sched), nil
}

// GetCron retrieves a cron schedule by ID.
func (s *Service) GetCron(ctx context.Context, id string) (CronSchedule, error) {
	if s.closed.Load() {
		return CronSchedule{}, ErrStoreClosed
	}
	c, ok, err := s.backend.getCron(ctx, id)
	if err != nil {
		return CronSchedule{}, err
	}
	if !ok {
		return CronSchedule{}, fmt.Errorf("%w: cron %q", ErrNotFound, id)
	}
	return c, nil
}

// ListCrons lists all persisted cron schedules.
func (s *Service) ListCrons(ctx context.Context) ([]CronSchedule, error) {
	if s.closed.Load() {
		return nil, ErrStoreClosed
	}
	return s.backend.listCrons(ctx)
}

// SetCronEnabled enables/approves or disables a schedule, advancing its next-run cursor from now
// when re-enabled so missed intervals during disabled periods do not fire retroactively.
func (s *Service) SetCronEnabled(ctx context.Context, id string, enabled bool) (CronSchedule, error) {
	if s.closed.Load() {
		return CronSchedule{}, ErrStoreClosed
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok, err := s.backend.getCron(ctx, id)
	if err != nil {
		return CronSchedule{}, err
	}
	if !ok {
		return CronSchedule{}, fmt.Errorf("%w: cron %q", ErrNotFound, id)
	}
	now := s.clock.NowMs()
	c.Enabled = enabled
	if enabled {
		c.PendingApproval = false
		c.LastRunAtMs = now
		next, err := ComputeNextRun(c, now)
		if err != nil {
			return CronSchedule{}, err
		}
		c.NextRunAtMs = next
	} else {
		c.NextRunAtMs = 0
	}
	c.UpdatedAtMs = now
	if err := s.backend.updateCron(ctx, c); err != nil {
		return CronSchedule{}, err
	}
	return cloneCron(c), nil
}

// Tick evaluates all due cron schedules at s.clock.NowMs().
func (s *Service) Tick(ctx context.Context) ([]CronFire, error) {
	return s.TickDue(ctx, s.clock.NowMs())
}

// TickDue fires every enabled cron schedule whose NextRunAtMs <= nowMs, creates or re-queues
// its bound issue, dispatches via DispatchSink with idempotent key "cron:<id>:<dueAtMs>",
// and advances LastRunAtMs + NextRunAtMs persistently.
func (s *Service) TickDue(ctx context.Context, nowMs int64) ([]CronFire, error) {
	if s.closed.Load() {
		return nil, ErrStoreClosed
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	due, err := s.backend.dueCrons(ctx, nowMs)
	if err != nil {
		return nil, err
	}
	var fired []CronFire
	for _, c := range due {
		dueAtMs := c.NextRunAtMs
		triggerKey := fmt.Sprintf("cron:%s:%d", c.ID, dueAtMs)

		issueID := c.IssueID
		if issueID == "" {
			issueID = "cron-issue-" + c.ID
		}
		iss, ok, err := s.backend.getIssue(ctx, issueID)
		if err != nil {
			return fired, err
		}
		if !ok {
			iss = Issue{
				ID:            issueID,
				Title:         c.Title,
				Prompt:        c.Prompt,
				Status:        contract.IssueDraft,
				RepoID:        c.RepoID,
				AssigneeID:    c.AssigneeID,
				ChannelID:     c.ChannelID,
				Rubric:        c.Rubric,
				PRCheckStatus: PRCheckNone,
				CreatedAtMs:   nowMs,
				UpdatedAtMs:   nowMs,
			}
			if iss.Title == "" {
				iss.Title = c.Name
			}
			if err := s.backend.createIssue(ctx, iss); err != nil {
				return fired, err
			}
		} else if iss.Status == contract.IssueDone || iss.Status == contract.IssueReview {
			// Reset bound cron issue for the new scheduled run.
			iss.Status = contract.IssueDraft
			iss.Iteration = 1
			iss.MaxIterationsReached = false
			iss.UpdatedAtMs = nowMs
			if err := s.backend.upsertIssue(ctx, iss); err != nil {
				return fired, err
			}
		}

		iss.LastTriggerKey = triggerKey
		if err := s.backend.upsertIssue(ctx, iss); err != nil {
			return fired, err
		}

		var receiptPtr *DispatchReceipt
		if c.LastTriggerKey != triggerKey {
			_, receipt, err := s.queueAndDispatchLocked(ctx, iss.ID, "", nil, triggerKey)
			if err != nil {
				return fired, err
			}
			receiptPtr = receipt
		}

		c.IssueID = iss.ID
		c.LastRunAtMs = nowMs
		c.LastTriggerKey = triggerKey
		if c.Kind == CronOnce {
			c.Enabled = false
			c.NextRunAtMs = 0
		} else {
			next, err := ComputeNextRun(c, nowMs)
			if err != nil {
				return fired, err
			}
			c.NextRunAtMs = next
		}
		c.UpdatedAtMs = nowMs
		if err := s.backend.updateCron(ctx, c); err != nil {
			return fired, err
		}

		fired = append(fired, CronFire{
			ScheduleID:  c.ID,
			IssueID:     iss.ID,
			DueAtMs:     dueAtMs,
			FiredAtMs:   nowMs,
			NextRunAtMs: c.NextRunAtMs,
			TriggerKey:  triggerKey,
			Dispatch:    receiptPtr,
		})
	}
	return fired, nil
}

func containsString(list []string, target string) bool {
	for _, s := range list {
		if s == target {
			return true
		}
	}
	return false
}

func slicesCopy(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	out := make([]string, len(in))
	copy(out, in)
	return out
}

var fallbackIDSeq atomic.Uint64

func newUUIDv7(timestampMs int64) string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		n := fallbackIDSeq.Add(1)
		b[6] = byte(n >> 8)
		b[7] = byte(n)
	}
	ms := uint64(timestampMs)
	b[0] = byte(ms >> 40)
	b[1] = byte(ms >> 32)
	b[2] = byte(ms >> 24)
	b[3] = byte(ms >> 16)
	b[4] = byte(ms >> 8)
	b[5] = byte(ms)
	b[6] = (b[6] & 0x0f) | 0x70
	b[8] = (b[8] & 0x3f) | 0x80
	var dst [36]byte
	hex.Encode(dst[0:8], b[0:4])
	dst[8] = '-'
	hex.Encode(dst[9:13], b[4:6])
	dst[13] = '-'
	hex.Encode(dst[14:18], b[6:8])
	dst[18] = '-'
	hex.Encode(dst[19:23], b[8:10])
	dst[23] = '-'
	hex.Encode(dst[24:36], b[10:16])
	return string(dst[:])
}

var _ = errors.Is
