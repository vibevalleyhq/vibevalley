package durable_test

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"runtime"
	"strings"
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

func TestCodeModeGojaDeterministicDateAndMathRandomAcrossReplay(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	dbPath := filepath.Join(t.TempDir(), "codemode-goja-replay.db")
	st, err := store.OpenSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	defer func() { _ = st.Close() }()

	var step1Calls atomic.Int32
	var step2Calls atomic.Int32
	var step3Calls atomic.Int32
	step3Entered := make(chan struct{})
	step3Block := make(chan struct{})

	var recordedFirstT0 atomic.Int64
	var recordedFirstR0 atomic.Value

	toolHandler := func(tctx context.Context, name string, args any) (any, error) {
		m, _ := args.(map[string]any)
		switch name {
		case "fetch_items":
			step1Calls.Add(1)
			// Simulate non-trivial external work on initial execution; replay must skip this in ~0ms.
			time.Sleep(20 * time.Millisecond)
			if t0, ok := m["t0"].(float64); ok {
				recordedFirstT0.Store(int64(t0))
			}
			recordedFirstR0.Store(m["r0"])
			return map[string]any{"items": []int{10, 20, 30}}, nil
		case "transform":
			step2Calls.Add(1)
			time.Sleep(20 * time.Millisecond)
			return map[string]any{"sum": m["sum"], "tag": m["tag"]}, nil
		case "commit":
			n := step3Calls.Add(1)
			if n == 1 {
				close(step3Entered)
				select {
				case <-step3Block:
				case <-tctx.Done():
				}
				return nil, context.Canceled
			}
			return map[string]any{"committed": true, "t2": m["t2"], "r2": m["r2"]}, nil
		default:
			return nil, durable.ErrUnknownTool
		}
	}

	sched1 := durable.NewScheduler(st)
	durable.RegisterCodeModePhases(sched1, toolHandler)

	// Exercises real ES6+ syntax, Date.now(), new Date(), Math.random(), callTool(), vibe.call(), vibe.sleep().
	script := `
		class Acc {
			constructor(base) { this.base = base; }
			sum(xs) { return xs.reduce((a, b) => a + b, this.base); }
		}
		const t0 = Date.now();
		const iso0 = new Date().toISOString();
		const d0 = new Date().getTime();
		const r0 = Math.random();
		const r1 = Math.random();

		const { items } = callTool("fetch_items", { t0, d0, iso0, r0 });
		const acc = new Acc(5);
		const total = acc.sum(items.map(x => x * 2));

		vibe.sleep(25);
		const t1 = Date.now();
		const res2 = vibe.call("transform", { sum: total, tag: ` + "`t=${t1}`" + ` });

		const r2 = Math.random();
		const t2 = Date.now();
		const res3 = callTool("commit", { t2, r2, prev: res2.sum });

		return {
			t0,
			d0,
			iso0,
			t1,
			t2,
			r0,
			r1,
			r2,
			total: res2.sum,
			tag: res2.tag,
			committed: res3.committed
		};
	`

	// Omit StartTimeMs so execution run freezes task.CreatedAtMs under RealClock across crash replays.
	taskRes, err := sched1.StartTask(ctx, store.Task{
		ID:          "cm-goja-1",
		Kind:        durable.TaskKindCodeMode,
		PhaseName:   durable.PhaseCodeExec,
		IsModelTask: true,
		CheckpointJSON: mustJSON(durable.CodeModeSpec{
			Script:   script,
			Seed:     1337,
			MaxSteps: 5000,
		}),
	})
	if err != nil {
		t.Fatalf("StartTask: %v", err)
	}

	// Wait until step 1 & step 2 finished and step 3 entered.
	<-step3Entered

	// Crash process right in the middle of step 3, and wait real wall time before recovery.
	sched1.Close()
	close(step3Block)
	_ = st.SimulateCrash()
	time.Sleep(30 * time.Millisecond)

	st, err = store.OpenSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("reopen SQLite: %v", err)
	}
	defer func() { _ = st.Close() }()

	sched2 := durable.NewScheduler(st)
	defer sched2.Close()
	durable.RegisterCodeModePhases(sched2, toolHandler)

	replayStart := time.Now()
	if err := sched2.Recover(ctx); err != nil {
		t.Fatalf("Recover: %v", err)
	}

	done, err := sched2.WaitTask(ctx, taskRes.Task.ID)
	replayElapsed := time.Since(replayStart)
	if err != nil || done.TerminalReason != store.ReasonCompleted {
		t.Fatalf("expected completion after recovery, got %+v err=%v", done, err)
	}

	if step1Calls.Load() != 1 || step2Calls.Load() != 1 {
		t.Fatalf("completed tools must never re-run! step1=%d step2=%d", step1Calls.Load(), step2Calls.Load())
	}
	if step3Calls.Load() != 2 {
		t.Fatalf("expected step3 called twice (1 interrupted + 1 recovered), got %d", step3Calls.Load())
	}

	// Verify sequential dedup_key child tasks AND memo_json journal records exist on disk.
	children, err := st.ListChildTasks(ctx, taskRes.Task.ID)
	if err != nil {
		t.Fatalf("ListChildTasks: %v", err)
	}
	if len(children) != 3 {
		t.Fatalf("expected 3 durable child tool tasks, got %d", len(children))
	}
	wantDedupKeys := []string{
		"cm-goja-1:call:1:fetch_items",
		"cm-goja-1:call:2:transform",
		"cm-goja-1:call:3:commit",
	}
	var memoMap map[string]json.RawMessage
	if err := json.Unmarshal(done.MemoJSON, &memoMap); err != nil {
		t.Fatalf("unmarshal MemoJSON: %v", err)
	}
	for _, dk := range wantDedupKeys {
		if _, ok := memoMap[dk]; !ok {
			t.Fatalf("expected dedup_key %q persisted in memo_json, got keys=%v", dk, memoMap)
		}
		if _, ok, err := st.GetTaskByDedupKey(ctx, taskRes.Task.ID, dk); err != nil || !ok {
			t.Fatalf("expected child durable_task with dedup_key %q, ok=%v err=%v", dk, ok, err)
		}
	}

	var res durable.CodeModeResult
	if err := json.Unmarshal(done.ResultJSON, &res); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if res.ReplayedCalls != 3 || res.ReplayedSleeps != 1 {
		t.Fatalf("expected ReplayedCalls=3 ReplayedSleeps=1, got %+v", res)
	}

	valMap, ok := res.Value.(map[string]any)
	if !ok {
		t.Fatalf("expected object result, got %T", res.Value)
	}
	if int64(valMap["t0"].(float64)) != recordedFirstT0.Load() {
		t.Fatalf("Date.now() drifted across crash replay: before=%d after=%v", recordedFirstT0.Load(), valMap["t0"])
	}
	if int64(valMap["d0"].(float64)) != int64(valMap["t0"].(float64)) {
		t.Fatalf("new Date().getTime() (%v) != Date.now() (%v)", valMap["d0"], valMap["t0"])
	}
	if int64(valMap["t1"].(float64)) != int64(valMap["t0"].(float64))+25 {
		t.Fatalf("expected virtual clock advance by 25ms, t0=%v t1=%v", valMap["t0"], valMap["t1"])
	}
	if valMap["r0"] != recordedFirstR0.Load() {
		t.Fatalf("Math.random() drifted across crash replay: before=%v after=%v", recordedFirstR0.Load(), valMap["r0"])
	}
	if valMap["total"] != float64(125) || valMap["committed"] != true {
		t.Fatalf("unexpected computation result: %+v", valMap)
	}
	t.Logf("replay finished in %v (step1 & step2 fast-forwarded in ~0ms)", replayElapsed)

	// Re-running the exact same script with the same Seed & StartTimeMs must produce identical randoms & timestamps.
	done2, err := sched2.StartTask(ctx, store.Task{
		ID:        "cm-goja-2",
		Kind:      durable.TaskKindCodeMode,
		PhaseName: durable.PhaseCodeExec,
		CheckpointJSON: mustJSON(durable.CodeModeSpec{
			Script:      `return { t: Date.now(), iso: new Date().toISOString(), r: [Math.random(), Math.random(), Math.random()] };`,
			Seed:        1337,
			StartTimeMs: 1_750_000_000_000,
		}),
	})
	if err != nil {
		t.Fatalf("StartTask pure: %v", err)
	}
	pure1, err := sched2.WaitTask(ctx, done2.Task.ID)
	if err != nil || pure1.TerminalReason != store.ReasonCompleted {
		t.Fatalf("pure1 failed: %+v err=%v", pure1, err)
	}
	done3, err := sched2.StartTask(ctx, store.Task{
		ID:        "cm-goja-3",
		Kind:      durable.TaskKindCodeMode,
		PhaseName: durable.PhaseCodeExec,
		CheckpointJSON: mustJSON(durable.CodeModeSpec{
			Script:      `return { t: Date.now(), iso: new Date().toISOString(), r: [Math.random(), Math.random(), Math.random()] };`,
			Seed:        1337,
			StartTimeMs: 1_750_000_000_000,
		}),
	})
	if err != nil {
		t.Fatalf("StartTask pure2: %v", err)
	}
	pure2, err := sched2.WaitTask(ctx, done3.Task.ID)
	if err != nil || pure2.TerminalReason != store.ReasonCompleted {
		t.Fatalf("pure2 failed: %+v err=%v", pure2, err)
	}
	var r1, r2 durable.CodeModeResult
	_ = json.Unmarshal(pure1.ResultJSON, &r1)
	_ = json.Unmarshal(pure2.ResultJSON, &r2)
	b1, _ := json.Marshal(r1.Value)
	b2, _ := json.Marshal(r2.Value)
	if string(b1) != string(b2) {
		t.Fatalf("expected identical deterministic Date/Math.random outputs, got %s vs %s", string(b1), string(b2))
	}
}

func TestCodeModeGojaZeroMsFastForwardFromMemo(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	dbPath := filepath.Join(t.TempDir(), "codemode-ff.db")
	st, err := store.OpenSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	defer func() { _ = st.Close() }()

	var slowCalls atomic.Int32
	var finalCalls atomic.Int32
	finalBlock := make(chan struct{})
	finalEntered := make(chan struct{})

	toolFn := func(tctx context.Context, name string, args any) (any, error) {
		if name == "slow_op" {
			slowCalls.Add(1)
			time.Sleep(120 * time.Millisecond)
			return args, nil
		}
		if name == "final_op" {
			if finalCalls.Add(1) == 1 {
				close(finalEntered)
				select {
				case <-finalBlock:
				case <-tctx.Done():
				}
				return nil, context.Canceled
			}
			return map[string]any{"done": true}, nil
		}
		return nil, durable.ErrUnknownTool
	}

	sched1 := durable.NewScheduler(st)
	durable.RegisterCodeModePhases(sched1, toolFn)

	// 3 slow calls (3 * 120ms = 360ms live) followed by final_op interrupted mid-way.
	script := `
		const a = callTool("slow_op", { step: 1 });
		const b = callTool("slow_op", { step: 2 });
		const c = callTool("slow_op", { step: 3 });
		const fin = callTool("final_op", { sum: a.step + b.step + c.step });
		return { sum: a.step + b.step + c.step, fin };
	`
	res, err := sched1.StartTask(ctx, store.Task{
		ID:             "cm-ff-1",
		Kind:           durable.TaskKindCodeMode,
		PhaseName:      durable.PhaseCodeExec,
		IsModelTask:    true,
		CheckpointJSON: mustJSON(durable.CodeModeSpec{Script: script, Seed: 7}),
	})
	if err != nil {
		t.Fatalf("StartTask: %v", err)
	}
	<-finalEntered
	sched1.Close()
	close(finalBlock)
	_ = st.SimulateCrash()

	st, err = store.OpenSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("reopen SQLite: %v", err)
	}
	defer func() { _ = st.Close() }()

	sched2 := durable.NewScheduler(st)
	defer sched2.Close()
	durable.RegisterCodeModePhases(sched2, toolFn)

	replayStart := time.Now()
	if err := sched2.Recover(ctx); err != nil {
		t.Fatalf("Recover: %v", err)
	}
	done, err := sched2.WaitTask(ctx, res.Task.ID)
	replayElapsed := time.Since(replayStart)
	if err != nil || done.TerminalReason != store.ReasonCompleted {
		t.Fatalf("expected completion, got %+v err=%v", done, err)
	}
	if slowCalls.Load() != 3 {
		t.Fatalf("expected 0 duplicate slow_op calls on replay, got total=%d", slowCalls.Load())
	}
	if replayElapsed > 250*time.Millisecond {
		t.Fatalf("expected fast-forward replay to skip 360ms of completed calls in ~0ms, took %v", replayElapsed)
	}
}

func TestCodeModeGojaGuardrailsStepQuotaTimeoutAndMemoryBounds(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	st := store.NewMemory()
	defer st.Close()
	sched := durable.NewScheduler(st)
	defer sched.Close()
	durable.RegisterCodeModePhases(sched, nil)

	cases := []struct {
		name       string
		spec       durable.CodeModeSpec
		wantReason string
		wantErrSub string
	}{
		{
			name: "while_true_empty_block_step_quota",
			spec: durable.CodeModeSpec{
				Script:   `while (true) {}`,
				MaxSteps: 40,
			},
			wantReason: store.ReasonFailed,
			wantErrSub: "step quota",
		},
		{
			name: "while_true_semicolon_step_quota",
			spec: durable.CodeModeSpec{
				Script:   `while (true);`,
				MaxSteps: 40,
			},
			wantReason: store.ReasonFailed,
			wantErrSub: "step quota",
		},
		{
			name: "try_catch_cannot_swallow_step_quota_interrupt",
			spec: durable.CodeModeSpec{
				Script:   `try { while (true) {} } catch (e) { return "escaped"; }`,
				MaxSteps: 30,
			},
			wantReason: store.ReasonFailed,
			wantErrSub: "step quota",
		},
		{
			name: "eval_while_true_step_quota",
			spec: durable.CodeModeSpec{
				Script:   `eval("while (true) {}");`,
				MaxSteps: 30,
			},
			wantReason: store.ReasonFailed,
			wantErrSub: "step quota",
		},
		{
			name: "dynamic_function_ctor_step_quota",
			spec: durable.CodeModeSpec{
				Script:   `const f = (() => {}).constructor("while (true) {}"); f();`,
				MaxSteps: 30,
			},
			wantReason: store.ReasonFailed,
			wantErrSub: "step quota",
		},
		{
			name: "watchdog_timeout_interrupts_runaway_loop",
			spec: durable.CodeModeSpec{
				Script:    `try { while (true) {} } catch (e) {}`,
				MaxSteps:  100_000_000,
				TimeoutMs: 25,
			},
			wantReason: store.ReasonFailed,
			wantErrSub: "timeout",
		},
		{
			name: "exponential_string_concat_plus_quota",
			spec: durable.CodeModeSpec{
				Script:         `let s = "x"; for (let i = 0; i < 30; i++) { s = s + s; } return s.length;`,
				MaxMemoryBytes: 64 * 1024,
				MaxStringBytes: 16 * 1024,
			},
			wantReason: store.ReasonFailed,
			wantErrSub: "quota exceeded",
		},
		{
			name: "exponential_string_plus_assign_quota",
			spec: durable.CodeModeSpec{
				Script:         `let s = "x"; for (let i = 0; i < 30; i++) { s += s; } return s.length;`,
				MaxMemoryBytes: 64 * 1024,
				MaxStringBytes: 16 * 1024,
			},
			wantReason: store.ReasonFailed,
			wantErrSub: "quota exceeded",
		},
		{
			name: "template_literal_string_growth_quota",
			spec: durable.CodeModeSpec{
				Script:         `let s = "x"; for (let i = 0; i < 30; i++) { s = ` + "`${s}${s}`" + `; } return s.length;`,
				MaxMemoryBytes: 64 * 1024,
				MaxStringBytes: 16 * 1024,
			},
			wantReason: store.ReasonFailed,
			wantErrSub: "quota exceeded",
		},
		{
			name: "string_repeat_oom_blocked_prealloc",
			spec: durable.CodeModeSpec{
				Script:         `return "x".repeat(1000000000);`,
				MaxMemoryBytes: 64 * 1024,
				MaxStringBytes: 16 * 1024,
			},
			wantReason: store.ReasonFailed,
			wantErrSub: "quota",
		},
		{
			name: "string_pad_start_oom_blocked_prealloc",
			spec: durable.CodeModeSpec{
				Script:         `return "x".padStart(1000000000, "a");`,
				MaxMemoryBytes: 64 * 1024,
				MaxStringBytes: 16 * 1024,
			},
			wantReason: store.ReasonFailed,
			wantErrSub: "quota",
		},
		{
			name: "array_join_sparse_oom_blocked",
			spec: durable.CodeModeSpec{
				Script:         `return new Array(1000000000).join("a");`,
				MaxMemoryBytes: 64 * 1024,
				MaxStringBytes: 16 * 1024,
			},
			wantReason: store.ReasonFailed,
			wantErrSub: "quota",
		},
		{
			name: "array_buffer_allocation_bound",
			spec: durable.CodeModeSpec{
				Script:         `const b = new ArrayBuffer(1000000000); return b.byteLength;`,
				MaxMemoryBytes: 64 * 1024,
			},
			wantReason: store.ReasonFailed,
			wantErrSub: "quota",
		},
		{
			name: "uint8_array_allocation_bound",
			spec: durable.CodeModeSpec{
				Script:         `const u = new Uint8Array(1000000000); return u.length;`,
				MaxMemoryBytes: 64 * 1024,
			},
			wantReason: store.ReasonFailed,
			wantErrSub: "quota",
		},
		{
			name: "stack_overflow_bounded",
			spec: durable.CodeModeSpec{
				Script:   `function f() { return f() + 1; } return f();`,
				MaxSteps: 100_000,
			},
			wantReason: store.ReasonFailed,
			wantErrSub: "quota",
		},
		{
			name: "output_size_bound",
			spec: durable.CodeModeSpec{
				Script:         `return { s: "a".repeat(2048) };`,
				MaxOutputBytes: 512,
			},
			wantReason: store.ReasonFailed,
			wantErrSub: "quota",
		},
		{
			name: "var_limit_declared_bound",
			spec: durable.CodeModeSpec{
				Script:  `let a = 1; let b = 2; let c = 3; return a + b + c;`,
				MaxVars: 2,
			},
			wantReason: store.ReasonFailed,
			wantErrSub: "variable limit",
		},
		{
			name: "var_limit_dynamic_global_bound",
			spec: durable.CodeModeSpec{
				Script:  `for (let i = 0; i < 100; i++) { globalThis["k" + i] = i; }`,
				MaxVars: 10,
			},
			wantReason: store.ReasonFailed,
			wantErrSub: "variable limit",
		},
		{
			name: "syntax_error_cleanly_reported",
			spec: durable.CodeModeSpec{
				Script: `let x = ;`,
			},
			wantReason: store.ReasonFailed,
			wantErrSub: "syntax",
		},
	}

	baseGoroutines := runtime.NumGoroutine()

	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			id := "guard-" + tc.name
			res, err := sched.StartTask(ctx, store.Task{
				ID:             id,
				Kind:           durable.TaskKindCodeMode,
				PhaseName:      durable.PhaseCodeExec,
				CheckpointJSON: mustJSON(tc.spec),
			})
			if err != nil {
				t.Fatalf("StartTask %d: %v", i, err)
			}
			done, err := sched.WaitTask(ctx, res.Task.ID)
			if err != nil {
				t.Fatalf("WaitTask: %v", err)
			}
			if done.TerminalReason != tc.wantReason {
				t.Fatalf("expected %s, got %+v", tc.wantReason, done)
			}
			if !strings.Contains(strings.ToLower(done.ErrorText), tc.wantErrSub) {
				t.Fatalf("expected error containing %q, got %q", tc.wantErrSub, done.ErrorText)
			}
		})
	}

	// Ensure watchdog / interrupt executions leaked zero goroutines.
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if runtime.NumGoroutine()-baseGoroutines <= 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if diff := runtime.NumGoroutine() - baseGoroutines; diff > 3 {
		t.Fatalf("goroutine leak after guardrail interruptions: delta=%d", diff)
	}
}

func TestCodeModeGojaToolErrorsAndZeroSleep(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	st := store.NewMemory()
	defer st.Close()
	sched := durable.NewScheduler(st)
	defer sched.Close()

	var failCalls atomic.Int32
	var okCalls atomic.Int32
	durable.RegisterCodeModePhases(sched, func(_ context.Context, name string, args any) (any, error) {
		switch name {
		case "flaky":
			failCalls.Add(1)
			return nil, errors.New("tool exploded")
		case "ok_tool":
			okCalls.Add(1)
			return map[string]any{"args": args, "status": "ok"}, nil
		default:
			return nil, durable.ErrUnknownTool
		}
	})

	// Caught tool error is deterministically memoized and replayed without re-calling flaky tool;
	// zero-duration sleep wakes immediately.
	t1, err := sched.StartTask(ctx, store.Task{
		ID:        "cm-caught-err",
		Kind:      durable.TaskKindCodeMode,
		PhaseName: durable.PhaseCodeExec,
		CheckpointJSON: mustJSON(durable.CodeModeSpec{
			Script: `
				let caught = "";
				try {
					vibe.call("flaky", { n: 1 });
				} catch (e) {
					caught = e.message;
				}
				sleep(0);
				const ok = callTool("ok_tool", { caught });
				return { caught, ok };
			`,
		}),
	})
	if err != nil {
		t.Fatalf("StartTask caught: %v", err)
	}
	done1, err := sched.WaitTask(ctx, t1.Task.ID)
	if err != nil || done1.TerminalReason != store.ReasonCompleted {
		t.Fatalf("expected caught error script to complete, got %+v err=%v", done1, err)
	}
	if failCalls.Load() != 1 || okCalls.Load() != 1 {
		t.Fatalf("expected flaky=1 ok_tool=1, got flaky=%d ok=%d", failCalls.Load(), okCalls.Load())
	}
	var res1 durable.CodeModeResult
	if err := json.Unmarshal(done1.ResultJSON, &res1); err != nil {
		t.Fatalf("unmarshal res1: %v", err)
	}
	if res1.ReplayedCalls != 2 || res1.ReplayedSleeps != 1 {
		t.Fatalf("expected ReplayedCalls=2 ReplayedSleeps=1, got %+v", res1)
	}

	// Uncaught tool error fails the CodeMode task cleanly.
	t2, err := sched.StartTask(ctx, store.Task{
		ID:        "cm-uncaught-err",
		Kind:      durable.TaskKindCodeMode,
		PhaseName: durable.PhaseCodeExec,
		CheckpointJSON: mustJSON(durable.CodeModeSpec{
			Script: `callTool("flaky", {});`,
		}),
	})
	if err != nil {
		t.Fatalf("StartTask uncaught: %v", err)
	}
	done2, err := sched.WaitTask(ctx, t2.Task.ID)
	if err != nil {
		t.Fatalf("WaitTask uncaught: %v", err)
	}
	if done2.TerminalReason != store.ReasonFailed || !strings.Contains(done2.ErrorText, "tool exploded") {
		t.Fatalf("expected failed task containing 'tool exploded', got %+v", done2)
	}
}
