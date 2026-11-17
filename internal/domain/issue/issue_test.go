package issue_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io/fs"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/domain/issue"
	"github.com/vibevalleyhq/vibevalley/internal/durable"
	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
	"github.com/vibevalleyhq/vibevalley/pkg/db"
	"github.com/vibevalleyhq/vibevalley/pkg/migrate"
	_ "modernc.org/sqlite"
)

type fixedClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFixedClock(start time.Time) *fixedClock {
	if start.IsZero() {
		start = time.Unix(1_700_000_000, 0).UTC()
	}
	return &fixedClock{now: start}
}

func (c *fixedClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fixedClock) NowMs() int64 { return c.Now().UnixMilli() }

func (c *fixedClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

func TestIssueOutcomeGraderRubricRevisionToSatisfiedClosedLoop(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	tmpDir := t.TempDir()
	durStore, err := store.OpenSQLite(ctx, filepath.Join(tmpDir, "durable.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer durStore.Close()

	sched := durable.NewScheduler(durStore)
	defer sched.Close()

	var graderCalls atomic.Int32
	grader := durable.NewOutcomeGrader(durStore, durable.GraderDriverFunc(func(_ context.Context, graderConvID string, input durable.GraderInput) (contract.RubricVerdict, error) {
		n := graderCalls.Add(1)
		if n == 1 {
			return contract.RubricVerdict{
				Satisfied:  false,
				Summary:    "unit test missing",
				UnmetItems: []string{"add negative case test"},
				Iteration:  input.Iteration,
			}, nil
		}
		return contract.RubricVerdict{
			Satisfied: true,
			Summary:   "all rubric criteria verified",
			Iteration: input.Iteration,
		}, nil
	}))

	var dispatchMu sync.Mutex
	var dispatched []issue.DispatchCommand
	subQueue := make(chan store.Submission, 4)

	sink := &issue.DurableDispatchSink{
		Store: durStore,
		OnDispatched: func(_ context.Context, cmd issue.DispatchCommand, sub store.Submission) error {
			dispatchMu.Lock()
			dispatched = append(dispatched, cmd)
			dispatchMu.Unlock()
			subQueue <- sub
			return nil
		},
	}

	var prChecks atomic.Int32
	prChecker := issue.PRCheckerFunc(func(_ context.Context, iss issue.Issue) (issue.PRCheckResult, error) {
		prChecks.Add(1)
		return issue.PRCheckResult{
			Passed:  true,
			Summary: "CI green",
			PRURL:   "https://github.com/vibevalleyhq/vibevalley/pull/99",
		}, nil
	})

	clk := newFixedClock(time.Unix(1_700_000_000, 0).UTC())
	svc, err := issue.OpenSQLiteService(ctx, filepath.Join(tmpDir, "issue.db"),
		issue.WithClock(clk),
		issue.WithDispatchSink(sink),
		issue.WithOutcomeGrader(grader),
		issue.WithPRChecker(prChecker),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close()

	issue.RegisterIssueWatchPhase(sched, svc)

	created, err := svc.CreateIssue(ctx, issue.Issue{
		ID:         "iss-loop",
		Title:      "Implement rubric loop",
		Prompt:     "Add feature + tests",
		RepoID:     "repo-1",
		AssigneeID: "agent-1",
		Rubric: &contract.RubricSpec{
			Markdown:      "- must include negative case test",
			MaxIterations: 3,
		},
	})
	if err != nil || created.Status != contract.IssueDraft {
		t.Fatalf("CreateIssue: %+v err=%v", created, err)
	}
	if created.View().Status != contract.IssueDraft {
		t.Fatalf("expected IssueView status draft, got %q", created.View().Status)
	}

	// Start pure signal-driven durable watcher task (0 goroutines held while sleeping).
	cpBytes, _ := json.Marshal(issue.IssueWatchCheckpoint{IssueID: created.ID})
	watchTaskRes, err := sched.StartTask(ctx, store.Task{
		ID:             "task-issue-loop",
		Kind:           issue.TaskKindIssueWatch,
		PhaseName:      issue.PhaseAwaitSettlement,
		CheckpointJSON: cpBytes,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Wait until watcher task settles into sleeping state.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		tk, err := durStore.GetTask(ctx, watchTaskRes.Task.ID)
		if err == nil && tk.Status == store.TaskSleeping {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	if sched.ActiveWorkers() != 0 {
		t.Fatalf("expected 0 active workers while sleeping, got %d", sched.ActiveWorkers())
	}

	// Queue & dispatch iteration 1!
	inProg, receipt1, err := svc.QueueAndDispatch(ctx, created.ID)
	if err != nil || inProg.Status != contract.IssueInProgress || receipt1 == nil {
		t.Fatalf("QueueAndDispatch: iss=%+v receipt=%+v err=%v", inProg, receipt1, err)
	}

	sub1 := <-subQueue
	// Settle iteration 1 without precomputed verdict -> OutcomeGrader runs in isolated context and rejects!
	res1Bytes, _ := json.Marshal(map[string]any{
		"issueId":      created.ID,
		"sessionId":    "sess-iter-1",
		"output":       "implemented feature",
		"deliverables": "feature.go",
	})
	if _, err := durStore.SettleSubmission(ctx, sub1.ID, store.SubmissionDone, res1Bytes); err != nil {
		t.Fatal(err)
	}
	// Wake scheduler via SignalSubmissionSettled by explicitly routing signal through scheduler if not already woken:
	// Note: SettleSubmission buffers durable_signal; SendSignal or Recover wakes sleeping task.
	// Let's verify SendSignal wakes sleeping task cleanly!
	sigs1, _ := durStore.ListSignals(ctx, watchTaskRes.Task.ID, false)
	if len(sigs1) == 0 {
		t.Fatalf("expected buffered submission_settled signal on %s", watchTaskRes.Task.ID)
	}
	// Re-send/wake via scheduler using Recover or explicit wake:
	if err := sched.Recover(ctx); err != nil {
		t.Fatal(err)
	}

	// Iteration 2 submission MUST arrive from pure signal closure!
	var sub2 store.Submission
	select {
	case sub2 = <-subQueue:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for revision iteration 2 dispatch")
	}

	dispatchMu.Lock()
	if len(dispatched) != 2 || dispatched[1].Iteration != 2 || len(dispatched[1].UnmetItems) != 1 {
		t.Fatalf("expected iteration 2 dispatch with unmet feedback, got %+v", dispatched)
	}
	dispatchMu.Unlock()

	// Wait until watcher returns to sleeping state before settling iteration 2.
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		tk, err := durStore.GetTask(ctx, watchTaskRes.Task.ID)
		if err == nil && tk.Status == store.TaskSleeping {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}

	// Settle iteration 2 -> OutcomeGrader returns Satisfied=true -> PR check passes -> IssueDone!
	res2Bytes, _ := json.Marshal(map[string]any{
		"issueId":      created.ID,
		"sessionId":    "sess-iter-2",
		"output":       "added negative test",
		"deliverables": "feature.go + feature_test.go",
	})
	if _, err := durStore.SettleSubmission(ctx, sub2.ID, store.SubmissionDone, res2Bytes); err != nil {
		t.Fatal(err)
	}
	if err := sched.Recover(ctx); err != nil {
		t.Fatal(err)
	}

	doneTask, err := sched.WaitTask(ctx, watchTaskRes.Task.ID)
	if err != nil || doneTask.TerminalReason != store.ReasonCompleted {
		t.Fatalf("WaitTask: task=%+v err=%v", doneTask, err)
	}

	finalIss, err := svc.GetIssue(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if finalIss.Status != contract.IssueDone || finalIss.PRCheckStatus != issue.PRCheckPassed {
		t.Fatalf("expected IssueDone + PRCheckPassed, got %+v", finalIss)
	}
	if finalIss.Iteration != 2 || len(finalIss.Verdicts) != 2 || !finalIss.LastVerdict.Satisfied {
		t.Fatalf("unexpected verdict history: %+v", finalIss)
	}
	if prChecks.Load() != 1 || graderCalls.Load() != 2 {
		t.Fatalf("expected 2 grader calls and 1 PR check, got grader=%d pr=%d", graderCalls.Load(), prChecks.Load())
	}
	view := finalIss.View()
	if view.Status != contract.IssueDone || view.SessionID != "sess-iter-2" {
		t.Fatalf("unexpected final IssueView: %+v", view)
	}
}

func TestIssueMaxIterationsStopsInReview(t *testing.T) {
	ctx := context.Background()
	clk := newFixedClock(time.Time{})
	var dispatches int
	svc := issue.NewMemoryService(
		issue.WithClock(clk),
		issue.WithDispatchSink(issue.DispatchSinkFunc(func(_ context.Context, cmd issue.DispatchCommand) (issue.DispatchReceipt, error) {
			dispatches++
			return issue.DispatchReceipt{
				SubmissionID:   "sub-" + cmd.RequestID,
				ConversationID: cmd.ConversationID,
				SessionID:      "sess-1",
			}, nil
		})),
	)
	defer svc.Close()

	iss, err := svc.CreateIssue(ctx, issue.Issue{
		ID:     "iss-cap",
		Title:  "Capped issue",
		RepoID: "repo-1",
		Rubric: &contract.RubricSpec{
			Markdown:      "- must pass",
			MaxIterations: 2,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.QueueAndDispatch(ctx, iss.ID); err != nil {
		t.Fatal(err)
	}

	// Iteration 1 unmet -> dispatches iteration 2.
	out1, err := svc.HandleSettlement(ctx, issue.Settlement{
		IssueID:      iss.ID,
		SubmissionID: "sub-issue:iss-cap:iter:1",
		Status:       store.SubmissionDone,
		Verdict:      &contract.RubricVerdict{Satisfied: false, Summary: "still missing"},
	})
	if err != nil || out1.Action != issue.ActionRevisionDispatched || out1.Issue.Iteration != 2 || dispatches != 2 {
		t.Fatalf("expected revision 2 dispatched, got %+v dispatches=%d err=%v", out1, dispatches, err)
	}

	// Iteration 2 unmet -> hits MaxIterations=2 -> parks in IssueReview!
	out2, err := svc.HandleSettlement(ctx, issue.Settlement{
		IssueID:      iss.ID,
		SubmissionID: "sub-issue:iss-cap:iter:2",
		Status:       store.SubmissionDone,
		Verdict:      &contract.RubricVerdict{Satisfied: false, Summary: "still missing on iter 2"},
	})
	if err != nil || out2.Action != issue.ActionMaxIterationsReview || out2.Issue.Status != contract.IssueReview || !out2.Issue.MaxIterationsReached {
		t.Fatalf("expected max iterations review, got %+v err=%v", out2, err)
	}
	if dispatches != 2 {
		t.Fatalf("must not dispatch past MaxIterations=2, got %d", dispatches)
	}
}

func TestCronScheduleCursorAdvanceAndPersistence(t *testing.T) {
	ctx := context.Background()
	start := time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC)
	clk := newFixedClock(start)
	dbPath := filepath.Join(t.TempDir(), "cron.db")

	var firedKeys []string
	sink := issue.DispatchSinkFunc(func(_ context.Context, cmd issue.DispatchCommand) (issue.DispatchReceipt, error) {
		firedKeys = append(firedKeys, cmd.RequestID)
		return issue.DispatchReceipt{
			SubmissionID:   "sub-" + cmd.RequestID,
			ConversationID: cmd.ConversationID,
		}, nil
	})

	svc, err := issue.OpenSQLiteService(ctx, dbPath, issue.WithClock(clk), issue.WithDispatchSink(sink))
	if err != nil {
		t.Fatal(err)
	}

	// Invalid Feb 30 schedule must be rejected immediately.
	if _, err := svc.CreateCron(ctx, issue.CronSchedule{
		ID:      "bad-feb30",
		Name:    "Impossible",
		Title:   "Never",
		RepoID:  "repo-1",
		Kind:    issue.CronExpr,
		Expr:    "0 9 30 2 *",
		Enabled: true,
	}); !errors.Is(err, issue.ErrInvalidCronSchedule) {
		t.Fatalf("expected ErrInvalidCronSchedule for Feb 30, got %v", err)
	}

	// 1) Repeating every-5-minute cron schedule.
	everyCron, err := svc.CreateCron(ctx, issue.CronSchedule{
		ID:           "cron-every",
		Name:         "Check CI",
		Title:        "CI Digest",
		Prompt:       "Check CI health",
		RepoID:       "repo-1",
		Kind:         issue.CronEvery,
		EveryMinutes: 5,
		Timezone:     "UTC",
		Enabled:      true,
	})
	if err != nil {
		t.Fatal(err)
	}
	wantFirst := start.Add(5 * time.Minute).UnixMilli()
	if everyCron.NextRunAtMs != wantFirst {
		t.Fatalf("expected initial NextRunAtMs=%d, got %d", wantFirst, everyCron.NextRunAtMs)
	}

	// 2) One-shot cron schedule at +3 minutes.
	onceCron, err := svc.CreateCron(ctx, issue.CronSchedule{
		ID:       "cron-once",
		Name:     "One-off",
		Title:    "One-off check",
		Prompt:   "Run once",
		RepoID:   "repo-1",
		Kind:     issue.CronOnce,
		AtMs:     start.Add(3 * time.Minute).UnixMilli(),
		Timezone: "UTC",
		Enabled:  true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if onceCron.NextRunAtMs != start.Add(3*time.Minute).UnixMilli() {
		t.Fatalf("unexpected once NextRunAtMs: %+v", onceCron)
	}

	// 3) 5-field cron expression: every hour at :30 in Asia/Shanghai (+08:00).
	exprCron, err := svc.CreateCron(ctx, issue.CronSchedule{
		ID:       "cron-expr",
		Name:     "Hourly report",
		Title:    "Hourly",
		Prompt:   "Summarize hourly status",
		RepoID:   "repo-1",
		Kind:     issue.CronExpr,
		Expr:     "30 * * * *",
		Timezone: "Asia/Shanghai",
		Enabled:  true,
	})
	if err != nil {
		t.Fatal(err)
	}
	wantHourly := start.Add(30 * time.Minute).UnixMilli()
	if exprCron.NextRunAtMs != wantHourly {
		t.Fatalf("expected hourly NextRunAtMs=%d, got %d", wantHourly, exprCron.NextRunAtMs)
	}

	// Before +3m -> 0 due.
	clk.Advance(2 * time.Minute)
	if fires, err := svc.Tick(ctx); err != nil || len(fires) != 0 {
		t.Fatalf("expected 0 fires at +2m, got %+v err=%v", fires, err)
	}

	// At +3m -> onceCron fires and disables itself!
	clk.Advance(1 * time.Minute)
	fires1, err := svc.Tick(ctx)
	if err != nil || len(fires1) != 1 || fires1[0].ScheduleID != "cron-once" {
		t.Fatalf("expected cron-once to fire at +3m, got %+v err=%v", fires1, err)
	}
	onceAfter, err := svc.GetCron(ctx, "cron-once")
	if err != nil || onceAfter.Enabled || onceAfter.NextRunAtMs != 0 {
		t.Fatalf("expected once cron disabled with cursor=0, got %+v err=%v", onceAfter, err)
	}

	// Advance +12m (to +15m, missing +5m and +10m) -> everyCron fires ONCE (coalesced missed ticks) and advances cursor to +20m!
	clk.Advance(12 * time.Minute)
	fires2, err := svc.Tick(ctx)
	if err != nil || len(fires2) != 1 || fires2[0].ScheduleID != "cron-every" {
		t.Fatalf("expected 1 coalesced cron-every fire at +15m, got %+v err=%v", fires2, err)
	}
	wantNextAfter15 := start.Add(20 * time.Minute).UnixMilli()
	if fires2[0].NextRunAtMs != wantNextAfter15 {
		t.Fatalf("expected next cursor %d (+20m), got %d", wantNextAfter15, fires2[0].NextRunAtMs)
	}

	// Close & reopen SQLite DB: cursor persists across restarts and doesn't double-fire!
	_ = svc.Close()
	svc2, err := issue.OpenSQLiteService(ctx, dbPath, issue.WithClock(clk), issue.WithDispatchSink(sink))
	if err != nil {
		t.Fatal(err)
	}
	defer svc2.Close()

	if firesDup, err := svc2.Tick(ctx); err != nil || len(firesDup) != 0 {
		t.Fatalf("expected 0 fires immediately after reopen at +15m, got %+v err=%v", firesDup, err)
	}
	persistedCron, err := svc2.GetCron(ctx, "cron-every")
	if err != nil || persistedCron.NextRunAtMs != wantNextAfter15 || persistedCron.LastRunAtMs != start.Add(15*time.Minute).UnixMilli() {
		t.Fatalf("persisted cursor mismatch: %+v err=%v", persistedCron, err)
	}

	// Advance +5m (to +20m) -> fires again and advances to +25m!
	clk.Advance(5 * time.Minute)
	fires3, err := svc2.Tick(ctx)
	if err != nil || len(fires3) != 1 || fires3[0].NextRunAtMs != start.Add(25*time.Minute).UnixMilli() {
		t.Fatalf("expected next fire at +20m advancing to +25m, got %+v err=%v", fires3, err)
	}
	// Bound issue is reused across scheduled runs!
	if fires3[0].IssueID != fires2[0].IssueID {
		t.Fatalf("expected bound issue reuse across cron fires: %q vs %q", fires3[0].IssueID, fires2[0].IssueID)
	}
	if len(firedKeys) != 3 {
		t.Fatalf("expected 3 total dispatches, got %v", firedKeys)
	}
}

func TestIssueGenerationResultSignalAndAsyncPRCheck(t *testing.T) {
	ctx := context.Background()
	clk := newFixedClock(time.Time{})
	var reqIDs []string
	svc := issue.NewMemoryService(
		issue.WithClock(clk),
		issue.WithDispatchSink(issue.DispatchSinkFunc(func(_ context.Context, cmd issue.DispatchCommand) (issue.DispatchReceipt, error) {
			reqIDs = append(reqIDs, cmd.RequestID)
			return issue.DispatchReceipt{
				SubmissionID:   "sub-" + cmd.RequestID,
				ConversationID: cmd.ConversationID,
				SessionID:      "sess-" + cmd.RequestID,
			}, nil
		})),
		issue.WithPRChecker(issue.PRCheckerFunc(func(_ context.Context, iss issue.Issue) (issue.PRCheckResult, error) {
			return issue.PRCheckResult{
				Passed:  false,
				Pending: true,
				Summary: "CI checks running",
				PRURL:   "https://github.com/vibevalleyhq/vibevalley/pull/101",
			}, nil
		})),
	)
	defer svc.Close()

	iss, err := svc.CreateIssue(ctx, issue.Issue{
		ID:     "iss-sig",
		Title:  "Signal + PR check",
		RepoID: "repo-1",
		Rubric: &contract.RubricSpec{Markdown: "- passes tests", MaxIterations: 3},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.QueueAndDispatch(ctx, iss.ID); err != nil {
		t.Fatal(err)
	}

	// Simulate durable.SignalSubmissionSettled with embedded GenerationResult (unmet).
	gen1Bytes, _ := json.Marshal(map[string]any{
		"submissionId":   "sub-issue:iss-sig:iter:1",
		"conversationId": "conv-issue-iss-sig",
		"requestId":      "issue:iss-sig:iter:1",
		"status":         store.SubmissionDone,
		"result": durable.GenerationResult{
			Output:     "draft 1",
			Iterations: 1,
			RubricVerdict: &contract.RubricVerdict{
				Satisfied:  false,
				Summary:    "missing edge test",
				UnmetItems: []string{"edge test"},
				Iteration:  1,
			},
		},
	})
	out1, err := svc.HandleSettlementSignal(ctx, store.Signal{
		ID:          "sig-1",
		TaskID:      "task-1",
		SignalName:  store.SignalSubmissionSettled,
		PayloadJSON: gen1Bytes,
	})
	if err != nil || out1.Action != issue.ActionRevisionDispatched || out1.Issue.Iteration != 2 {
		t.Fatalf("expected ActionRevisionDispatched iter 2, got %+v err=%v", out1, err)
	}

	// Replaying the same SubmissionID is a no-op!
	dup, err := svc.HandleSettlementSignal(ctx, store.Signal{
		ID:          "sig-1-dup",
		TaskID:      "task-1",
		SignalName:  store.SignalSubmissionSettled,
		PayloadJSON: gen1Bytes,
	})
	if err != nil || dup.Action != issue.ActionNoop {
		t.Fatalf("expected ActionNoop on duplicate submission replay, got %+v err=%v", dup, err)
	}

	// Iteration 2 satisfies rubric -> PR check returns Pending -> issue parks in review!
	gen2Bytes, _ := json.Marshal(map[string]any{
		"submissionId":   "sub-issue:iss-sig:iter:2",
		"conversationId": "conv-issue-iss-sig",
		"requestId":      "issue:iss-sig:iter:2",
		"status":         store.SubmissionDone,
		"result": durable.GenerationResult{
			Output:     "draft 2",
			Iterations: 2,
			RubricVerdict: &contract.RubricVerdict{
				Satisfied: true,
				Summary:   "ok",
				Iteration: 2,
			},
		},
	})
	out2, err := svc.HandleSettlementSignal(ctx, store.Signal{
		ID:          "sig-2",
		TaskID:      "task-1",
		SignalName:  store.SignalSubmissionSettled,
		PayloadJSON: gen2Bytes,
	})
	if err != nil || out2.Action != issue.ActionPRCheckPending || out2.Issue.Status != contract.IssueReview || out2.Issue.PRCheckStatus != issue.PRCheckPending {
		t.Fatalf("expected ActionPRCheckPending in review, got %+v err=%v", out2, err)
	}

	// External CI signal passes -> transitions to done!
	doneIss, err := svc.HandlePRCheckResult(ctx, iss.ID, true, "CI green", "https://github.com/vibevalleyhq/vibevalley/pull/101")
	if err != nil || doneIss.Status != contract.IssueDone || doneIss.PRCheckStatus != issue.PRCheckPassed {
		t.Fatalf("expected IssueDone after PR pass, got %+v err=%v", doneIss, err)
	}
	if len(reqIDs) != 2 || reqIDs[0] != "issue:iss-sig:iter:1" || reqIDs[1] != "issue:iss-sig:iter:2" {
		t.Fatalf("unexpected dispatch requestIds: %v", reqIDs)
	}
}

func TestIssueMigrationsUpStatusDownAllUp(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "issue-migrate.db")
	sqlDB, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer sqlDB.Close()
	sqlDB.SetMaxOpenConns(1)
	if _, err := sqlDB.ExecContext(ctx, "PRAGMA busy_timeout=5000"); err != nil {
		t.Fatalf("pragma: %v", err)
	}

	scopeFS, err := db.ScopeFS("issue")
	if err != nil {
		t.Fatalf("ScopeFS(issue): %v", err)
	}
	runner, err := migrate.New(sqlDB, "issue", scopeFS)
	if err != nil {
		t.Fatalf("migrate.New: %v", err)
	}

	st0, err := runner.Status(ctx)
	if err != nil || len(st0) != 1 || st0[0].Applied || st0[0].Version != 1 || st0[0].Scope != "issue" {
		t.Fatalf("unexpected initial status: %+v err=%v", st0, err)
	}

	applied, err := runner.Up(ctx)
	if err != nil || applied != 1 {
		t.Fatalf("Up: applied=%d err=%v", applied, err)
	}
	st1, err := runner.Status(ctx)
	if err != nil || len(st1) != 1 || !st1[0].Applied || st1[0].AppliedAtMs <= 0 {
		t.Fatalf("unexpected status after Up: %+v err=%v", st1, err)
	}
	if again, err := runner.Up(ctx); err != nil || again != 0 {
		t.Fatalf("idempotent Up: applied=%d err=%v", again, err)
	}

	assertIssueObjectsExist(t, sqlDB, true)

	clk := newFixedClock(time.Unix(1_700_000_000, 0).UTC())
	svc1, err := issue.OpenDBService(ctx, sqlDB, issue.WithClock(clk))
	if err != nil {
		t.Fatalf("OpenDBService after Up: %v", err)
	}

	// Exercise dbgen queries: CreateIssue, ListIssues (all + sqlc.slice status filter), FindByConversation/Session, Crons.
	if _, err := svc1.CreateIssue(ctx, issue.Issue{
		ID:             "iss-1",
		Title:          "Draft issue",
		Status:         contract.IssueDraft,
		RepoID:         "repo-1",
		ConversationID: "conv-1",
		SessionID:      "sess-1",
	}); err != nil {
		t.Fatalf("CreateIssue 1: %v", err)
	}
	if _, err := svc1.CreateIssue(ctx, issue.Issue{
		ID:     "iss-2",
		Title:  "InProgress issue",
		Status: contract.IssueInProgress,
		RepoID: "repo-1",
	}); err != nil {
		t.Fatalf("CreateIssue 2: %v", err)
	}
	if _, err := svc1.CreateIssue(ctx, issue.Issue{
		ID:     "iss-3",
		Title:  "Review issue",
		Status: contract.IssueReview,
		RepoID: "repo-1",
	}); err != nil {
		t.Fatalf("CreateIssue 3: %v", err)
	}

	allIssues, err := svc1.ListIssues(ctx)
	if err != nil || len(allIssues) != 3 {
		t.Fatalf("ListIssues(): len=%d err=%v", len(allIssues), err)
	}
	filtered, err := svc1.ListIssues(ctx, contract.IssueDraft, contract.IssueReview)
	if err != nil || len(filtered) != 2 || filtered[0].ID != "iss-1" || filtered[1].ID != "iss-3" {
		t.Fatalf("ListIssues(draft, review): %+v err=%v", filtered, err)
	}
	none, err := svc1.ListIssues(ctx, contract.IssueDone)
	if err != nil || len(none) != 0 {
		t.Fatalf("ListIssues(done): len=%d err=%v", len(none), err)
	}
	outSettle, err := svc1.HandleSettlement(ctx, issue.Settlement{
		ConversationID: "conv-1",
		SubmissionID:   "sub-1",
		Status:         store.SubmissionDone,
	})
	if err != nil || outSettle.Issue.ID != "iss-1" || outSettle.Issue.Status != contract.IssueDone {
		t.Fatalf("HandleSettlement by conversation: %+v err=%v", outSettle, err)
	}
	if _, err := svc1.CreateCron(ctx, issue.CronSchedule{
		ID:           "cron-1",
		Name:         "Check",
		Title:        "Check",
		Prompt:       "Check",
		RepoID:       "repo-1",
		Kind:         issue.CronEvery,
		EveryMinutes: 10,
		Enabled:      true,
	}); err != nil {
		t.Fatalf("CreateCron: %v", err)
	}
	if crons, err := svc1.ListCrons(ctx); err != nil || len(crons) != 1 {
		t.Fatalf("ListCrons: %+v err=%v", crons, err)
	}
	if _, err := svc1.SetCronEnabled(ctx, "cron-1", false); err != nil {
		t.Fatalf("SetCronEnabled: %v", err)
	}
	_ = svc1.Close()

	// Checksum mismatch detection when applied up script is modified.
	upOrig, err := fs.ReadFile(scopeFS, "migrations/0001_issue.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	downOrig, err := fs.ReadFile(scopeFS, "migrations/0001_issue.down.sql")
	if err != nil {
		t.Fatal(err)
	}
	tamperedFS := fstest.MapFS{
		"migrations/0001_issue.up.sql":   {Data: append(upOrig, []byte("\n-- tampered\n")...)},
		"migrations/0001_issue.down.sql": {Data: downOrig},
	}
	tamperedRunner, err := migrate.New(sqlDB, "issue", tamperedFS)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tamperedRunner.Up(ctx); !errors.Is(err, migrate.ErrChecksumMismatch) {
		t.Fatalf("expected ErrChecksumMismatch, got %v", err)
	}

	// DownAll drops all issue tables and indexes cleanly.
	reverted, err := runner.DownAll(ctx)
	if err != nil || reverted != 1 {
		t.Fatalf("DownAll: reverted=%d err=%v", reverted, err)
	}
	st2, err := runner.Status(ctx)
	if err != nil || len(st2) != 1 || st2[0].Applied {
		t.Fatalf("unexpected status after DownAll: %+v err=%v", st2, err)
	}
	assertIssueObjectsExist(t, sqlDB, false)

	// Re-Up restores full parity cleanly.
	reapplied, err := runner.Up(ctx)
	if err != nil || reapplied != 1 {
		t.Fatalf("re-Up: applied=%d err=%v", reapplied, err)
	}
	st3, err := runner.Status(ctx)
	if err != nil || len(st3) != 1 || !st3[0].Applied {
		t.Fatalf("unexpected status after re-Up: %+v err=%v", st3, err)
	}
	assertIssueObjectsExist(t, sqlDB, true)

	svc2, err := issue.OpenDBService(ctx, sqlDB, issue.WithClock(clk))
	if err != nil {
		t.Fatalf("OpenDBService after re-Up: %v", err)
	}
	defer svc2.Close()
	if afterDown, err := svc2.ListIssues(ctx); err != nil || len(afterDown) != 0 {
		t.Fatalf("expected 0 issues after DownAll+Up, got %+v err=%v", afterDown, err)
	}
	if _, err := svc2.CreateIssue(ctx, issue.Issue{ID: "iss-fresh", Title: "Fresh", RepoID: "repo-1"}); err != nil {
		t.Fatalf("CreateIssue after re-Up: %v", err)
	}
}

func TestOpenSQLiteServiceFromDBNonOwning(t *testing.T) {
	ctx := context.Background()
	pool, err := db.OpenPool(ctx, filepath.Join(t.TempDir(), "shared.db"))
	if err != nil {
		t.Fatalf("OpenPool: %v", err)
	}
	defer pool.Close()

	runner, err := migrate.New(pool.WriteDB, db.PlatformScope, db.MigrationsFS)
	if err != nil {
		t.Fatalf("migrate.New: %v", err)
	}
	if _, err := runner.Up(ctx); err != nil {
		t.Fatalf("Up: %v", err)
	}

	svc, err := issue.OpenSQLiteServiceFromDB(ctx, pool.WriteDB)
	if err != nil {
		t.Fatalf("OpenSQLiteServiceFromDB: %v", err)
	}
	if _, err := svc.CreateIssue(ctx, issue.Issue{ID: "shared-iss-1", Title: "Shared", RepoID: "repo-1"}); err != nil {
		t.Fatalf("CreateIssue: %v", err)
	}
	if err := svc.Close(); err != nil {
		t.Fatalf("svc.Close: %v", err)
	}
	if err := pool.WriteDB.PingContext(ctx); err != nil {
		t.Fatalf("shared WriteDB closed by Service.Close: %v", err)
	}

	svc2, err := issue.OpenSQLiteServiceFromDB(ctx, pool.WriteDB)
	if err != nil {
		t.Fatalf("reattach OpenSQLiteServiceFromDB: %v", err)
	}
	defer svc2.Close()
	got, err := svc2.GetIssue(ctx, "shared-iss-1")
	if err != nil || got.Title != "Shared" {
		t.Fatalf("reattached GetIssue: %+v err=%v", got, err)
	}
}

func assertIssueObjectsExist(t *testing.T, sqlDB *sql.DB, want bool) {
	t.Helper()
	objects := []struct {
		typ  string
		name string
	}{
		{"table", "issue"},
		{"table", "issue_cron"},
		{"index", "issue_status_idx"},
		{"index", "issue_conv_idx"},
		{"index", "issue_session_idx"},
		{"index", "issue_cron_due_idx"},
	}
	for _, obj := range objects {
		var cnt int
		err := sqlDB.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = ? AND name = ?`, obj.typ, obj.name).Scan(&cnt)
		if err != nil {
			t.Fatalf("query sqlite_master (%s %s): %v", obj.typ, obj.name, err)
		}
		if want && cnt != 1 {
			t.Fatalf("expected %s %q to exist, count=%d", obj.typ, obj.name, cnt)
		}
		if !want && cnt != 0 {
			t.Fatalf("expected %s %q to be dropped, count=%d", obj.typ, obj.name, cnt)
		}
	}
}
