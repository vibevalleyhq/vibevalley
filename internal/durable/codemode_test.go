package durable_test

import (
	"context"
	"encoding/json"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/durable"
	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
)

func TestCodeModeDeterministicFastForwardReplayAndQuota(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	dbPath := filepath.Join(t.TempDir(), "codemode.db")
	clk := store.NewFakeClock(time.Unix(1_700_000_000, 0))
	st, err := store.OpenSQLite(ctx, dbPath, store.WithClock(clk))
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	defer func() { _ = st.Close() }()

	var step1Calls atomic.Int32
	var step2Calls atomic.Int32
	step2Block := make(chan struct{})
	step2Entered := make(chan struct{})

	toolHandler := func(tctx context.Context, name string, args any) (any, error) {
		switch name {
		case "step_one":
			step1Calls.Add(1)
			return map[string]any{"val": 100}, nil
		case "step_two":
			n := step2Calls.Add(1)
			if n == 1 {
				close(step2Entered)
				select {
				case <-step2Block:
				case <-tctx.Done():
				}
				return nil, context.Canceled
			}
			m, _ := args.(map[string]any)
			return map[string]any{"val": 200, "prev": m["prev"], "rnd": m["rnd"]}, nil
		default:
			return nil, durable.ErrUnknownTool
		}
	}

	sched1 := durable.NewScheduler(st)
	durable.RegisterCodeModePhases(sched1, toolHandler)

	script := `
		let a = call("step_one", { n: 1 });
		let r = rand();
		sleep(5000);
		let b = call("step_two", { prev: a.val, rnd: r });
		return { a: a.val, b: b.val, rnd: r, now: clock.now() };
	`
	startMs := int64(1_700_000_000_000)
	taskRes, err := sched1.StartTask(ctx, store.Task{
		ID:          "cm-task-1",
		Kind:        durable.TaskKindCodeMode,
		PhaseName:   durable.PhaseCodeExec,
		IsModelTask: true,
		CheckpointJSON: mustJSON(durable.CodeModeSpec{
			Script:      script,
			Seed:        42,
			StartTimeMs: startMs,
			MaxSteps:    5000,
		}),
	})
	if err != nil {
		t.Fatalf("StartTask codemode: %v", err)
	}

	// Wait until step_one completed and script entered sleep(5000).
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		tk, _ := st.GetTask(ctx, taskRes.Task.ID)
		if tk.Status == store.TaskSleeping {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	if step1Calls.Load() != 1 {
		t.Fatalf("expected step_one called once before sleep, got %d", step1Calls.Load())
	}

	// Advance FakeClock 5s -> wakes sleep, fast-forwards step_one + sleep, enters step_two!
	clk.Advance(5000 * time.Millisecond)
	<-step2Entered

	// Crash process right in the middle of step_two!
	sched1.Close()
	close(step2Block)
	_ = st.SimulateCrash()

	// Reopen SQLite DB with fresh scheduler & recover!
	st, err = store.OpenSQLite(ctx, dbPath, store.WithClock(clk))
	if err != nil {
		t.Fatalf("reopen SQLite: %v", err)
	}
	defer func() { _ = st.Close() }()

	sched2 := durable.NewScheduler(st)
	defer sched2.Close()
	durable.RegisterCodeModePhases(sched2, toolHandler)

	if err := sched2.Recover(ctx); err != nil {
		t.Fatalf("Recover: %v", err)
	}

	done, err := sched2.WaitTask(ctx, taskRes.Task.ID)
	if err != nil || done.TerminalReason != store.ReasonCompleted {
		t.Fatalf("expected codemode completion after recovery, got %+v err=%v", done, err)
	}

	// Crucial invariant: step_one was NEVER re-executed after crash (fast-forwarded via dedup_key)!
	if step1Calls.Load() != 1 {
		t.Fatalf("step_one re-executed on replay! calls=%d", step1Calls.Load())
	}
	if step2Calls.Load() != 2 {
		t.Fatalf("expected step_two called twice (1 interrupted + 1 recovered), got %d", step2Calls.Load())
	}

	var res durable.CodeModeResult
	if err := json.Unmarshal(done.ResultJSON, &res); err != nil {
		t.Fatalf("unmarshal codemode result: %v", err)
	}
	if res.ReplayedCalls != 2 || res.ReplayedSleeps != 1 {
		t.Fatalf("expected ReplayedCalls=2 (step_one + step_two) and ReplayedSleeps=1, got %+v", res)
	}
	if res.VirtualNowMs != startMs+5000 {
		t.Fatalf("expected virtual clock %d, got %d", startMs+5000, res.VirtualNowMs)
	}

	// Verify step quota aborts infinite loops cleanly.
	loopTask, err := sched2.StartTask(ctx, store.Task{
		ID:        "cm-loop",
		Kind:      durable.TaskKindCodeMode,
		PhaseName: durable.PhaseCodeExec,
		CheckpointJSON: mustJSON(durable.CodeModeSpec{
			Script:   `while (true) { let x = 1; }`,
			MaxSteps: 50,
		}),
	})
	if err != nil {
		t.Fatalf("StartTask loop: %v", err)
	}
	loopDone, err := sched2.WaitTask(ctx, loopTask.Task.ID)
	if err != nil {
		t.Fatalf("WaitTask loop: %v", err)
	}
	if loopDone.TerminalReason != store.ReasonFailed {
		t.Fatalf("expected step quota failure, got %+v", loopDone)
	}
}
