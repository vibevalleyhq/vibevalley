package memory

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/vibevalleyhq/vibevalley/internal/machine"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
	"github.com/vibevalleyhq/vibevalley/pkg/db"
	"github.com/vibevalleyhq/vibevalley/pkg/migrate"
)

func TestImmutableHistoryAndConflictPreservation(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	var nowMs atomic.Int64
	nowMs.Store(1700000000000)
	tick := func() int64 { return nowMs.Add(1000) }

	st, err := OpenStore(ctx, ":memory:", WithClock(tick))
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	defer st.Close()

	v1Content := []byte("# Project Facts\n- Go version: 1.27.3\n- 存储引擎: SQLite WAL\n")
	v1, err := st.CommitFiles(ctx, CommitRequest{
		ScopeID:   "agent-alpha",
		SessionID: "sess-1",
		Summary:   "initial seed",
		Files: []MemoryFileInput{
			{RelPath: "facts.md", Content: v1Content},
		},
	})
	if err != nil {
		t.Fatalf("CommitFiles v1: %v", err)
	}
	if v1.Version != 1 || v1.Status != VersionStatusActive {
		t.Fatalf("unexpected v1 metadata: %+v", v1)
	}

	v2Content := []byte("# Project Facts\n- Go version: 1.27.3\n- 存储引擎: SQLite WAL\n- Session 2 note\n")
	v2, err := st.CommitFiles(ctx, CommitRequest{
		ScopeID:         "agent-alpha",
		ExpectedVersion: 1,
		SessionID:       "sess-2",
		Summary:         "session 2 fast-forward",
		Files: []MemoryFileInput{
			{RelPath: "facts.md", BaseVersion: 1, Content: v2Content},
		},
	})
	if err != nil {
		t.Fatalf("CommitFiles v2: %v", err)
	}
	if v2.Version != 2 || v2.ParentVersion != 1 {
		t.Fatalf("unexpected v2 metadata: %+v", v2)
	}

	// Immutable history check: v1 must remain unchanged with its original content and file version.
	histV1, err := st.GetVersion(ctx, "agent-alpha", 1)
	if err != nil {
		t.Fatalf("GetVersion(1): %v", err)
	}
	if histV1.Status != VersionStatusSuperseded {
		t.Fatalf("expected v1 status superseded, got %q", histV1.Status)
	}
	f1, ok := histV1.File("facts.md")
	if !ok || !bytes.Equal(f1.Content, v1Content) || f1.Version != 1 {
		t.Fatalf("v1 mutated: ok=%v file=%+v", ok, f1)
	}

	// Stale mount edit from session 1 (baseVersion=1 while server has fileVersion=2) must preserve conflict branch.
	staleEdit := []byte("# Project Facts\n- Go version: 1.27.3\n- Conflicting offline edit from session 1\n")
	ack, conflicts, err := st.ReconcileMounts(ctx, "agent-alpha", "sess-1", []contract.MountFile{
		{
			RelPath:     ".vibe/memory/facts.md",
			BaseVersion: 1,
			Version:     2,
			SHA256:      sha256Hex(staleEdit),
			Content:     staleEdit,
		},
		{
			RelPath:     "extra.md",
			BaseVersion: 0,
			Version:     1,
			SHA256:      sha256Hex([]byte("- new extra note\n")),
			Content:     []byte("- new extra note\n"),
		},
	})
	if err != nil {
		t.Fatalf("ReconcileMounts conflict: %v", err)
	}
	if len(conflicts) != 1 || len(ack.Conflicts) != 1 {
		t.Fatalf("expected 1 conflict preserved, got conflicts=%+v ack=%+v", conflicts, ack)
	}
	if ack.AcceptedVersions["extra.md"] != 1 {
		t.Fatalf("expected extra.md accepted at file v1, got %+v", ack.AcceptedVersions)
	}
	c := conflicts[0]
	if c.BaseVersion != 1 || c.ServerVersion != 2 || !bytes.Equal(c.Content, staleEdit) {
		t.Fatalf("unexpected conflict branch: %+v", c)
	}

	// Active facts.md must NOT have been silently overwritten by staleEdit!
	active, err := st.ActiveSnapshot(ctx, "agent-alpha")
	if err != nil {
		t.Fatalf("ActiveSnapshot: %v", err)
	}
	activeFacts, ok := active.File("facts.md")
	if !ok || !bytes.Equal(activeFacts.Content, v2Content) {
		t.Fatalf("active facts.md was overwritten! got=%q want=%q", activeFacts.Content, v2Content)
	}
	if extra, ok := active.File("extra.md"); !ok || string(extra.Content) != "- new extra note\n" {
		t.Fatalf("expected extra.md committed alongside conflict preservation, got ok=%v extra=%+v", ok, extra)
	}

	// Inbox must contain an unresolved mount_conflict entry.
	inbox, err := st.ListInbox(ctx, "agent-alpha", false)
	if err != nil {
		t.Fatalf("ListInbox: %v", err)
	}
	if len(inbox) != 1 || inbox[0].Kind != contract.InboxMountConflict {
		t.Fatalf("expected 1 InboxMountConflict item, got %+v", inbox)
	}

	// Resolve conflict via merge -> creates new immutable snapshot version and resolves inbox item.
	merged := append(cloneBytes(v2Content), []byte("- Merged session 1 insight\n")...)
	resolvedSnap, err := st.ResolveConflict(ctx, c.ConflictID, ResolutionMerge, merged)
	if err != nil {
		t.Fatalf("ResolveConflict: %v", err)
	}
	if resolvedSnap.Version <= active.Version {
		t.Fatalf("expected resolved version > %d, got %d", active.Version, resolvedSnap.Version)
	}
	rf, _ := resolvedSnap.File("facts.md")
	if !bytes.Equal(rf.Content, merged) {
		t.Fatalf("merged content mismatch: got %q", rf.Content)
	}
	unresolvedAfter, _ := st.ListInbox(ctx, "agent-alpha", false)
	if len(unresolvedAfter) != 0 {
		t.Fatalf("expected conflict inbox item resolved, got %+v", unresolvedAfter)
	}
}

func TestMachineLocalEnvMountSyncEndToEndConflict(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	st, err := OpenStore(ctx, ":memory:")
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	defer st.Close()

	seed := []byte("# Shared Facts\n- Initial baseline\n")
	if _, err := st.CommitFiles(ctx, CommitRequest{
		ScopeID: DefaultScopeID,
		Files:   []MemoryFileInput{{RelPath: "shared.md", Content: seed}},
	}); err != nil {
		t.Fatalf("seed CommitFiles: %v", err)
	}

	env, err := machine.NewLocalEnv(machine.LocalEnvConfig{
		WorkDir:     t.TempDir(),
		MountRemote: st,
	})
	if err != nil {
		t.Fatalf("NewLocalEnv: %v", err)
	}
	defer env.Close()

	initialMounts, err := st.MaterializeFiles(ctx, DefaultScopeID)
	if err != nil {
		t.Fatalf("MaterializeFiles: %v", err)
	}
	if _, err := env.SyncMounts(ctx, contract.MountSyncRequest{
		SessionID: "sess-local",
		Memories:  initialMounts,
	}); err != nil {
		t.Fatalf("initial SyncMounts: %v", err)
	}

	// Simulate another session advancing server version to 2.
	serverV2 := []byte("# Shared Facts\n- Initial baseline\n- Server edit from other session\n")
	if _, err := st.CommitFiles(ctx, CommitRequest{
		ScopeID:         DefaultScopeID,
		ExpectedVersion: 1,
		SessionID:       "sess-other",
		Files:           []MemoryFileInput{{RelPath: "shared.md", BaseVersion: 1, Content: serverV2}},
	}); err != nil {
		t.Fatalf("concurrent server CommitFiles: %v", err)
	}

	// Local sandbox modifies `.vibe/memory/shared.md` concurrently and flushes.
	localEdit := []byte("# Shared Facts\n- Initial baseline\n- Local sandbox edit\n")
	if err := env.WriteAtomic(ctx, ".vibe/memory/shared.md", localEdit, 0o644); err != nil {
		t.Fatalf("local WriteAtomic: %v", err)
	}
	syncRes, err := env.SyncMounts(ctx, contract.MountSyncRequest{
		SessionID: "sess-local",
		Memories:  initialMounts,
		Flush:     true,
	})
	if err != nil {
		t.Fatalf("SyncMounts flush: %v", err)
	}
	if len(syncRes.Conflicts) != 1 {
		t.Fatalf("expected 1 conflict from LocalEnv <-> memory.Store, got %+v", syncRes.Conflicts)
	}

	// Local conflict branch file must contain localEdit, while shared.md fast-forwards to serverV2.
	preservedLocal, err := env.ReadFile(ctx, syncRes.Conflicts[0].ConflictRelPath)
	if err != nil || !bytes.Equal(preservedLocal, localEdit) {
		t.Fatalf("local conflict branch mismatch: got=%q err=%v", preservedLocal, err)
	}
	curLocal, err := env.ReadFile(ctx, ".vibe/memory/shared.md")
	if err != nil || !bytes.Equal(curLocal, serverV2) {
		t.Fatalf("expected .vibe/memory/shared.md updated to serverV2, got=%q err=%v", curLocal, err)
	}

	// Server conflict store must also hold the preserved branch.
	serverConflicts, err := st.ListConflicts(ctx, DefaultScopeID, false)
	if err != nil || len(serverConflicts) != 1 || !bytes.Equal(serverConflicts[0].Content, localEdit) {
		t.Fatalf("server conflict branch mismatch: %+v err=%v", serverConflicts, err)
	}
}

func TestDreamsOfflineConsolidationApproveAndRollback(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	var nowMs atomic.Int64
	nowMs.Store(1700000100000)
	tick := func() int64 { return nowMs.Add(1000) }

	dbPath := filepath.Join(t.TempDir(), "memory.sqlite")
	st, err := OpenStore(ctx, dbPath, WithClock(tick))
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	defer st.Close()

	// Seed active v1 with duplicate facts, stale keyed fact, and pinned user instruction.
	v1Facts := []byte(strings.Join([]string{
		"# Agent Memory",
		"- user: Always keep CGO_ENABLED=0 across builds",
		"- runtime: Go 1.25.5",
		"- SQLite full-text search uses trigram tokenizer",
		"- SQLite full-text search uses trigram tokenizer", // exact duplicate
		"- 架构约定：前端与后端共享 Go contract 类型定义",
		"",
	}, "\n"))
	v1, err := st.CommitFiles(ctx, CommitRequest{
		ScopeID: "dream-agent",
		Summary: "seed v1",
		Files:   []MemoryFileInput{{RelPath: "facts.md", Content: v1Facts}},
	})
	if err != nil {
		t.Fatalf("CommitFiles v1: %v", err)
	}

	// Run offline dreaming pipeline with recent completed session summaries.
	proposal, err := st.RunDream(ctx, DreamRequest{
		ScopeID: "dream-agent",
		SessionSummaries: []SessionSummary{
			{
				SessionID:     "sess-101",
				IssueID:       "ISS-1",
				Summary:       "- runtime: Go 1.27.3\n- 架构约定：前端与后端共享 Go contract 类型定义",
				Facts:         []string{"SQLite full-text search uses trigram tokenizer", "Dreaming pipeline consolidates memories offline"},
				CompletedAtMs: 1700000050000,
			},
			{
				SessionID:     "sess-102",
				IssueID:       "ISS-2",
				Facts:         []string{"Dreaming pipeline consolidates memories offline", "向导：优先运行 go test -race"},
				CompletedAtMs: 1700000080000,
			},
		},
	})
	if err != nil {
		t.Fatalf("RunDream: %v", err)
	}
	if proposal.BaseVersion != 1 || proposal.CandidateVersion != 2 || proposal.Status != string(DreamPending) {
		t.Fatalf("unexpected dream proposal: %+v", proposal)
	}
	if proposal.DeduplicatedCount < 3 {
		t.Fatalf("expected >= 3 deduplications (exact + stale key + cross-session dup), got %d", proposal.DeduplicatedCount)
	}

	// CRITICAL INVARIANT: Before approval, active memory MUST remain completely unchanged (v1)!
	activeBeforeApprove, err := st.ActiveSnapshot(ctx, "dream-agent")
	if err != nil {
		t.Fatalf("ActiveSnapshot before approve: %v", err)
	}
	if activeBeforeApprove.Version != v1.Version {
		t.Fatalf("active version changed before approval: got %d want %d", activeBeforeApprove.Version, v1.Version)
	}
	beforeFile, _ := activeBeforeApprove.File("facts.md")
	if !bytes.Equal(beforeFile.Content, v1Facts) {
		t.Fatalf("active content mutated before approval:\n%s", beforeFile.Content)
	}

	// Inspect candidate version directly: it must contain updated runtime & new facts, deduplicated, and preserve user instruction!
	candSnap, err := st.GetVersion(ctx, "dream-agent", proposal.CandidateVersion)
	if err != nil {
		t.Fatalf("GetVersion candidate: %v", err)
	}
	if candSnap.Status != VersionStatusCandidate {
		t.Fatalf("expected candidate status, got %q", candSnap.Status)
	}
	candFacts, ok := candSnap.File("facts.md")
	if !ok {
		t.Fatal("candidate snapshot missing facts.md")
	}
	candStr := string(candFacts.Content)
	if !strings.Contains(candStr, "user: Always keep CGO_ENABLED=0 across builds") ||
		!strings.Contains(candStr, "runtime: Go 1.27.3") ||
		strings.Contains(candStr, "runtime: Go 1.25.5") ||
		!strings.Contains(candStr, "向导：优先运行 go test -race") ||
		strings.Count(candStr, "SQLite full-text search uses trigram tokenizer") != 1 ||
		strings.Count(candStr, "Dreaming pipeline consolidates memories offline") != 1 {
		t.Fatalf("unexpected consolidated candidate content:\n%s", candStr)
	}

	// Inbox must surface InboxDreamProposal while pending.
	inbox, err := st.ListInbox(ctx, "dream-agent", false)
	if err != nil || len(inbox) != 1 || inbox[0].Kind != contract.InboxDreamProposal {
		t.Fatalf("expected 1 InboxDreamProposal, got %+v err=%v", inbox, err)
	}

	// Reject test on a second dream proposal leaves active version untouched.
	rejectedProp, err := st.RunDream(ctx, DreamRequest{
		ScopeID:          "dream-agent",
		SessionSummaries: []SessionSummary{{SessionID: "sess-103", Facts: []string{"transient fact"}}},
	})
	if err != nil {
		t.Fatalf("RunDream 2: %v", err)
	}
	if rejectedProp.CandidateVersion != 3 || rejectedProp.BaseVersion != 1 {
		t.Fatalf("unexpected proposal 2 versions: %+v", rejectedProp)
	}
	rejRes, err := st.RejectDream(ctx, rejectedProp.ProposalID)
	if err != nil || rejRes.Status != string(DreamRejected) {
		t.Fatalf("RejectDream: res=%+v err=%v", rejRes, err)
	}
	activeAfterReject, _ := st.ActiveSnapshot(ctx, "dream-agent")
	if activeAfterReject.Version != 1 {
		t.Fatalf("expected active version still 1 after reject, got %d", activeAfterReject.Version)
	}

	// Approve proposal 1 -> single-transaction atomic switch from v1 to v2.
	approved, err := st.ApproveDream(ctx, proposal.ProposalID)
	if err != nil {
		t.Fatalf("ApproveDream: %v", err)
	}
	if approved.Status != string(DreamApproved) {
		t.Fatalf("expected approved status, got %q", approved.Status)
	}
	activeAfterApprove, err := st.ActiveSnapshot(ctx, "dream-agent")
	if err != nil {
		t.Fatalf("ActiveSnapshot after approve: %v", err)
	}
	if activeAfterApprove.Version != 2 || activeAfterApprove.Status != VersionStatusActive {
		t.Fatalf("expected active version 2 after approve, got %+v", activeAfterApprove)
	}
	// Approving again must fail cleanly.
	if _, err := st.ApproveDream(ctx, proposal.ProposalID); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("expected ErrInvalidTransition on double approve, got %v", err)
	}

	// RollbackDream -> single-transaction atomic switch back to v1!
	rolledBack, err := st.RollbackDream(ctx, proposal.ProposalID)
	if err != nil {
		t.Fatalf("RollbackDream: %v", err)
	}
	if rolledBack.Status != string(DreamRolledBack) {
		t.Fatalf("expected rolled_back status, got %q", rolledBack.Status)
	}
	activeAfterRollback, err := st.ActiveSnapshot(ctx, "dream-agent")
	if err != nil {
		t.Fatalf("ActiveSnapshot after rollback: %v", err)
	}
	if activeAfterRollback.Version != 1 || activeAfterRollback.Status != VersionStatusActive {
		t.Fatalf("expected active version restored to 1, got %+v", activeAfterRollback)
	}
	rbFile, _ := activeAfterRollback.File("facts.md")
	if !bytes.Equal(rbFile.Content, v1Facts) {
		t.Fatalf("rolled back facts.md content mismatch:\ngot:\n%s\nwant:\n%s", rbFile.Content, v1Facts)
	}
	// v2 immutable content remains preserved in version history for audit.
	histV2, err := st.GetVersion(ctx, "dream-agent", 2)
	if err != nil || histV2.Status != VersionStatusRolledBack {
		t.Fatalf("expected v2 preserved with status rolled_back, got %+v err=%v", histV2, err)
	}
}

func TestDreamTransactionAtomicityAndDivergenceGuard(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	var failNext atomic.Bool
	errInjected := errors.New("injected commit failure")

	st, err := OpenStore(ctx, ":memory:", WithBeforeCommitHook(func() error {
		if failNext.Swap(false) {
			return errInjected
		}
		return nil
	}))
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	defer st.Close()

	if _, err := st.CommitFiles(ctx, CommitRequest{
		ScopeID: "atom",
		Files:   []MemoryFileInput{{RelPath: "facts.md", Content: []byte("- fact A\n")}},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Fault-inject during RunDream commit: must roll back candidate version, dream row, and inbox item!
	failNext.Store(true)
	if _, err := st.RunDream(ctx, DreamRequest{
		ScopeID:          "atom",
		SessionSummaries: []SessionSummary{{SessionID: "s1", Facts: []string{"fact B"}}},
	}); !errors.Is(err, errInjected) {
		t.Fatalf("expected injected error on RunDream, got %v", err)
	}
	if props, _ := st.ListDreamProposals(ctx, "atom"); len(props) != 0 {
		t.Fatalf("expected 0 dream proposals after rollback, got %+v", props)
	}
	if vers, _ := st.ListVersions(ctx, "atom"); len(vers) != 1 {
		t.Fatalf("expected only v1 after failed RunDream commit, got %d", len(vers))
	}

	// Successful RunDream -> fault-inject during ApproveDream -> active version must remain 1 and proposal still pending!
	prop, err := st.RunDream(ctx, DreamRequest{
		ScopeID:          "atom",
		SessionSummaries: []SessionSummary{{SessionID: "s1", Facts: []string{"fact B"}}},
	})
	if err != nil {
		t.Fatalf("RunDream: %v", err)
	}
	failNext.Store(true)
	if _, err := st.ApproveDream(ctx, prop.ProposalID); !errors.Is(err, errInjected) {
		t.Fatalf("expected injected error on ApproveDream, got %v", err)
	}
	if act, _ := st.ActiveSnapshot(ctx, "atom"); act.Version != 1 {
		t.Fatalf("expected active version still 1 after aborted approve, got %d", act.Version)
	}
	if pNow, _ := st.GetDreamProposal(ctx, prop.ProposalID); pNow.Status != string(DreamPending) {
		t.Fatalf("expected proposal still pending after aborted approve, got %q", pNow.Status)
	}

	// If active memory advances while dream is pending, ApproveDream must refuse with ErrConflict!
	if _, err := st.CommitFiles(ctx, CommitRequest{
		ScopeID:         "atom",
		ExpectedVersion: 1,
		Files:           []MemoryFileInput{{RelPath: "facts.md", Content: []byte("- fact A\n- concurrent manual edit\n")}},
	}); err != nil {
		t.Fatalf("concurrent CommitFiles: %v", err)
	}
	if _, err := st.ApproveDream(ctx, prop.ProposalID); !errors.Is(err, ErrConflict) {
		t.Fatalf("expected ErrConflict when approving stale dream, got %v", err)
	}
}

func TestMemoryConcurrentRaceStress(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	st, err := OpenStore(ctx, ":memory:")
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	defer st.Close()

	if _, err := st.CommitFiles(ctx, CommitRequest{
		ScopeID: "race",
		Files:   []MemoryFileInput{{RelPath: "facts.md", Content: []byte("- initial\n")}},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	var wg sync.WaitGroup
	for g := range 6 {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for i := range 8 {
				_, _, err := st.ReconcileMounts(ctx, "race", fmt.Sprintf("sess-%d", worker), []contract.MountFile{
					{
						RelPath:     "facts.md",
						BaseVersion: 1,
						Content:     []byte(fmt.Sprintf("- edit %d-%d\n", worker, i)),
					},
				})
				if err != nil {
					t.Errorf("ReconcileMounts: %v", err)
					return
				}
				if _, err := st.ActiveSnapshot(ctx, "race"); err != nil {
					t.Errorf("ActiveSnapshot: %v", err)
					return
				}
			}
		}(g)
	}
	wg.Wait()

	conflicts, err := st.ListConflicts(ctx, "race", true)
	if err != nil {
		t.Fatalf("ListConflicts: %v", err)
	}
	if len(conflicts) == 0 {
		t.Fatal("expected concurrent stale-base updates to preserve conflict branches")
	}
}

func TestMemoryMigrationsUpStatusDownAllUp(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	dbPath := filepath.Join(t.TempDir(), "memory-mig.sqlite")
	conn, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	defer conn.Close()

	fsys, err := db.ScopeFS("memory")
	if err != nil {
		t.Fatalf("db.ScopeFS(memory): %v", err)
	}

	runner, err := migrate.New(conn, "memory", fsys)
	if err != nil {
		t.Fatalf("migrate.New: %v", err)
	}

	applied, err := runner.Up(ctx)
	if err != nil || applied != 1 {
		t.Fatalf("Up: applied=%d err=%v", applied, err)
	}
	if again, err := runner.Up(ctx); err != nil || again != 0 {
		t.Fatalf("idempotent Up: applied=%d err=%v", again, err)
	}

	statuses, err := runner.Status(ctx)
	if err != nil || len(statuses) != 1 || !statuses[0].Applied || statuses[0].Scope != "memory" || statuses[0].Version != 1 {
		t.Fatalf("unexpected status after Up: %+v err=%v", statuses, err)
	}

	expectedTables := []string{
		"memory_heads",
		"memory_versions",
		"memory_version_files",
		"memory_conflicts",
		"memory_dreams",
		"memory_inbox",
	}
	for _, tbl := range expectedTables {
		var name string
		if err := conn.QueryRowContext(ctx, `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, tbl).Scan(&name); err != nil {
			t.Fatalf("expected table %s after Up: %v", tbl, err)
		}
	}

	reverted, err := runner.DownAll(ctx)
	if err != nil || reverted != 1 {
		t.Fatalf("DownAll: reverted=%d err=%v", reverted, err)
	}
	statusesAfterDown, err := runner.Status(ctx)
	if err != nil || len(statusesAfterDown) != 1 || statusesAfterDown[0].Applied {
		t.Fatalf("unexpected status after DownAll: %+v err=%v", statusesAfterDown, err)
	}
	for _, tbl := range expectedTables {
		var name string
		err := conn.QueryRowContext(ctx, `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, tbl).Scan(&name)
		if !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("expected table %s dropped after DownAll, got name=%q err=%v", tbl, name, err)
		}
	}

	reapplied, err := runner.Up(ctx)
	if err != nil || reapplied != 1 {
		t.Fatalf("re-Up after DownAll: applied=%d err=%v", reapplied, err)
	}
	_ = conn.Close()

	// Store opened against migrated file operates with full parity.
	st, err := OpenStore(ctx, dbPath)
	if err != nil {
		t.Fatalf("OpenStore after re-Up: %v", err)
	}
	defer st.Close()

	snap, err := st.CommitFiles(ctx, CommitRequest{
		ScopeID: "mig-scope",
		Files:   []MemoryFileInput{{RelPath: "facts.md", Content: []byte("- migrated\n")}},
	})
	if err != nil || snap.Version != 1 {
		t.Fatalf("CommitFiles after re-Up: snap=%+v err=%v", snap, err)
	}

	// Exercise ListVersions, ListDreamProposals, and ListInbox(includeResolved=true).
	prop, err := st.RunDream(ctx, DreamRequest{
		ScopeID:          "mig-scope",
		SessionSummaries: []SessionSummary{{SessionID: "s-mig", Facts: []string{"extra migrated fact"}}},
	})
	if err != nil {
		t.Fatalf("RunDream after re-Up: %v", err)
	}
	if _, err := st.ApproveDream(ctx, prop.ProposalID); err != nil {
		t.Fatalf("ApproveDream after re-Up: %v", err)
	}
	props, err := st.ListDreamProposals(ctx, "mig-scope")
	if err != nil || len(props) != 1 || props[0].ProposalID != prop.ProposalID || props[0].Status != string(DreamApproved) {
		t.Fatalf("ListDreamProposals: props=%+v err=%v", props, err)
	}
	vers, err := st.ListVersions(ctx, "mig-scope")
	if err != nil || len(vers) != 2 {
		t.Fatalf("ListVersions: len=%d err=%v", len(vers), err)
	}
	allInbox, err := st.ListInbox(ctx, "mig-scope", true)
	if err != nil || len(allInbox) != 1 || !allInbox[0].Resolved {
		t.Fatalf("ListInbox(includeResolved=true): inbox=%+v err=%v", allInbox, err)
	}
}

func TestOpenStoreFromPoolNonOwning(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	if _, err := OpenStoreFromPool(ctx, nil, nil, true); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("expected ErrInvalidArgument for nil writeDB, got %v", err)
	}

	canceledCtx, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := OpenStoreFromPool(canceledCtx, nil, nil, true); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}

	// Blank DSN in standalone OpenStore defaults to :memory: and closes owned DB on Close.
	ownedMem, err := OpenStore(ctx, "")
	if err != nil {
		t.Fatalf("OpenStore blank dsn: %v", err)
	}
	ownedDB := ownedMem.DB()
	if err := ownedMem.Close(); err != nil {
		t.Fatalf("ownedMem.Close: %v", err)
	}
	if err := ownedDB.PingContext(ctx); err == nil {
		t.Fatal("expected owned DB to be closed after OpenStore.Close()")
	}

	// Shared :memory: pool with readDB == nil defaults readDB to writeDB and leaves pool open on Close.
	memPool, err := db.OpenPool(ctx, ":memory:")
	if err != nil {
		t.Fatalf("db.OpenPool(:memory:): %v", err)
	}
	defer func() { _ = memPool.Close() }()

	memRunner, err := migrate.New(memPool.WriteDB, db.PlatformScope, db.MigrationsFS)
	if err != nil {
		t.Fatalf("migrate.New(mem): %v", err)
	}
	if _, err := memRunner.Up(ctx); err != nil {
		t.Fatalf("memRunner.Up: %v", err)
	}

	memStore, err := OpenStoreFromPool(ctx, memPool.WriteDB, nil, true)
	if err != nil {
		t.Fatalf("OpenStoreFromPool(mem, nil readDB): %v", err)
	}
	if memStore.DB() != memPool.WriteDB {
		t.Fatalf("expected readDB to default to writeDB when nil")
	}
	if _, err := memStore.CommitFiles(ctx, CommitRequest{
		ScopeID: "pool-mem",
		Files:   []MemoryFileInput{{RelPath: "facts.md", Content: []byte("- shared pool\n")}},
	}); err != nil {
		t.Fatalf("memStore.CommitFiles: %v", err)
	}
	if err := memStore.Close(); err != nil {
		t.Fatalf("memStore.Close: %v", err)
	}
	if _, err := memStore.ActiveSnapshot(ctx, "pool-mem"); !errors.Is(err, ErrClosed) {
		t.Fatalf("expected ErrClosed after memStore.Close, got %v", err)
	}
	if err := memPool.WriteDB.PingContext(ctx); err != nil {
		t.Fatalf("shared memPool.WriteDB closed unexpectedly: %v", err)
	}

	// Shared file-backed WAL pool with distinct writeDB and readDB.
	walPath := filepath.Join(t.TempDir(), "platform.db")
	walPool, err := db.OpenPool(ctx, walPath)
	if err != nil {
		t.Fatalf("db.OpenPool(wal): %v", err)
	}
	defer func() { _ = walPool.Close() }()

	walRunner, err := migrate.New(walPool.WriteDB, db.PlatformScope, db.MigrationsFS)
	if err != nil {
		t.Fatalf("migrate.New(wal): %v", err)
	}
	if _, err := walRunner.Up(ctx); err != nil {
		t.Fatalf("walRunner.Up: %v", err)
	}

	var tick atomic.Int64
	tick.Store(1700000500000)
	walStore, err := OpenStoreFromPool(ctx, walPool.WriteDB, walPool.ReadDB, walPool.IsMem, WithClock(func() int64 {
		return tick.Add(1000)
	}))
	if err != nil {
		t.Fatalf("OpenStoreFromPool(wal): %v", err)
	}
	if walStore.DB() != walPool.ReadDB {
		t.Fatalf("expected walStore.DB() == walPool.ReadDB")
	}
	if _, err := walStore.CommitFiles(ctx, CommitRequest{
		ScopeID: "pool-wal",
		Files:   []MemoryFileInput{{RelPath: "facts.md", Content: []byte("- wal fact\n")}},
	}); err != nil {
		t.Fatalf("walStore.CommitFiles: %v", err)
	}
	prop, err := walStore.RunDream(ctx, DreamRequest{
		ScopeID:          "pool-wal",
		SessionSummaries: []SessionSummary{{SessionID: "s-pool", Facts: []string{"dream via pool"}}},
	})
	if err != nil {
		t.Fatalf("walStore.RunDream: %v", err)
	}
	if _, err := walStore.ApproveDream(ctx, prop.ProposalID); err != nil {
		t.Fatalf("walStore.ApproveDream: %v", err)
	}
	if err := walStore.Close(); err != nil {
		t.Fatalf("walStore.Close: %v", err)
	}
	if err := walStore.Close(); err != nil {
		t.Fatalf("idempotent walStore.Close: %v", err)
	}
	if _, err := walStore.ActiveSnapshot(ctx, "pool-wal"); !errors.Is(err, ErrClosed) {
		t.Fatalf("expected ErrClosed after walStore.Close, got %v", err)
	}
	if err := walPool.WriteDB.PingContext(ctx); err != nil {
		t.Fatalf("shared walPool.WriteDB closed unexpectedly: %v", err)
	}
	if err := walPool.ReadDB.PingContext(ctx); err != nil {
		t.Fatalf("shared walPool.ReadDB closed unexpectedly: %v", err)
	}
}
