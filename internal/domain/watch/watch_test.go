package watch_test

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/domain/channel"
	"github.com/vibevalleyhq/vibevalley/internal/domain/watch"
	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

type fixedClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFixedClock() *fixedClock {
	return &fixedClock{now: time.Unix(1_700_000_000, 0).UTC()}
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

func TestWatchRestartIdempotencyZeroDoubleDispatch(t *testing.T) {
	ctx := context.Background()
	tmpDir := t.TempDir()
	chanDB := filepath.Join(tmpDir, "channel.db")
	watchDB := filepath.Join(tmpDir, "watch.db")
	durableDB := filepath.Join(tmpDir, "durable.db")
	clk := newFixedClock()

	chStore, err := channel.OpenSQLite(ctx, chanDB, channel.WithClock(clk))
	if err != nil {
		t.Fatalf("open channel sqlite: %v", err)
	}
	durStore, err := store.OpenSQLite(ctx, durableDB)
	if err != nil {
		t.Fatalf("open durable sqlite: %v", err)
	}

	if _, err := chStore.CreateChannel(ctx, channel.Channel{
		ID:             "general",
		Type:           channel.TypePublic,
		Name:           "general",
		DefaultAgentID: "orchestrator",
	}); err != nil {
		t.Fatal(err)
	}
	if err := chStore.AddMember(ctx, "general", "orchestrator"); err != nil {
		t.Fatal(err)
	}
	if _, err := durStore.CreateConversation(ctx, store.Conversation{
		ID:               "conv-orch",
		ProviderAffinity: "anthropic:claude-sonnet",
	}); err != nil {
		t.Fatal(err)
	}

	var freshDispatches atomic.Int32
	var seenRequestIDs []string
	var seenMu sync.Mutex

	errInjectedCrash := errors.New("simulated crash before cursor advance")
	crashOnFirst := true

	dispatcher := &watch.DurableDispatcher{
		Store: durStore,
		OnDispatched: func(_ context.Context, req watch.DispatchRequest, _ store.Submission) error {
			freshDispatches.Add(1)
			seenMu.Lock()
			seenRequestIDs = append(seenRequestIDs, req.RequestID)
			seenMu.Unlock()
			return nil
		},
	}

	w1, err := watch.OpenSQLiteService(ctx, chStore, watchDB,
		watch.WithClock(clk),
		watch.WithDispatcher(dispatcher),
		watch.WithCursorHook(func(_ channel.Event) error {
			if crashOnFirst {
				crashOnFirst = false
				return errInjectedCrash
			}
			return nil
		}),
	)
	if err != nil {
		t.Fatal(err)
	}

	if err := w1.SeatAgent(ctx, watch.Seat{
		ChannelID:      "general",
		AgentID:        "orchestrator",
		Role:           channel.RoleOrchestrator,
		ConversationID: "conv-orch",
		SessionID:      "sess-orch",
	}); err != nil {
		t.Fatal(err)
	}

	// User posts event seq 1 -> triggers dispatch, then crashes BEFORE cursor advances!
	res, err := chStore.PostMessage(ctx, "general", "user", channel.ActorUser, "Build the Go backend")
	if err != nil {
		t.Fatal(err)
	}
	expectedReqID := fmt.Sprintf("chan_evt:%s:%d", res.Event.ChannelID, res.Event.Seq)

	if _, err := w1.Pump(ctx); !errors.Is(err, errInjectedCrash) {
		t.Fatalf("expected simulated crash error, got %v", err)
	}
	if cur, err := w1.Cursor(ctx); err != nil || cur != 0 {
		t.Fatalf("cursor must remain at 0 after pre-commit crash, got %d err=%v", cur, err)
	}
	if freshDispatches.Load() != 1 {
		t.Fatalf("expected 1 fresh dispatch before crash, got %d", freshDispatches.Load())
	}

	// Simulate process restart by closing and reopening ALL stores from SQLite!
	_ = w1.Close()
	_ = durStore.Close()
	_ = chStore.Close()

	chStore2, err := channel.OpenSQLite(ctx, chanDB, channel.WithClock(clk))
	if err != nil {
		t.Fatal(err)
	}
	defer chStore2.Close()
	durStore2, err := store.OpenSQLite(ctx, durableDB)
	if err != nil {
		t.Fatal(err)
	}
	defer durStore2.Close()

	dispatcher2 := &watch.DurableDispatcher{
		Store: durStore2,
		OnDispatched: func(_ context.Context, req watch.DispatchRequest, _ store.Submission) error {
			freshDispatches.Add(1)
			seenMu.Lock()
			seenRequestIDs = append(seenRequestIDs, req.RequestID)
			seenMu.Unlock()
			return nil
		},
	}

	w2, err := watch.OpenSQLiteService(ctx, chStore2, watchDB,
		watch.WithClock(clk),
		watch.WithDispatcher(dispatcher2),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer w2.Close()

	// Replay from uncommitted cursor 0: MUST deduplicate against durable_submission and dispatch 0 duplicates!
	outcomes, err := w2.Pump(ctx)
	if err != nil {
		t.Fatalf("post-restart Pump failed: %v", err)
	}
	if len(outcomes) != 1 || len(outcomes[0].Dispatched) != 1 || !outcomes[0].Dispatched[0].Deduplicated {
		t.Fatalf("expected deduplicated replay outcome, got %+v", outcomes)
	}
	if freshDispatches.Load() != 1 {
		t.Fatalf("restart caused duplicate dispatch! total freshDispatches=%d", freshDispatches.Load())
	}
	if cur, err := w2.Cursor(ctx); err != nil || cur != res.Event.GlobalSeq {
		t.Fatalf("expected cursor to advance to %d after recovery, got %d err=%v", res.Event.GlobalSeq, cur, err)
	}

	seenMu.Lock()
	defer seenMu.Unlock()
	if len(seenRequestIDs) != 1 || seenRequestIDs[0] != expectedReqID {
		t.Fatalf("expected single requestId %q, got %v", expectedReqID, seenRequestIDs)
	}

	// Verify durable_submission has exact requestId.
	sub, err := durStore2.GetSubmissionByRequestID(ctx, "conv-orch", expectedReqID)
	if err != nil || sub.RequestID != expectedReqID {
		t.Fatalf("GetSubmissionByRequestID(%s): sub=%+v err=%v", expectedReqID, sub, err)
	}
}

func TestWatchThreeWakeupBrakes(t *testing.T) {
	ctx := context.Background()

	t.Run("1_max_consecutive_agent_turns_and_user_reset", func(t *testing.T) {
		clk := newFixedClock()
		ch := channel.NewMemoryStore(channel.WithClock(clk))
		defer ch.Close()

		var dispatchCount atomic.Int32
		w := watch.NewMemoryService(ch,
			watch.WithClock(clk),
			watch.WithBrakeConfig(watch.BrakeConfig{
				MaxConsecutiveAgentTurns:       4,
				CooldownWindow:                 10 * time.Second,
				OrchestratorExemptFromCooldown: false,
			}),
			watch.WithDispatcher(watch.DispatcherFunc(func(_ context.Context, req watch.DispatchRequest) (watch.DispatchResult, error) {
				dispatchCount.Add(1)
				return watch.DispatchResult{SubmissionID: req.RequestID}, nil
			})),
		)
		defer w.Close()

		_, _ = ch.CreateChannel(ctx, channel.Channel{ID: "th-1", Type: channel.TypeThread, Name: "Thread 1"})
		_ = w.SeatAgent(ctx, watch.Seat{ChannelID: "th-1", AgentID: "agent-a", Role: channel.RoleWorker, ThreadOwner: true})
		_ = w.SeatAgent(ctx, watch.Seat{ChannelID: "th-1", AgentID: "agent-b", Role: channel.RoleWorker, ThreadOwner: true})

		// 4 consecutive agent turns alternating every 15s (past 10s cooldown) must succeed.
		for i := range 4 {
			sender := "agent-a"
			target := "agent-b"
			if i%2 == 1 {
				sender = "agent-b"
				target = "agent-a"
			}
			_, _ = ch.PostMessage(ctx, "th-1", sender, channel.ActorAgent, "ping", target)
			if _, err := w.Pump(ctx); err != nil {
				t.Fatal(err)
			}
			clk.Advance(15 * time.Second)
		}
		if dispatchCount.Load() != 4 {
			t.Fatalf("expected 4 allowed agent wakes, dispatches=%d", dispatchCount.Load())
		}

		// 5th consecutive agent turn MUST be blocked by BrakeHopLimit!
		_, _ = ch.PostMessage(ctx, "th-1", "agent-a", channel.ActorAgent, "ping 5", "agent-b")
		clk.Advance(15 * time.Second)
		out5, err := w.Pump(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if len(out5) != 1 || len(out5[0].Decisions) != 1 || out5[0].Decisions[0].Allowed || out5[0].Decisions[0].Brake != watch.BrakeHopLimit {
			t.Fatalf("expected BrakeHopLimit on 5th consecutive turn, got %+v", out5)
		}
		if dispatchCount.Load() != 4 {
			t.Fatalf("expected dispatchCount still 4, got %d", dispatchCount.Load())
		}

		// User message resets consecutive agent turns counter!
		_, _ = ch.PostMessage(ctx, "th-1", "user", channel.ActorUser, "continue @agent-b", "agent-b")
		if _, err := w.Pump(ctx); err != nil {
			t.Fatal(err)
		}
		if dispatchCount.Load() != 5 {
			t.Fatalf("expected user message to bypass & reset hop count (dispatch 5), got %d", dispatchCount.Load())
		}

		// Agent turns can now proceed again!
		clk.Advance(15 * time.Second)
		_, _ = ch.PostMessage(ctx, "th-1", "agent-b", channel.ActorAgent, "back to you", "agent-a")
		if _, err := w.Pump(ctx); err != nil {
			t.Fatal(err)
		}
		if dispatchCount.Load() != 6 {
			t.Fatalf("expected agent turn after user reset to succeed (dispatch 6), got %d", dispatchCount.Load())
		}
	})

	t.Run("2_cooldown_rate_brake", func(t *testing.T) {
		clk := newFixedClock()
		ch := channel.NewMemoryStore(channel.WithClock(clk))
		defer ch.Close()

		var dispatchCount atomic.Int32
		w := watch.NewMemoryService(ch,
			watch.WithClock(clk),
			watch.WithBrakeConfig(watch.BrakeConfig{
				MaxConsecutiveAgentTurns: 10,
				CooldownWindow:           60 * time.Second,
			}),
			watch.WithDispatcher(watch.DispatcherFunc(func(_ context.Context, req watch.DispatchRequest) (watch.DispatchResult, error) {
				dispatchCount.Add(1)
				return watch.DispatchResult{SubmissionID: req.RequestID}, nil
			})),
		)
		defer w.Close()

		_, _ = ch.CreateChannel(ctx, channel.Channel{ID: "general", Type: channel.TypePublic, Name: "general"})
		_ = w.SeatAgent(ctx, watch.Seat{ChannelID: "general", AgentID: "agent-a", Role: channel.RoleWorker})
		_ = w.SeatAgent(ctx, watch.Seat{ChannelID: "general", AgentID: "agent-b", Role: channel.RoleWorker})

		// First agent mention at t=0 -> allowed.
		_, _ = ch.PostMessage(ctx, "general", "agent-a", channel.ActorAgent, "hey @agent-b", "agent-b")
		if _, err := w.Pump(ctx); err != nil {
			t.Fatal(err)
		}
		if dispatchCount.Load() != 1 {
			t.Fatalf("expected first wake allowed")
		}

		// Second agent mention at t=20s (<60s) -> held by BrakeCooldown!
		clk.Advance(20 * time.Second)
		_, _ = ch.PostMessage(ctx, "general", "agent-a", channel.ActorAgent, "ping again @agent-b", "agent-b")
		outCool, err := w.Pump(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if len(outCool[0].Decisions) != 1 || outCool[0].Decisions[0].Allowed || outCool[0].Decisions[0].Brake != watch.BrakeCooldown {
			t.Fatalf("expected BrakeCooldown within 60s, got %+v", outCool[0].Decisions)
		}
		if dispatchCount.Load() != 1 {
			t.Fatalf("expected dispatchCount still 1")
		}

		// User message bypasses cooldown even at t=25s!
		clk.Advance(5 * time.Second)
		_, _ = ch.PostMessage(ctx, "general", "user", channel.ActorUser, "@agent-b urgent check", "agent-b")
		if _, err := w.Pump(ctx); err != nil {
			t.Fatal(err)
		}
		if dispatchCount.Load() != 2 {
			t.Fatalf("expected user message to bypass cooldown, got %d", dispatchCount.Load())
		}

		// Advance past 60s since t=0 (now t=65s) -> next agent mention succeeds!
		clk.Advance(40 * time.Second)
		_, _ = ch.PostMessage(ctx, "general", "agent-a", channel.ActorAgent, "@agent-b after cooldown", "agent-b")
		if _, err := w.Pump(ctx); err != nil {
			t.Fatal(err)
		}
		if dispatchCount.Load() != 3 {
			t.Fatalf("expected agent mention after cooldown window to succeed, got %d", dispatchCount.Load())
		}
	})

	t.Run("3_explicit_mention_and_thread_scope_gate", func(t *testing.T) {
		clk := newFixedClock()
		ch := channel.NewMemoryStore(channel.WithClock(clk))
		defer ch.Close()

		var woken []string
		w := watch.NewMemoryService(ch,
			watch.WithClock(clk),
			watch.WithDispatcher(watch.DispatcherFunc(func(_ context.Context, req watch.DispatchRequest) (watch.DispatchResult, error) {
				woken = append(woken, req.ChannelID+":"+req.RecipientID)
				return watch.DispatchResult{SubmissionID: req.RequestID}, nil
			})),
		)
		defer w.Close()

		_, _ = ch.CreateChannel(ctx, channel.Channel{ID: "general", Type: channel.TypePublic, Name: "general", DefaultAgentID: "orch"})
		_ = ch.AddMember(ctx, "general", "orch")
		_, _ = ch.CreateChannel(ctx, channel.Channel{ID: "thread-1", Type: channel.TypeThread, Name: "Issue 1", IssueID: "iss-1"})
		_, _ = ch.CreateChannel(ctx, channel.Channel{ID: "thread-2", Type: channel.TypeThread, Name: "Issue 2", IssueID: "iss-2"})

		_ = w.SeatAgent(ctx, watch.Seat{ChannelID: "general", AgentID: "orch", Role: channel.RoleOrchestrator})
		_ = w.SeatAgent(ctx, watch.Seat{ChannelID: "general", AgentID: "worker-pub", Role: channel.RoleWorker})
		_ = w.SeatAgent(ctx, watch.Seat{ChannelID: "thread-1", AgentID: "worker-t1", Role: channel.RoleWorker, ThreadOwner: true})
		_ = w.SeatAgent(ctx, watch.Seat{ChannelID: "thread-2", AgentID: "worker-t2", Role: channel.RoleWorker, ThreadOwner: true})

		// (a) Agent posting in public channel WITHOUT @mention -> gated by BrakeMentionScope!
		_, _ = ch.PostMessage(ctx, "general", "worker-pub", channel.ActorAgent, "ambient chatter with no mention")
		outA, err := w.Pump(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if len(woken) != 0 || len(outA[0].Decisions) == 0 || outA[0].Decisions[0].Brake != watch.BrakeMentionScope {
			t.Fatalf("expected BrakeMentionScope for unmentioned agent post in public channel, got %+v woken=%v", outA[0].Decisions, woken)
		}

		// (b) User posting in public channel without @mention -> wakes designated channel member (orch), gates unmentioned worker-pub!
		_, _ = ch.PostMessage(ctx, "general", "user", channel.ActorUser, "please triage")
		outB, err := w.Pump(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if len(woken) != 1 || woken[0] != "general:orch" {
			t.Fatalf("expected only designated orch woken, got %v decisions=%+v", woken, outB[0].Decisions)
		}

		// (c) Message in thread-1 mentioning worker-t2 (seated in thread-2, out of thread-1 scope) -> gated by BrakeMentionScope!
		_, _ = ch.PostMessage(ctx, "thread-1", "user", channel.ActorUser, "hey @worker-t2", "worker-t2")
		outC, err := w.Pump(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if len(outC[0].Decisions) != 1 || outC[0].Decisions[0].Allowed || outC[0].Decisions[0].Brake != watch.BrakeMentionScope {
			t.Fatalf("expected BrakeMentionScope for out-of-thread mention, got %+v", outC[0].Decisions)
		}

		// (d) Unmentioned user message in thread-1 -> wakes worker-t1 in thread-1 scope!
		_, _ = ch.PostMessage(ctx, "thread-1", "user", channel.ActorUser, "please fix test")
		if _, err := w.Pump(ctx); err != nil {
			t.Fatal(err)
		}
		if len(woken) != 2 || woken[1] != "thread-1:worker-t1" {
			t.Fatalf("expected thread-1:worker-t1 woken, got %v", woken)
		}
	})
}

func TestWatchOwnerInboxSeatsAndConcurrentRace(t *testing.T) {
	ctx := context.Background()
	clk := newFixedClock()
	ch := channel.NewMemoryStore(channel.WithClock(clk))
	defer ch.Close()

	var dispatches atomic.Int32
	w := watch.NewMemoryService(ch,
		watch.WithClock(clk),
		watch.WithSeatLimits(2, 4),
		watch.WithDispatcher(watch.DispatcherFunc(func(_ context.Context, req watch.DispatchRequest) (watch.DispatchResult, error) {
			dispatches.Add(1)
			return watch.DispatchResult{SubmissionID: req.RequestID}, nil
		})),
	)
	defer w.Close()

	_, _ = ch.CreateChannel(ctx, channel.Channel{ID: "thread-cap", Type: channel.TypeThread, Name: "Cap Thread"})
	if err := w.SeatAgent(ctx, watch.Seat{ChannelID: "thread-cap", AgentID: "w1", Role: channel.RoleWorker, ThreadOwner: true}); err != nil {
		t.Fatal(err)
	}
	if err := w.SeatAgent(ctx, watch.Seat{ChannelID: "thread-cap", AgentID: "w2", Role: channel.RoleWorker}); err != nil {
		t.Fatal(err)
	}
	// 3rd worker exceeds per-channel capacity of 2.
	if err := w.SeatAgent(ctx, watch.Seat{ChannelID: "thread-cap", AgentID: "w3", Role: channel.RoleWorker}); !errors.Is(err, watch.ErrSeatCapacityReached) {
		t.Fatalf("expected ErrSeatCapacityReached, got %v", err)
	}
	if err := w.VacateSeat(ctx, "thread-cap", "w2"); err != nil {
		t.Fatal(err)
	}
	if err := w.SeatAgent(ctx, watch.Seat{ChannelID: "thread-cap", AgentID: "w3", Role: channel.RoleWorker}); err != nil {
		t.Fatalf("expected seat available after VacateSeat, got %v", err)
	}

	// Question card and @user mention create owner InboxItemView items, resolved when user responds or reads.
	if _, err := ch.PostQuestion(ctx, "thread-cap", "w1", "sess-w1", channel.QuestionCard{
		QuestionID: "q-1",
		Prompt:     "Ship migration?",
	}, "user"); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Pump(ctx); err != nil {
		t.Fatal(err)
	}
	inbox, err := w.ListInboxItems(ctx, false)
	if err != nil || len(inbox) != 1 || inbox[0].Kind != contract.InboxMention || inbox[0].SessionID != "sess-w1" {
		t.Fatalf("expected 1 open InboxMention item, got %+v err=%v", inbox, err)
	}

	// User reply auto-resolves the open channel inbox item.
	if _, err := ch.PostMessage(ctx, "thread-cap", "user", channel.ActorUser, "Yes, ship it"); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Pump(ctx); err != nil {
		t.Fatal(err)
	}
	inboxAfter, err := w.ListInboxItems(ctx, false)
	if err != nil || len(inboxAfter) != 0 {
		t.Fatalf("expected 0 unresolved inbox items after user reply, got %+v err=%v", inboxAfter, err)
	}

	// Start reactive loop and hammer concurrently under -race.
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	if err := w.Start(runCtx); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := range 25 {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			if idx%3 == 0 {
				_, _ = ch.PostMessage(ctx, "thread-cap", "user", channel.ActorUser, fmt.Sprintf("check %d", idx))
			} else {
				_, _ = ch.PostMessage(ctx, "thread-cap", "w1", channel.ActorAgent, fmt.Sprintf("reply %d @user", idx), "user")
			}
			_, _ = w.Pump(ctx)
			_, _ = w.ListInboxItems(ctx, true)
			_, _ = w.BrakeStateSnapshot(ctx)
		}(i)
	}
	wg.Wait()
	w.Stop()
}

func TestWatchWakeBreakerTripAndUserReset(t *testing.T) {
	ctx := context.Background()
	clk := newFixedClock()
	ch := channel.NewMemoryStore(channel.WithClock(clk))
	defer ch.Close()

	var woken int
	w := watch.NewMemoryService(ch,
		watch.WithClock(clk),
		watch.WithBrakeConfig(watch.BrakeConfig{
			MaxConsecutiveAgentTurns: 10,
			CooldownWindow:           time.Second,
			WakeBreakerLimit:         3,
		}),
		watch.WithDispatcher(watch.DispatcherFunc(func(_ context.Context, req watch.DispatchRequest) (watch.DispatchResult, error) {
			woken++
			return watch.DispatchResult{SubmissionID: req.RequestID}, nil
		})),
	)
	defer w.Close()

	_, _ = ch.CreateChannel(ctx, channel.Channel{ID: "th-brk", Type: channel.TypeThread, Name: "Breaker"})
	_ = w.SeatAgent(ctx, watch.Seat{ChannelID: "th-brk", AgentID: "agent-a", Role: channel.RoleWorker, ThreadOwner: true})
	_ = w.SeatAgent(ctx, watch.Seat{ChannelID: "th-brk", AgentID: "agent-b", Role: channel.RoleWorker, ThreadOwner: true})

	for i := range 3 {
		cnt, tripped, err := w.RecordEmptyWake(ctx, "agent-b")
		if err != nil {
			t.Fatal(err)
		}
		if i == 2 && (!tripped || cnt != 3) {
			t.Fatalf("expected wake breaker trip on 3rd empty wake, got cnt=%d tripped=%v", cnt, tripped)
		}
	}

	_, _ = ch.PostMessage(ctx, "th-brk", "agent-a", channel.ActorAgent, "@agent-b wake", "agent-b")
	out, err := w.Pump(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(out[0].Decisions) != 1 || out[0].Decisions[0].Allowed || out[0].Decisions[0].Brake != watch.BrakeWakeBreaker {
		t.Fatalf("expected BrakeWakeBreaker, got %+v", out[0].Decisions)
	}
	if woken != 0 {
		t.Fatalf("expected 0 dispatches while wake breaker tripped, got %d", woken)
	}

	// User explicitly addresses agent-b -> resets breaker and wakes it.
	_, _ = ch.PostMessage(ctx, "th-brk", "user", channel.ActorUser, "@agent-b please respond", "agent-b")
	if _, err := w.Pump(ctx); err != nil {
		t.Fatal(err)
	}
	if woken != 1 {
		t.Fatalf("expected user message to reset wake breaker and dispatch, woken=%d", woken)
	}
}
