package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
)

type backendFactory struct {
	name string
	open func(t *testing.T, opts ...store.Option) (*store.Store, func(opts ...store.Option) *store.Store)
}

func allBackends(t *testing.T) []backendFactory {
	t.Helper()
	return []backendFactory{
		{
			name: "memory",
			open: func(t *testing.T, opts ...store.Option) (*store.Store, func(opts ...store.Option) *store.Store) {
				s := store.NewMemory(opts...)
				return s, nil
			},
		},
		{
			name: "sqlite-wal",
			open: func(t *testing.T, opts ...store.Option) (*store.Store, func(opts ...store.Option) *store.Store) {
				dbPath := filepath.Join(t.TempDir(), "durable.db")
				s, err := store.OpenSQLite(context.Background(), dbPath, opts...)
				if err != nil {
					t.Fatalf("OpenSQLite(%s): %v", dbPath, err)
				}
				reopen := func(reopenOpts ...store.Option) *store.Store {
					s2, err := store.OpenSQLite(context.Background(), dbPath, reopenOpts...)
					if err != nil {
						t.Fatalf("reopen OpenSQLite(%s): %v", dbPath, err)
					}
					return s2
				}
				return s, reopen
			},
		},
	}
}

func TestSQLitePragmasAndDialectPortableSchema(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "pragmas.db")
	st, err := store.OpenSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	defer st.Close()

	jm, syncMode, ok, err := st.SQLitePragmas(ctx)
	if err != nil || !ok {
		t.Fatalf("SQLitePragmas: ok=%v err=%v", ok, err)
	}
	if jm != "wal" {
		t.Fatalf("expected journal_mode=wal, got %q", jm)
	}
	if syncMode != 1 { // synchronous=NORMAL is 1 in SQLite
		t.Fatalf("expected synchronous=1 (NORMAL), got %d", syncMode)
	}

	forbiddenJSONOps := []string{"json_extract", "json_set", "json_replace", "json_patch", "->>", "#>>"}
	for _, ddl := range store.SchemaDDL {
		lower := strings.ToLower(ddl)
		for _, op := range forbiddenJSONOps {
			if strings.Contains(lower, op) {
				t.Fatalf("schema DDL contains dialect-specific JSON operator %q: %s", op, ddl)
			}
		}
	}
}

func TestStoreParityConversationForkCompactionAndReset(t *testing.T) {
	ctx := context.Background()
	for _, bf := range allBackends(t) {
		t.Run(bf.name, func(t *testing.T) {
			clk := store.NewFakeClock(time.Unix(1_700_000_000, 0))
			st, reopen := bf.open(t, store.WithClock(clk))
			defer func() { _ = st.Close() }()

			conv, err := st.CreateConversation(ctx, store.Conversation{
				ID:               "conv-root",
				ProviderAffinity: "anthropic:claude-sonnet-4:key1",
			})
			if err != nil {
				t.Fatalf("CreateConversation: %v", err)
			}
			if conv.HeadSeq != 1 || conv.NextSeq != 1 || conv.ProviderAffinity != "anthropic:claude-sonnet-4:key1" {
				t.Fatalf("unexpected conv defaults: %+v", conv)
			}

			kinds := []string{
				store.EntrySystem,
				store.EntryUser,
				store.EntryAssistant,
				store.EntryToolResult,
				store.EntryUser,
				store.EntryAssistant,
				"pi.custom_note",
			}
			for i, kind := range kinds {
				e, err := st.AppendEntry(ctx, conv.ID, kind, []byte(`{"n":`+string(rune('1'+i))+`}`))
				if err != nil {
					t.Fatalf("AppendEntry(%d): %v", i, err)
				}
				if e.Seq != int64(i+1) {
					t.Fatalf("expected seq %d, got %d", i+1, e.Seq)
				}
			}

			// Fork at seq 3 while parent continues to seq 7+.
			forked, err := st.ForkConversation(ctx, conv.ID, "conv-fork", "task-1", "", 3)
			if err != nil {
				t.Fatalf("ForkConversation: %v", err)
			}
			if forked.ProviderAffinity != conv.ProviderAffinity || forked.ForkEntrySeq != 3 || forked.NextSeq != 4 {
				t.Fatalf("unexpected forked conv: %+v", forked)
			}
			if _, err := st.AppendEntry(ctx, forked.ID, store.EntryUser, []byte(`{"text":"branch"}`)); err != nil {
				t.Fatalf("fork append: %v", err)
			}

			// Background compaction on root at cutSeq=4 while seq 5..7 are already committed.
			// First, a blocking hard compaction wins at cutSeq=5.
			resHard, err := st.CommitCompaction(ctx, store.CompactionCommit{
				ConversationID: conv.ID,
				Level:          "hard",
				BaseHeadSeq:    1,
				FromSeq:        1,
				CutSeq:         5,
				Summary:        "summary-1-5",
			})
			if err != nil {
				t.Fatalf("CommitCompaction hard: %v", err)
			}
			if !resHard.Applied || resHard.Stale || resHard.NewHeadSeq != 6 {
				t.Fatalf("unexpected hard compaction outcome: %+v", resHard)
			}

			// Concurrent slower soft compaction behind cutSeq=4 MUST be discarded as stale.
			resStale, err := st.CommitCompaction(ctx, store.CompactionCommit{
				ConversationID: conv.ID,
				Level:          "soft",
				BaseHeadSeq:    1,
				FromSeq:        1,
				CutSeq:         4,
				Summary:        "stale-summary-1-4",
			})
			if err != nil {
				t.Fatalf("CommitCompaction stale: %v", err)
			}
			if resStale.Applied || !resStale.Stale {
				t.Fatalf("expected stale compaction to be discarded, got %+v", resStale)
			}

			// Verify visible entries on root place pi.compaction before concurrent entries 6..7 and keep full immutable ledger.
			vis, err := st.GetVisibleEntries(ctx, conv.ID)
			if err != nil {
				t.Fatalf("GetVisibleEntries: %v", err)
			}
			if len(vis) != 3 {
				t.Fatalf("expected 3 visible entries (compaction + seq 6 + seq 7), got %d: %+v", len(vis), vis)
			}
			if vis[0].Kind != store.EntryCompaction || vis[1].Seq != 6 || vis[2].Seq != 7 {
				t.Fatalf("unexpected visible order: %+v", vis)
			}
			allRaw, err := st.GetEntries(ctx, conv.ID, 1)
			if err != nil || len(allRaw) != 8 {
				t.Fatalf("expected 8 immutable entries in ledger, got %d (err=%v)", len(allRaw), err)
			}

			// Verify fork still sees ancestral 1..3 + own seq 4 even after root compacted past 3!
			forkVis, err := st.GetVisibleEntries(ctx, forked.ID)
			if err != nil || len(forkVis) != 4 {
				t.Fatalf("expected 4 visible entries in fork, got %d (err=%v)", len(forkVis), err)
			}
			if forkVis[3].Seq != 4 || forkVis[3].ConversationID != forked.ID {
				t.Fatalf("unexpected fork tail entry: %+v", forkVis[3])
			}

			// Reset advances head_seq past reset marker without deleting ledger rows.
			if _, err := st.AppendReset(ctx, conv.ID, []byte(`{"reason":"fresh"}`)); err != nil {
				t.Fatalf("AppendReset: %v", err)
			}
			visAfterReset, err := st.GetVisibleEntries(ctx, conv.ID)
			if err != nil {
				t.Fatalf("GetVisibleEntries after reset: %v", err)
			}
			if len(visAfterReset) != 0 {
				t.Fatalf("expected 0 visible entries after reset, got %d", len(visAfterReset))
			}

			if reopen != nil {
				_ = st.Close()
				st = reopen(store.WithClock(clk))
				visReopened, err := st.GetVisibleEntries(ctx, forked.ID)
				if err != nil || len(visReopened) != 4 {
					t.Fatalf("reopened fork visible entries mismatch: %d (err=%v)", len(visReopened), err)
				}
			}
		})
	}
}

func TestStoreParityGroupCommitDiskBeforeVisibility(t *testing.T) {
	ctx := context.Background()
	for _, bf := range allBackends(t) {
		t.Run(bf.name, func(t *testing.T) {
			var failNextCommit atomic.Bool
			st, _ := bf.open(t, store.WithBeforeCommitHook(func() error {
				if failNextCommit.Load() {
					return errors.New("injected disk failure")
				}
				return nil
			}))
			defer func() { _ = st.Close() }()

			var mu sync.Mutex
			var observed []store.DocumentEvent
			unsub := st.SubscribeDocuments(store.DocumentObserverFunc(func(ev store.DocumentEvent) {
				mu.Lock()
				observed = append(observed, ev)
				mu.Unlock()
			}))
			defer unsub()

			// Failure during commit MUST NOT leak into reads or observer notifications.
			failNextCommit.Store(true)
			_, err := st.PutDocument(ctx, store.ScopeConversation, "c1", store.DocAgent, []byte(`{"model":"bad"}`))
			if err == nil {
				t.Fatalf("expected injected commit error")
			}
			if _, err := st.GetDocument(ctx, store.ScopeConversation, "c1", store.DocAgent); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("uncommitted doc leaked to GetDocument: err=%v", err)
			}
			mu.Lock()
			if len(observed) != 0 {
				t.Fatalf("observer notified despite failed disk commit: %+v", observed)
			}
			mu.Unlock()

			// Concurrent writes should coalesce into fewer Group Commit batches and isolate failing savepoints.
			failNextCommit.Store(false)
			const n = 20
			var wg sync.WaitGroup
			errs := make([]error, n)
			for i := range n {
				wg.Add(1)
				go func(idx int) {
					defer wg.Done()
					errs[idx] = st.Mutate(ctx, func(tx *store.Tx) error {
						if idx%5 == 0 {
							_, _ = tx.PutDocument(ctx, store.ScopeConversation, "c1", store.DocUsage, []byte(`{"should":"rollback"}`))
							return errors.New("app validation failure")
						}
						_, err := tx.PutDocument(ctx, store.ScopeConversation, "c1", store.DocUsage, []byte(`{"ok":true}`))
						return err
					})
				}(i)
			}
			wg.Wait()

			for i := range n {
				if i%5 == 0 && errs[i] == nil {
					t.Fatalf("expected savepoint failure for idx %d", i)
				}
				if i%5 != 0 && errs[i] != nil {
					t.Fatalf("valid op idx %d failed due to neighbor: %v", i, errs[i])
				}
			}
			doc, err := st.GetDocument(ctx, store.ScopeConversation, "c1", store.DocUsage)
			if err != nil {
				t.Fatalf("GetDocument DocUsage: %v", err)
			}
			if string(doc.StateJSON) != `{"ok":true}` {
				t.Fatalf("savepoint rollback leaked into DocUsage: %s", string(doc.StateJSON))
			}
			mu.Lock()
			obsCount := len(observed)
			allDurable := true
			for _, ev := range observed {
				if !ev.Durable {
					allDurable = false
				}
			}
			mu.Unlock()
			if obsCount != 16 || !allDurable {
				t.Fatalf("expected 16 durable observer events, got %d (allDurable=%v)", obsCount, allDurable)
			}
		})
	}
}

func TestStoreParityRequestIDDedupAndSubmissionSettlement(t *testing.T) {
	ctx := context.Background()
	for _, bf := range allBackends(t) {
		t.Run(bf.name, func(t *testing.T) {
			st, reopen := bf.open(t)
			defer func() { _ = st.Close() }()

			if _, err := st.CreateConversation(ctx, store.Conversation{ID: "c1", ProviderAffinity: "p1"}); err != nil {
				t.Fatalf("CreateConversation: %v", err)
			}
			parentTask, err := st.CreateTask(ctx, store.Task{ID: "parent-task", ConversationID: "c1", Kind: "orchestrator"})
			if err != nil {
				t.Fatalf("CreateTask: %v", err)
			}

			r1, err := st.Submit(ctx, store.Submission{
				ConversationID: "c1",
				RequestID:      "req-42",
				Kind:           "prompt",
				NotifyTaskID:   parentTask.Task.ID,
				PayloadJSON:    []byte(`{"prompt":"hello"}`),
			})
			if err != nil || r1.Deduplicated {
				t.Fatalf("first submit failed: r1=%+v err=%v", r1, err)
			}

			// Retry same (conversationId, requestId) before restart.
			r2, err := st.Submit(ctx, store.Submission{
				ConversationID: "c1",
				RequestID:      "req-42",
				Kind:           "prompt",
				PayloadJSON:    []byte(`{"prompt":"duplicate"}`),
			})
			if err != nil || !r2.Deduplicated || r2.Submission.ID != r1.Submission.ID {
				t.Fatalf("expected idempotent dedup, got r2=%+v err=%v", r2, err)
			}

			// Reopen SQLite and verify requestId deduplication persists across restarts.
			if reopen != nil {
				_ = st.Close()
				st = reopen()
				r3, err := st.Submit(ctx, store.Submission{
					ConversationID: "c1",
					RequestID:      "req-42",
					Kind:           "prompt",
					PayloadJSON:    []byte(`{"prompt":"after-restart"}`),
				})
				if err != nil || !r3.Deduplicated || r3.Submission.ID != r1.Submission.ID {
					t.Fatalf("expected post-restart dedup, got r3=%+v err=%v", r3, err)
				}
			}

			// Settling submission must atomically deliver pi.submission_settled signal to NotifyTaskID.
			settled, err := st.SettleSubmission(ctx, r1.Submission.ID, store.SubmissionDone, []byte(`{"answer":42}`))
			if err != nil || settled.Status != store.SubmissionDone {
				t.Fatalf("SettleSubmission: settled=%+v err=%v", settled, err)
			}
			sigs, err := st.ListSignals(ctx, parentTask.Task.ID, false)
			if err != nil || len(sigs) != 1 {
				t.Fatalf("expected 1 submission_settled signal, got %d (err=%v)", len(sigs), err)
			}
			if sigs[0].SignalName != store.SignalSubmissionSettled {
				t.Fatalf("unexpected signal name: %+v", sigs[0])
			}
		})
	}
}

func TestStoreParityDeferredLiveCoalescingAndCrashRecovery(t *testing.T) {
	ctx := context.Background()
	for _, bf := range allBackends(t) {
		t.Run(bf.name, func(t *testing.T) {
			clk := store.NewFakeClock(time.Unix(1_700_000_000, 0))
			st, reopen := bf.open(t, store.WithClock(clk))
			defer func() { _ = st.Close() }()

			// Non-pi.live MUST reject deferred writes.
			if err := st.PutDocumentDeferred(ctx, store.ScopeConversation, "c1", store.DocUsage, []byte(`{}`)); !errors.Is(err, store.ErrDeferredOnlyForLive) {
				t.Fatalf("expected ErrDeferredOnlyForLive, got %v", err)
			}

			// Wait: seed AFTER subscribing so we observe the seed durable event, and never hold mu across t.Fatalf!
			var mu sync.Mutex
			var memEvents, diskEvents []store.DocumentEvent
			st.SubscribeDocuments(store.DocumentObserverFunc(func(ev store.DocumentEvent) {
				if ev.DocKind != store.DocLive {
					return
				}
				mu.Lock()
				if ev.Durable {
					diskEvents = append(diskEvents, ev)
				} else {
					memEvents = append(memEvents, ev)
				}
				mu.Unlock()
			}))

			// Seed initial durable pi.live baseline on disk.
			if _, err := st.PutDocument(ctx, store.ScopeConversation, "c1", store.DocLive, []byte(`{"text":"seed"}`)); err != nil {
				t.Fatalf("seed pi.live: %v", err)
			}

			// Write 10 streaming chunks within 50ms -> zero memory pushes or disk commits yet.
			for i := 1; i <= 10; i++ {
				payload, _ := json.Marshal(map[string]int{"chunk": i})
				if err := st.PutDocumentDeferred(ctx, store.ScopeConversation, "c1", store.DocLive, payload); err != nil {
					t.Fatalf("PutDocumentDeferred(%d): %v", i, err)
				}
				clk.Advance(5 * time.Millisecond)
			}

			mu.Lock()
			earlyMem, earlyDisk := len(memEvents), len(diskEvents)
			mu.Unlock()
			if earlyMem != 0 || earlyDisk != 1 { // 1 = initial seed
				t.Fatalf("unexpected early notifications: mem=%d disk=%d", earlyMem, earlyDisk)
			}

			// Advance past 100ms -> 1 coalesced memory view event, still only seed on disk!
			clk.Advance(60 * time.Millisecond) // total 110ms
			mu.Lock()
			memSnap := slices.Clone(memEvents)
			diskCountAfter100 := len(diskEvents)
			mu.Unlock()
			if len(memSnap) != 1 || string(memSnap[0].StateJSON) != `{"chunk":10}` {
				t.Fatalf("expected 1 coalesced memory event with chunk 10, got %+v", memSnap)
			}
			if diskCountAfter100 != 1 {
				t.Fatalf("expected no deferred disk flush before 1000ms, got %d", diskCountAfter100)
			}

			liveDoc, err := st.GetLiveDocument(ctx, store.ScopeConversation, "c1")
			if err != nil || string(liveDoc.StateJSON) != `{"chunk":10}` {
				t.Fatalf("GetLiveDocument mismatch: %+v err=%v", liveDoc, err)
			}
			diskDoc, err := st.GetDocument(ctx, store.ScopeConversation, "c1", store.DocLive)
			if err != nil || string(diskDoc.StateJSON) != `{"text":"seed"}` {
				t.Fatalf("disk pi.live should still be seed before 1000ms: %+v err=%v", diskDoc, err)
			}

			// Crash before 1000ms on SQLite -> reopened DB recovers ONLY the seed.
			if reopen != nil {
				_ = st.SimulateCrash()
				st = reopen(store.WithClock(clk))
				recovered, err := st.GetDocument(ctx, store.ScopeConversation, "c1", store.DocLive)
				if err != nil || string(recovered.StateJSON) != `{"text":"seed"}` {
					t.Fatalf("post-crash pre-1000ms disk doc mismatch: %+v err=%v", recovered, err)
				}

				// Re-subscribe and write streaming chunks, advance 1000ms -> 1 coalesced disk flush -> crash -> recover!
				var flushedCount atomic.Int32
				st.SubscribeDocuments(store.DocumentObserverFunc(func(ev store.DocumentEvent) {
					if ev.DocKind == store.DocLive && ev.Durable {
						flushedCount.Add(1)
					}
				}))
				for i := 1; i <= 5; i++ {
					payload, _ := json.Marshal(map[string]int{"recoveredChunk": i})
					if err := st.PutDocumentDeferred(ctx, store.ScopeConversation, "c1", store.DocLive, payload); err != nil {
						t.Fatalf("PutDocumentDeferred post-reopen(%d): %v", i, err)
					}
				}
				clk.Advance(1000 * time.Millisecond)
				if flushedCount.Load() != 1 {
					t.Fatalf("expected 1 coalesced disk flush at 1000ms, got %d", flushedCount.Load())
				}

				// Crash after 1000ms flush -> reopen MUST recover chunk 5!
				_ = st.SimulateCrash()
				st = reopen(store.WithClock(clk))
				recovered2, err := st.GetDocument(ctx, store.ScopeConversation, "c1", store.DocLive)
				if err != nil || string(recovered2.StateJSON) != `{"recoveredChunk":5}` {
					t.Fatalf("expected recoveredChunk=5 after 1000ms flush crash, got %+v err=%v", recovered2, err)
				}
			} else {
				// Memory backend: advance remaining 890ms -> coalesced disk flush fires at 1000ms.
				clk.Advance(890 * time.Millisecond)
				mu.Lock()
				diskLen := len(diskEvents)
				lastDisk := diskEvents[len(diskEvents)-1]
				mu.Unlock()
				if diskLen != 2 || string(lastDisk.StateJSON) != `{"chunk":10}` {
					t.Fatalf("expected coalesced disk commit at 1000ms, diskLen=%d last=%+v", diskLen, lastDisk)
				}
			}
		})
	}
}

func TestStoreParityEarlySignalsAndTaskDedup(t *testing.T) {
	ctx := context.Background()
	for _, bf := range allBackends(t) {
		t.Run(bf.name, func(t *testing.T) {
			st, _ := bf.open(t)
			defer func() { _ = st.Close() }()

			// Task dedup by (owner_task_id, dedup_key).
			t1, err := st.CreateTask(ctx, store.Task{OwnerTaskID: "root", DedupKey: "step:1", Kind: "tool"})
			if err != nil || t1.Deduplicated {
				t.Fatalf("CreateTask t1: %+v err=%v", t1, err)
			}
			t1Dup, err := st.CreateTask(ctx, store.Task{OwnerTaskID: "root", DedupKey: "step:1", Kind: "tool"})
			if err != nil || !t1Dup.Deduplicated || t1Dup.Task.ID != t1.Task.ID {
				t.Fatalf("expected task dedup, got %+v err=%v", t1Dup, err)
			}

			// Early signals delivered twice with same signal_key -> deduplicate & exact-once consume.
			s1, err := st.SendSignal(ctx, store.Signal{
				TaskID:      t1.Task.ID,
				SignalName:  "approval",
				SignalKey:   "k-1",
				PayloadJSON: []byte(`{"approved":true}`),
			})
			if err != nil || s1.Deduplicated {
				t.Fatalf("SendSignal s1: %+v err=%v", s1, err)
			}
			s1Dup, err := st.SendSignal(ctx, store.Signal{
				TaskID:      t1.Task.ID,
				SignalName:  "approval",
				SignalKey:   "k-1",
				PayloadJSON: []byte(`{"approved":false}`),
			})
			if err != nil || !s1Dup.Deduplicated || s1Dup.Signal.ID != s1.Signal.ID {
				t.Fatalf("expected signal dedup, got %+v err=%v", s1Dup, err)
			}
			// Second distinct signal on same signalName.
			_, err = st.SendSignal(ctx, store.Signal{
				TaskID:      t1.Task.ID,
				SignalName:  "approval",
				SignalKey:   "k-2",
				PayloadJSON: []byte(`{"seq":2}`),
			})
			if err != nil {
				t.Fatalf("SendSignal s2: %v", err)
			}

			// Exact-once FIFO consumption inside atomic tx.
			var popped []string
			for range 3 {
				if err := st.Mutate(ctx, func(tx *store.Tx) error {
					sig, ok, err := tx.ConsumeFirstSignal(ctx, t1.Task.ID, "approval")
					if err != nil {
						return err
					}
					if ok {
						popped = append(popped, sig.SignalKey)
					}
					return nil
				}); err != nil {
					t.Fatalf("Mutate consume: %v", err)
				}
			}
			if !slices.Equal(popped, []string{"k-1", "k-2"}) {
				t.Fatalf("expected FIFO exact-once [k-1, k-2], got %v", popped)
			}
		})
	}
}
