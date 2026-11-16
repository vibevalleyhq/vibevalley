package stack

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/domain/channel"
	"github.com/vibevalleyhq/vibevalley/internal/domain/issue"
	"github.com/vibevalleyhq/vibevalley/internal/domain/memory"
	domainwatch "github.com/vibevalleyhq/vibevalley/internal/domain/watch"
	"github.com/vibevalleyhq/vibevalley/internal/durable"
	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
	"github.com/vibevalleyhq/vibevalley/internal/vault"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

// SyncSpaceProjection refreshes issues, unresolved inbox items, dreams, and online machines in Game.
func (s *Stack) SyncSpaceProjection(ctx context.Context) error {
	if s.closed.Load() || s.Game == nil {
		return nil
	}
	if s.Issues != nil {
		views, err := s.Issues.ListIssueViews(ctx)
		if err != nil {
			return err
		}
		if _, err := s.Game.ProjectIssues(views); err != nil {
			return err
		}
	}
	if s.Watch != nil {
		inbox, err := s.Watch.ListInboxItems(ctx, false)
		if err != nil {
			return err
		}
		if _, err := s.Game.ProjectInbox(inbox); err != nil {
			return err
		}
	}
	if s.Memory != nil {
		dreams, err := s.Memory.ListDreamProposals(ctx, memory.DefaultScopeID)
		if err == nil && len(dreams) > 0 {
			if _, err := s.Game.ProjectDreams(dreams); err != nil {
				return err
			}
		}
	}
	if s.Machines != nil {
		if _, err := s.Game.ProjectOnlineMachines(s.Machines.OnlineIDs()); err != nil {
			return err
		}
	}
	return nil
}

// EnsureIssueWatchTask starts the signal-driven issue.watch durable task for issueID if needed
// and waits until NotifyTaskID is bound and sleeping on store.SignalSubmissionSettled.
func (s *Stack) EnsureIssueWatchTask(ctx context.Context, issueID string) (issue.Issue, error) {
	if s.closed.Load() {
		return issue.Issue{}, ErrClosed
	}
	iss, err := s.Issues.GetIssue(ctx, issueID)
	if err != nil {
		return issue.Issue{}, err
	}
	watchID := iss.NotifyTaskID
	if watchID == "" {
		watchID = "issue-watch-" + iss.ID
	}
	convID := iss.ConversationID
	if convID == "" {
		convID = "conv-issue-" + iss.ID
	}
	if _, err := s.Store.GetConversation(ctx, convID); errors.Is(err, store.ErrNotFound) {
		_, cErr := s.Store.CreateConversation(ctx, store.Conversation{
			ID:               convID,
			OwnerTaskID:      watchID,
			ProviderAffinity: "default",
		})
		if cErr != nil && !errors.Is(cErr, store.ErrDuplicate) {
			return issue.Issue{}, cErr
		}
	}
	if _, err := s.Store.GetTask(ctx, watchID); errors.Is(err, store.ErrNotFound) {
		cpBytes, _ := json.Marshal(issue.IssueWatchCheckpoint{IssueID: iss.ID})
		if _, sErr := s.Scheduler.StartTask(ctx, store.Task{
			ID:             watchID,
			ConversationID: convID,
			Kind:           issue.TaskKindIssueWatch,
			PhaseName:      issue.PhaseAwaitSettlement,
			CheckpointJSON: cpBytes,
		}); sErr != nil {
			return issue.Issue{}, sErr
		}
	}
	if err := s.waitForTaskSleepingOrDone(ctx, watchID); err != nil {
		return issue.Issue{}, err
	}
	return s.Issues.GetIssue(ctx, iss.ID)
}

// CreateAndDispatchIssue creates an issue, binds its durable watch task, queues it, and updates SpaceView.
func (s *Stack) CreateAndDispatchIssue(ctx context.Context, iss issue.Issue) (issue.Issue, *issue.DispatchReceipt, error) {
	if s.closed.Load() {
		return issue.Issue{}, nil, ErrClosed
	}
	if iss.ID == "" {
		iss.ID = fmt.Sprintf("iss-%d", s.clock.NowMs())
	}
	if iss.ConversationID == "" {
		iss.ConversationID = "conv-issue-" + iss.ID
	}
	if iss.NotifyTaskID == "" {
		iss.NotifyTaskID = "issue-watch-" + iss.ID
	}
	created, err := s.Issues.CreateIssue(ctx, iss)
	if err != nil {
		return issue.Issue{}, nil, err
	}
	return s.QueueAndDispatchIssue(ctx, created.ID)
}

// QueueAndDispatchIssue ensures the signal-driven watch task is armed, dispatches the issue, and projects into Game.
func (s *Stack) QueueAndDispatchIssue(ctx context.Context, issueID string) (issue.Issue, *issue.DispatchReceipt, error) {
	if s.closed.Load() {
		return issue.Issue{}, nil, ErrClosed
	}
	if _, err := s.EnsureIssueWatchTask(ctx, issueID); err != nil {
		return issue.Issue{}, nil, err
	}
	updated, receipt, err := s.Issues.QueueAndDispatch(ctx, issueID)
	if err != nil {
		return issue.Issue{}, nil, err
	}
	if s.Game != nil {
		_, _ = s.Game.UpsertIssue(updated.View())
	}
	return updated, receipt, nil
}

// TickCrons evaluates due cron triggers and updates SpaceView projections for any newly dispatched issues.
func (s *Stack) TickCrons(ctx context.Context) ([]issue.CronFire, error) {
	if s.closed.Load() {
		return nil, ErrClosed
	}
	fires, err := s.Issues.Tick(ctx)
	if err != nil {
		return nil, err
	}
	if len(fires) > 0 {
		_ = s.SyncSpaceProjection(ctx)
	}
	return fires, nil
}

// PostAndPumpChannel appends a channel event and immediately runs Watch attention routing and brake evaluation.
func (s *Stack) PostAndPumpChannel(ctx context.Context, req channel.AppendRequest) (channel.AppendResult, []domainwatch.EventOutcome, error) {
	if s.closed.Load() {
		return channel.AppendResult{}, nil, ErrClosed
	}
	res, err := s.Channels.Append(ctx, req)
	if err != nil {
		return channel.AppendResult{}, nil, err
	}
	outcomes, err := s.Watch.Pump(ctx)
	if err != nil {
		return res, nil, err
	}
	_ = s.SyncSpaceProjection(ctx)
	return res, outcomes, nil
}

// RunDreamCycle executes offline Phase 4 dreaming consolidation and projects the resulting proposal into SpaceView.
func (s *Stack) RunDreamCycle(ctx context.Context, scopeID string, summaries []memory.SessionSummary) (contract.DreamProposalView, error) {
	if s.closed.Load() {
		return contract.DreamProposalView{}, ErrClosed
	}
	if scopeID == "" {
		scopeID = memory.DefaultScopeID
	}
	cons := s.cfg.DreamConsolidator
	if cons == nil {
		cons = memory.DeterministicConsolidator{}
	}
	prop, err := s.Memory.RunDream(ctx, memory.DreamRequest{
		ScopeID:          scopeID,
		SessionSummaries: summaries,
		Consolidator:     cons,
	})
	if err != nil {
		return contract.DreamProposalView{}, err
	}
	if s.Game != nil {
		_, _ = s.Game.UpsertDream(prop)
	}
	return prop, nil
}

// ApproveDream atomically applies a pending Dream proposal and updates SpaceView.
func (s *Stack) ApproveDream(ctx context.Context, proposalID string) (contract.DreamProposalView, error) {
	if s.closed.Load() {
		return contract.DreamProposalView{}, ErrClosed
	}
	prop, err := s.Memory.ApproveDream(ctx, proposalID)
	if err != nil {
		return contract.DreamProposalView{}, err
	}
	if s.Game != nil {
		_, _ = s.Game.UpsertDream(prop)
	}
	return prop, nil
}

// RollbackDream atomically rolls back an applied Dream proposal and updates SpaceView.
func (s *Stack) RollbackDream(ctx context.Context, proposalID string) (contract.DreamProposalView, error) {
	if s.closed.Load() {
		return contract.DreamProposalView{}, ErrClosed
	}
	prop, err := s.Memory.RollbackDream(ctx, proposalID)
	if err != nil {
		return contract.DreamProposalView{}, err
	}
	if s.Game != nil {
		_, _ = s.Game.UpsertDream(prop)
	}
	return prop, nil
}

// IssueEgressToken mints a short-lived HMAC capability token scoped to session, secret IDs, and allowed hosts.
func (s *Stack) IssueEgressToken(ctx context.Context, principalID, sessionID string, allowedHosts, secretIDs []string, ttl time.Duration, capabilities ...string) (vault.IssuedToken, error) {
	if s.closed.Load() {
		return vault.IssuedToken{}, ErrClosed
	}
	if len(capabilities) == 0 {
		capabilities = []string{vault.CapProviderCall, vault.CapHTTPEgress}
	}
	return s.Tokens.Issue(ctx, vault.IssueTokenRequest{
		PrincipalID:  principalID,
		SessionID:    sessionID,
		Capabilities: capabilities,
		AllowedHosts: allowedHosts,
		SecretIDs:    secretIDs,
		TTL:          ttl,
	})
}

func (s *Stack) onIssueDispatched(ctx context.Context, cmd issue.DispatchCommand, sub store.Submission) error {
	if s.cfg.OnIssueDispatch != nil {
		return s.cfg.OnIssueDispatch(ctx, cmd, sub)
	}
	if s.cfg.DisableIssueAuto || s.closed.Load() {
		return nil
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.runIssueGeneration(cmd, sub)
	}()
	return nil
}

func (s *Stack) runIssueGeneration(cmd issue.DispatchCommand, sub store.Submission) {
	ctx := s.bgCtx
	if ctx.Err() != nil {
		return
	}

	cpBytes, _ := json.Marshal(durable.GenerationCheckpoint{
		ConversationID: cmd.ConversationID,
		TaskPrompt:     cmd.Prompt,
	})
	genTaskID := "gen-" + sub.ID
	if _, err := s.Scheduler.StartTask(ctx, store.Task{
		ID:             genTaskID,
		ConversationID: cmd.ConversationID,
		Kind:           durable.TaskKindGeneration,
		PhaseName:      durable.PhaseGenerate,
		IsModelTask:    true,
		CheckpointJSON: cpBytes,
	}); err != nil {
		if ctx.Err() == nil && !errors.Is(err, store.ErrStoreClosed) {
			s.settleIssueSubmission(cmd, sub, store.SubmissionUnanswered, "", "", err.Error())
		}
		return
	}

	finalTask, err := s.Scheduler.WaitTask(ctx, genTaskID)
	if err != nil {
		if ctx.Err() == nil && !errors.Is(err, store.ErrStoreClosed) {
			s.settleIssueSubmission(cmd, sub, store.SubmissionUnanswered, "", "", err.Error())
		}
		return
	}

	if finalTask.Status != store.TaskTerminal || finalTask.TerminalReason != store.ReasonCompleted {
		errText := finalTask.ErrorText
		if errText == "" {
			errText = finalTask.TerminalReason
		}
		if errText == "" {
			errText = string(finalTask.Status)
		}
		s.settleIssueSubmission(cmd, sub, store.SubmissionUnanswered, "", "", errText)
		return
	}

	var genRes durable.GenerationResult
	_ = json.Unmarshal(finalTask.ResultJSON, &genRes)
	delv, _ := s.Deliverables(ctx, cmd.ConversationID)
	s.settleIssueSubmission(cmd, sub, store.SubmissionDone, genRes.Output, delv, "")
}

func (s *Stack) settleIssueSubmission(cmd issue.DispatchCommand, sub store.Submission, subStatus, output, deliverables, errText string) {
	ctx := s.bgCtx
	if ctx.Err() != nil || s.closed.Load() {
		return
	}
	if cmd.NotifyTaskID != "" {
		_ = s.waitForTaskSleepingOrDone(ctx, cmd.NotifyTaskID)
	}
	payload, _ := json.Marshal(map[string]any{
		"issueId":        cmd.IssueID,
		"sessionId":      cmd.ConversationID,
		"conversationId": cmd.ConversationID,
		"output":         output,
		"deliverables":   deliverables,
		"errorText":      errText,
	})
	if _, err := s.Store.SettleSubmission(ctx, sub.ID, subStatus, payload); err != nil {
		return
	}
	_ = s.Scheduler.Recover(ctx)
	if cmd.NotifyTaskID != "" {
		_ = s.waitForTaskSleepingOrDone(ctx, cmd.NotifyTaskID)
	}
	_ = s.SyncSpaceProjection(ctx)
}

func (s *Stack) waitForTaskSleepingOrDone(ctx context.Context, taskID string) error {
	for {
		task, err := s.Store.GetTask(ctx, taskID)
		if err != nil {
			return err
		}
		if task.Status == store.TaskSleeping || task.Status == store.TaskTerminal {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Millisecond):
		}
	}
}
