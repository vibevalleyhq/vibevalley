package durable_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"runtime"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/durable"
	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
)

func TestSchedulerEarlySignalsAndZeroGoroutinesWhileSleeping(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	clk := store.NewFakeClock(time.Unix(1_700_000_000, 0))
	st := store.NewMemory(store.WithClock(clk))
	defer st.Close()

	sched := durable.NewScheduler(st)
	defer sched.Close()

	// 1. Early signal delivered BEFORE task exists / reaches TransSleep must wake immediately without sleeping.
	earlyTaskID := "task-early-sig"
	if _, err := sched.SendSignal(ctx, store.Signal{
		TaskID:      earlyTaskID,
		SignalName:  "external.ready",
		SignalKey:   "sig-1",
		PayloadJSON: []byte(`{"token":"early-ok"}`),
	}); err != nil {
		t.Fatalf("SendSignal early: %v", err)
	}

	var receivedPayload atomic.Value
	sched.RegisterPhase("early_kind", "start", func(_ context.Context, tc *durable.TaskContext) (durable.Transition, error) {
		return durable.TransSleep("woken", nil, durable.SleepOptions{
			WakeAfter:  10 * time.Hour,
			SignalName: "external.ready",
		}), nil
	})
	sched.RegisterPhase("early_kind", "woken", func(_ context.Context, tc *durable.TaskContext) (durable.Transition, error) {
		if sig := tc.Signal(); sig != nil {
			receivedPayload.Store(string(sig.PayloadJSON))
		}
		return durable.TransComplete(map[string]bool{"ok": true}), nil
	})

	if _, err := sched.StartTask(ctx, store.Task{
		ID:        earlyTaskID,
		Kind:      "early_kind",
		PhaseName: "start",
	}); err != nil {
		t.Fatalf("StartTask early: %v", err)
	}
	doneEarly, err := sched.WaitTask(ctx, earlyTaskID)
	if err != nil || doneEarly.Status != store.TaskTerminal || doneEarly.TerminalReason != store.ReasonCompleted {
		t.Fatalf("WaitTask early failed: %+v err=%v", doneEarly, err)
	}
	if got, _ := receivedPayload.Load().(string); got != `{"token":"early-ok"}` {
		t.Fatalf("expected early signal payload, got %q", got)
	}

	// 2. Verify 60 sleeping + waiting tasks hold ZERO active worker goroutines.
	baseGoroutines := runtime.NumGoroutine()

	sched.RegisterPhase("sleep_kind", "sleep", func(_ context.Context, tc *durable.TaskContext) (durable.Transition, error) {
		return durable.TransSleep("done", map[string]int{"step": 1}, durable.SleepOptions{
			WakeAfter: 2 * time.Hour,
		}), nil
	})
	sched.RegisterPhase("sleep_kind", "done", func(_ context.Context, tc *durable.TaskContext) (durable.Transition, error) {
		return durable.TransComplete(map[string]string{"status": "woke"}), nil
	})
	sched.RegisterPhase("parent_wait", "spawn", func(pctx context.Context, tc *durable.TaskContext) (durable.Transition, error) {
		c1, _, err := tc.SpawnChild(pctx, durable.ChildTaskSpec{Kind: "sleep_kind", PhaseName: "sleep", DedupKey: "c1"})
		if err != nil {
			return durable.Transition{}, err
		}
		c2, _, err := tc.SpawnChild(pctx, durable.ChildTaskSpec{Kind: "sleep_kind", PhaseName: "sleep", DedupKey: "c2"})
		if err != nil {
			return durable.Transition{}, err
		}
		return durable.TransWaitTasks("joined", nil, store.WaitAllSettled, []string{c1.ID, c2.ID}), nil
	})
	sched.RegisterPhase("parent_wait", "joined", func(_ context.Context, tc *durable.TaskContext) (durable.Transition, error) {
		return durable.TransComplete(map[string]int{"children": len(tc.ChildResults())}), nil
	})

	var parentIDs []string
	for i := range 20 {
		pid := fmt.Sprintf("parent-%d", i)
		parentIDs = append(parentIDs, pid)
		if _, err := sched.StartTask(ctx, store.Task{ID: pid, Kind: "parent_wait", PhaseName: "spawn"}); err != nil {
			t.Fatalf("StartTask %s: %v", pid, err)
		}
	}

	// Wait briefly until all 20 parents + 40 children reach waiting/sleeping.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		sleeping, _ := st.ListTasksByStatus(ctx, store.TaskSleeping)
		waiting, _ := st.ListTasksByStatus(ctx, store.TaskWaiting)
		if len(sleeping) == 40 && len(waiting) == 20 && sched.ActiveWorkers() == 0 {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}

	sleeping, _ := st.ListTasksByStatus(ctx, store.TaskSleeping)
	waiting, _ := st.ListTasksByStatus(ctx, store.TaskWaiting)
	if len(sleeping) != 40 || len(waiting) != 20 {
		t.Fatalf("expected 40 sleeping + 20 waiting, got sleeping=%d waiting=%d", len(sleeping), len(waiting))
	}
	if sched.ActiveWorkers() != 0 {
		t.Fatalf("expected 0 active worker goroutines while sleeping/waiting, got %d", sched.ActiveWorkers())
	}
	// Goroutine count should not scale with the 60 parked tasks (allow tiny runtime variance).
	if diff := runtime.NumGoroutine() - baseGoroutines; diff > 4 {
		t.Fatalf("goroutine leak while sleeping/waiting: delta=%d", diff)
	}

	// Advance FakeClock 2 hours in <10ms real time -> all 60 tasks wake and finish cleanly.
	clk.Advance(2 * time.Hour)
	for _, pid := range parentIDs {
		res, err := sched.WaitTask(ctx, pid)
		if err != nil || res.TerminalReason != store.ReasonCompleted {
			t.Fatalf("parent %s failed: %+v err=%v", pid, res, err)
		}
	}
}

func TestSchedulerWaitModesAllSettledFailFastAny(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	clk := store.NewFakeClock(time.Unix(1_700_000_000, 0))
	st := store.NewMemory(store.WithClock(clk))
	defer st.Close()
	sched := durable.NewScheduler(st)
	defer sched.Close()

	sched.RegisterPhase("worker", "fast_ok", func(_ context.Context, _ *durable.TaskContext) (durable.Transition, error) {
		return durable.TransComplete("ok"), nil
	})
	sched.RegisterPhase("worker", "fast_fail", func(_ context.Context, _ *durable.TaskContext) (durable.Transition, error) {
		return durable.TransFail("boom", errors.New("child failure")), nil
	})
	sched.RegisterPhase("worker", "slow_ok", func(_ context.Context, _ *durable.TaskContext) (durable.Transition, error) {
		return durable.TransSleep("slow_done", nil, durable.SleepOptions{WakeAfter: 10 * time.Minute}), nil
	})
	sched.RegisterPhase("worker", "slow_done", func(_ context.Context, _ *durable.TaskContext) (durable.Transition, error) {
		return durable.TransComplete("slow"), nil
	})

	for _, tc := range []struct {
		name     string
		mode     store.WaitMode
		child2   string // fast_fail or slow_ok
		child1   string // fast_ok or slow_ok
		wantWake bool   // wakes BEFORE advancing 10m
	}{
		{name: "failFast", mode: store.WaitFailFast, child1: "slow_ok", child2: "fast_fail", wantWake: true},
		{name: "any", mode: store.WaitAny, child1: "fast_ok", child2: "slow_ok", wantWake: true},
		{name: "allSettled", mode: store.WaitAllSettled, child1: "fast_ok", child2: "slow_ok", wantWake: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			kind := "waiter_" + tc.name
			sched.RegisterPhase(kind, "start", func(pctx context.Context, tctx *durable.TaskContext) (durable.Transition, error) {
				c1, _, _ := tctx.SpawnChild(pctx, durable.ChildTaskSpec{Kind: "worker", PhaseName: tc.child1})
				c2, _, _ := tctx.SpawnChild(pctx, durable.ChildTaskSpec{Kind: "worker", PhaseName: tc.child2})
				return durable.TransWaitTasks("done", nil, tc.mode, []string{c1.ID, c2.ID}), nil
			})
			sched.RegisterPhase(kind, "done", func(_ context.Context, tctx *durable.TaskContext) (durable.Transition, error) {
				return durable.TransComplete(len(tctx.ChildResults())), nil
			})

			pRes, err := sched.StartTask(ctx, store.Task{Kind: kind, PhaseName: "start"})
			if err != nil {
				t.Fatalf("StartTask: %v", err)
			}

			if tc.wantWake {
				done, err := sched.WaitTask(ctx, pRes.Task.ID)
				if err != nil || done.TerminalReason != store.ReasonCompleted {
					t.Fatalf("expected early wakeup for %s, got %+v err=%v", tc.name, done, err)
				}
			} else {
				// Should remain waiting until slow_ok finishes.
				time.Sleep(25 * time.Millisecond)
				cur, _ := st.GetTask(ctx, pRes.Task.ID)
				if cur.Status != store.TaskWaiting {
					t.Fatalf("expected allSettled to remain waiting, got %s", cur.Status)
				}
				clk.Advance(10 * time.Minute)
				done, err := sched.WaitTask(ctx, pRes.Task.ID)
				if err != nil || done.TerminalReason != store.ReasonCompleted {
					t.Fatalf("expected allSettled completion after advance, got %+v err=%v", done, err)
				}
			}
		})
	}
}

func TestSchedulerRestartLimitCircuitBreakerAndBottomUpAbort(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	dbPath := filepath.Join(t.TempDir(), "restart.db")
	st, err := store.OpenSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	defer func() { _ = st.Close() }()

	// Build a task hierarchy: root -> (childA -> grandchild1, childB) all parked/running.
	// Also test a model task that stays resilient without tripping restartLimit.
	err = st.Mutate(ctx, func(tx *store.Tx) error {
		for _, task := range []store.Task{
			{ID: "root", Kind: "crasher", Status: store.TaskRunning, PhaseName: "step", RestartLimit: 5},
			{ID: "childA", OwnerTaskID: "root", Kind: "child", Status: store.TaskSleeping, PhaseName: "wait", WaitSignalName: "never"},
			{ID: "grandchild1", OwnerTaskID: "childA", Kind: "leaf", Status: store.TaskSleeping, PhaseName: "wait", WaitSignalName: "never"},
			{ID: "childB", OwnerTaskID: "root", Kind: "child", Status: store.TaskPending, PhaseName: "wait"},
			{ID: "model-task", Kind: "model_runner", IsModelTask: true, Status: store.TaskRunning, PhaseName: "gen", RestartLimit: 5},
		} {
			if _, err := tx.CreateTask(ctx, task); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("seed hierarchy: %v", err)
	}

	var alerts []durable.Alert
	// Crash 1..4 without advancing checkpoint: each crash increments restart_count (1..4) and re-queues.
	for crashNum := 1; crashNum <= 4; crashNum++ {
		sched := durable.NewScheduler(st, durable.WithAlertSink(durable.AlertSinkFunc(func(a durable.Alert) {
			alerts = append(alerts, a)
		})))
		// Don't start worker phases that finish root; instead inspect post-Recover state directly by
		// leaving no handler or blocking? Wait: if we register a phase that immediately checkpoints vs
		// simulating crash while running, let's test Recover directly by using a crash-before-checkpoint phase!
		crashSignal := make(chan struct{})
		sched.RegisterPhase("crasher", "step", func(pctx context.Context, _ *durable.TaskContext) (durable.Transition, error) {
			close(crashSignal)
			<-pctx.Done() // Simulates process frozen/killed mid-phase before returning Transition!
			return durable.Transition{}, pctx.Err()
		})
		sched.RegisterPhase("model_runner", "gen", func(pctx context.Context, _ *durable.TaskContext) (durable.Transition, error) {
			<-pctx.Done()
			return durable.Transition{}, pctx.Err()
		})
		sched.RegisterPhase("child", "wait", func(_ context.Context, _ *durable.TaskContext) (durable.Transition, error) {
			return durable.TransSleep("wait", nil, durable.SleepOptions{SignalName: "never"}), nil
		})

		if err := sched.Recover(ctx); err != nil {
			t.Fatalf("Recover crash %d: %v", crashNum, err)
		}
		<-crashSignal

		cur, err := st.GetTask(ctx, "root")
		if err != nil {
			t.Fatalf("GetTask root crash %d: %v", crashNum, err)
		}
		if cur.RestartCount != crashNum {
			t.Fatalf("crash %d: expected restart_count=%d, got %d", crashNum, crashNum, cur.RestartCount)
		}
		// Simulate abrupt SIGKILL leaving root in TaskRunning without calling TransNext!
		sched.Close()
		_ = st.Mutate(ctx, func(tx *store.Tx) error {
			for _, id := range []string{"root", "model-task"} {
				tk, err := tx.GetTask(ctx, id)
				if err != nil {
					return err
				}
				tk.Status = store.TaskRunning
				if _, err := tx.UpdateTask(ctx, tk); err != nil {
					return err
				}
			}
			return nil
		})
	}

	if len(alerts) != 0 {
		t.Fatalf("expected 0 restart_limit alerts before 5th crash, got %+v", alerts)
	}

	// Reopen SQLite from disk and run 5th crash Recover -> trips restartLimit=5 AND performs bottom-up Abort!
	_ = st.SimulateCrash()
	st, err = store.OpenSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("reopen OpenSQLite: %v", err)
	}
	defer func() { _ = st.Close() }()

	sched := durable.NewScheduler(st, durable.WithAlertSink(durable.AlertSinkFunc(func(a durable.Alert) {
		alerts = append(alerts, a)
	})))
	defer sched.Close()
	sched.RegisterPhase("model_runner", "gen", func(_ context.Context, _ *durable.TaskContext) (durable.Transition, error) {
		return durable.TransComplete("model survived"), nil
	})

	if err := sched.Recover(ctx); err != nil {
		t.Fatalf("Recover 5th crash: %v", err)
	}

	// Root tripped restart_limit.
	root, err := st.GetTask(ctx, "root")
	if err != nil {
		t.Fatalf("GetTask root: %v", err)
	}
	if root.Status != store.TaskTerminal || root.TerminalReason != store.ReasonRestartLimit || root.RestartCount != 5 {
		t.Fatalf("expected root terminal/restart_limit/5, got %+v", root)
	}

	// Verify model task was NOT tripped by restartLimit and completed cleanly.
	modelDone, err := sched.WaitTask(ctx, "model-task")
	if err != nil || modelDone.TerminalReason != store.ReasonCompleted {
		t.Fatalf("expected model-task to complete, got %+v err=%v", modelDone, err)
	}

	// Verify strict bottom-up abort order: grandchild1 < childA, childB < root!
	trace := sched.AbortTrace()
	idx := func(id string) int { return slices.Index(trace, id) }
	if idx("grandchild1") < 0 || idx("childA") < 0 || idx("childB") < 0 || idx("root") < 0 {
		t.Fatalf("missing aborted task in trace: %v", trace)
	}
	if !(idx("grandchild1") < idx("childA") && idx("childA") < idx("root") && idx("childB") < idx("root")) {
		t.Fatalf("expected strict bottom-up abort order (grandchild1 < childA < root, childB < root), got %v", trace)
	}

	// Verify restart_limit alert emitted to AlertSink and persisted to pi.inbox.
	if len(alerts) != 1 || alerts[0].Kind != durable.AlertRestartLimit {
		t.Fatalf("expected 1 restart_limit alert, got %+v", alerts)
	}
	inboxDoc, err := st.GetDocument(ctx, store.ScopeGlobal, "inbox", store.DocInbox)
	if err != nil {
		t.Fatalf("expected pi.inbox alert persisted: %v", err)
	}
	var inbox struct {
		Items []durable.Alert `json:"items"`
	}
	if err := json.Unmarshal(inboxDoc.StateJSON, &inbox); err != nil || len(inbox.Items) != 1 {
		t.Fatalf("unexpected pi.inbox doc: %s (err=%v)", string(inboxDoc.StateJSON), err)
	}

	// Also verify advancing a checkpoint resets restart_count to 0 so 4 crashes + progress + 4 crashes succeeds.
	if _, err := sched.StartTask(ctx, store.Task{
		ID:           "prog-task",
		Kind:         "prog_kind",
		Status:       store.TaskRunning,
		PhaseName:    "p1",
		RestartCount: 4,
		RestartLimit: 5,
	}); err != nil {
		t.Fatalf("StartTask prog-task: %v", err)
	}
	sched.RegisterPhase("prog_kind", "p1", func(pctx context.Context, tc *durable.TaskContext) (durable.Transition, error) {
		if err := tc.Checkpoint(pctx, map[string]int{"progress": 1}); err != nil {
			return durable.Transition{}, err
		}
		return durable.TransComplete("progressed"), nil
	})
	// Force Recover with RestartCount=3 -> becomes 4 (<5) -> runs p1 -> Checkpoint resets RestartCount=0 & completes!
	_ = st.Mutate(ctx, func(tx *store.Tx) error {
		tk, _ := tx.GetTask(ctx, "prog-task")
		tk.RestartCount = 3
		tk.Status = store.TaskRunning
		_, err := tx.UpdateTask(ctx, tk)
		return err
	})
	if err := sched.Recover(ctx); err != nil {
		t.Fatalf("Recover prog-task: %v", err)
	}
	doneProg, err := sched.WaitTask(ctx, "prog-task")
	if err != nil || doneProg.TerminalReason != store.ReasonCompleted || doneProg.RestartCount != 0 {
		t.Fatalf("expected checkpoint to reset restart_count to 0 and complete, got %+v err=%v", doneProg, err)
	}
}
