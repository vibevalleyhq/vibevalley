package game_test

import (
	"context"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/domain/game"
	"github.com/vibevalleyhq/vibevalley/internal/durable"
	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/delta"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/watch"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

func TestSpaceViewProjectorChordDeltaPushAndDurableObserver(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	proj, err := game.NewProjector()
	if err != nil {
		t.Fatal(err)
	}

	// Document implements watch.RawSource for Chord Link transport.
	var _ watch.RawSource = proj.Document()

	events := make(chan watch.Event[contract.SpaceView], 16)
	handle, err := proj.Watch(ctx, func(_ context.Context, ev watch.Event[contract.SpaceView]) {
		events <- ev
	})
	if err != nil {
		t.Fatal(err)
	}
	defer handle.Stop()

	// Initial snapshot at rev 1.
	ev1 := <-events
	if ev1.Rev != 1 || ev1.Value.Rev != 1 {
		t.Fatalf("expected initial rev 1, got ev=%+v", ev1)
	}

	// 1. Append an issue -> emits incremental splice delta (NOT root replace!).
	if _, err := proj.UpsertIssue(contract.IssueView{
		ID:          "iss-1",
		Title:       "Wire SpaceView projector",
		Status:      contract.IssueQueued,
		RepoID:      "repo-1",
		UpdatedAtMs: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	ev2 := <-events
	if ev2.Rev != 2 || ev2.Value.Rev != 2 || len(ev2.Value.Issues) != 1 || ev2.Value.Issues[0].Status != contract.IssueQueued {
		t.Fatalf("unexpected rev 2 event: %+v", ev2)
	}
	for _, op := range ev2.Ops {
		if op.Kind == delta.OpReplace && len(op.Path) == 0 {
			t.Fatalf("expected incremental delta ops, got root replace: %#v", ev2.Ops)
		}
	}

	// 2. Update issue status + project online machines + dream proposal + approval + inbox.
	if _, err := proj.UpsertIssue(contract.IssueView{
		ID:          "iss-1",
		Title:       "Wire SpaceView projector",
		Status:      contract.IssueInProgress,
		RepoID:      "repo-1",
		SessionID:   "sess-1",
		UpdatedAtMs: 2000,
	}); err != nil {
		t.Fatal(err)
	}
	ev3 := <-events
	if ev3.Rev != 3 || ev3.Value.Issues[0].Status != contract.IssueInProgress {
		t.Fatalf("unexpected rev 3 event: %+v", ev3)
	}

	if _, err := proj.SetMachineOnline("mac-studio-1", true); err != nil {
		t.Fatal(err)
	}
	ev4 := <-events
	if ev4.Rev != 4 || !slices.Equal(ev4.Value.OnlineMachines, []string{"mac-studio-1"}) {
		t.Fatalf("unexpected rev 4 machines: %+v", ev4)
	}

	if _, err := proj.UpsertDream(contract.DreamProposalView{
		ProposalID:        "dream-1",
		BaseVersion:       1,
		CandidateVersion:  2,
		DeduplicatedCount: 12,
		Summary:           "Merged duplicate auth rules",
		Status:            "pending",
		CreatedAtMs:       2500,
	}); err != nil {
		t.Fatal(err)
	}
	ev5 := <-events
	if ev5.Rev != 5 || len(ev5.Value.Dreams) != 1 || ev5.Value.Dreams[0].DeduplicatedCount != 12 {
		t.Fatalf("unexpected rev 5 dreams: %+v", ev5)
	}

	// 3. Wire durable.Store DocumentObserver for pi.live revisions and pi.inbox alerts!
	durStore := store.NewMemory()
	defer durStore.Close()
	unsub := durStore.SubscribeDocuments(proj)
	defer unsub()

	if _, err := durStore.PutDocument(ctx, store.ScopeConversation, "conv-1", store.DocLive, []byte(`{"text":"streaming"}`)); err != nil {
		t.Fatal(err)
	}
	ev6 := <-events
	if ev6.Rev != 6 || ev6.Value.Rev != 6 {
		t.Fatalf("expected live revision bump to rev 6, got %+v", ev6)
	}
	if liveMap := proj.LiveRevisions(); liveMap["conversation:conv-1:pi.live"] != 1 {
		t.Fatalf("expected tracked live revision 1, got %v", liveMap)
	}

	// Simulate PermissionEvaluator Park writing pi.inbox -> ApprovalPromptView + InboxItemView projected!
	perm := durable.NewPermissionEvaluator(durStore, durable.DefaultPermissionConfig(), nil, nil)
	if err := perm.Park(ctx, "conv-1", "task-park-1", durable.ToolCall{
		ID:       "call-1",
		ToolName: "mcp:deploy",
	}, contract.PermissionEvaluation{
		ToolName: "mcp:deploy",
		Policy:   contract.PolicyAlwaysAsk,
		Verdict:  contract.VerdictAsk,
		Reason:   "policy_always_ask",
	}); err != nil {
		t.Fatal(err)
	}
	ev7 := <-events
	if ev7.Rev != 7 || len(ev7.Value.Approvals) != 1 || ev7.Value.Approvals[0].TaskID != "task-park-1" {
		t.Fatalf("expected projected approval prompt at rev 7, got %+v", ev7)
	}
	if len(ev7.Value.Inbox) != 1 || ev7.Value.Inbox[0].Kind != contract.InboxApproval {
		t.Fatalf("expected projected InboxApproval item at rev 7, got %+v", ev7.Value.Inbox)
	}

	// Verify incremental catchup from rev 4 over WatchRaw (Chord Link reconnect parity).
	rawCh := make(chan watch.RawEvent, 4)
	rh, err := proj.Document().WatchRaw(ctx, 4, func(_ context.Context, raw watch.RawEvent) {
		rawCh <- raw
	})
	if err != nil {
		t.Fatal(err)
	}
	defer rh.Stop()

	rawCatchup := <-rawCh
	if rawCatchup.Rev != 7 {
		t.Fatalf("expected catchup to rev 7, got %d", rawCatchup.Rev)
	}
	for _, op := range rawCatchup.Ops {
		if op.Kind == delta.OpReplace && len(op.Path) == 0 {
			t.Fatalf("expected incremental fromRev catchup ops, got root replace: %#v", rawCatchup.Ops)
		}
	}

	// Concurrent mutations under -race keep Document rev == SpaceView.Rev!
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			_, _ = proj.SetMachineOnline("node-"+string(rune('a'+idx%5)), idx%2 == 0)
			_, _ = proj.UpsertInboxItem(contract.InboxItemView{
				ID:      "inb-" + string(rune('a'+idx%4)),
				Kind:    contract.InboxMention,
				Title:   "Ping",
				Summary: "Check",
			})
		}(i)
	}
	wg.Wait()

	docRev, snap := proj.Snapshot()
	if snap.Rev != docRev {
		t.Fatalf("SpaceView.Rev (%d) drifted from Document rev (%d)", snap.Rev, docRev)
	}
}

func TestGameLedgerAndCommitLevels(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "game.db")

	lvl := game.LevelForCommits(35)
	if lvl.Level != 3 || lvl.XP != 5 || lvl.Need != 30 {
		t.Fatalf("unexpected level for 35 commits (10+20+5): %+v", lvl)
	}

	ledger, err := game.OpenSQLiteLedger(ctx, dbPath)
	if err != nil {
		t.Fatal(err)
	}
	p1, err := ledger.Append(ctx, game.LedgerEntry{Kind: game.LedgerIssueMerged, IssueID: "i1", Commits: 2, CreatedAtMs: 100})
	if err != nil || p1.Coins != 40 || p1.Streak != 1 {
		t.Fatalf("expected 40 coins & streak 1, got %+v err=%v", p1, err)
	}
	p2, err := ledger.Append(ctx, game.LedgerEntry{Kind: game.LedgerWorkerFailed, SessionID: "s1", CreatedAtMs: 200})
	if err != nil || p2.Streak != 0 || p2.Coins != 40 {
		t.Fatalf("expected streak reset on failure, got %+v err=%v", p2, err)
	}
	_ = ledger.Close()

	ledger2, err := game.OpenSQLiteLedger(ctx, dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer ledger2.Close()

	reopened := ledger2.Progress()
	if reopened.Coins != 40 || reopened.Streak != 0 || reopened.MergedCount != 1 {
		t.Fatalf("reopened game ledger mismatch: %+v", reopened)
	}
}
