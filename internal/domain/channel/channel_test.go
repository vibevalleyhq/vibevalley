package channel_test

import (
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/domain/channel"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
	"github.com/vibevalleyhq/vibevalley/pkg/db"
	"github.com/vibevalleyhq/vibevalley/pkg/migrate"
	_ "modernc.org/sqlite"
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

func (c *fixedClock) NowMs() int64 {
	return c.Now().UnixMilli()
}

func (c *fixedClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

type storeFactory struct {
	name string
	open func(t *testing.T, clk channel.Clock) (*channel.Store, func() *channel.Store, string)
}

func backends(t *testing.T) []storeFactory {
	t.Helper()
	return []storeFactory{
		{
			name: "memory",
			open: func(t *testing.T, clk channel.Clock) (*channel.Store, func() *channel.Store, string) {
				return channel.NewMemoryStore(channel.WithClock(clk)), nil, ""
			},
		},
		{
			name: "sqlite-wal",
			open: func(t *testing.T, clk channel.Clock) (*channel.Store, func() *channel.Store, string) {
				dbPath := filepath.Join(t.TempDir(), "channel.db")
				st, err := channel.OpenSQLite(context.Background(), dbPath, channel.WithClock(clk))
				if err != nil {
					t.Fatalf("OpenSQLite: %v", err)
				}
				reopen := func() *channel.Store {
					s2, err := channel.OpenSQLite(context.Background(), dbPath, channel.WithClock(clk))
					if err != nil {
						t.Fatalf("reopen OpenSQLite: %v", err)
					}
					return s2
				}
				return st, reopen, dbPath
			},
		},
	}
}

func TestChannelParityEventsViewsSeparationAndCursors(t *testing.T) {
	ctx := context.Background()
	for _, bf := range backends(t) {
		t.Run(bf.name, func(t *testing.T) {
			clk := newFixedClock()
			st, reopen, dbPath := bf.open(t, clk)
			defer func() { _ = st.Close() }()

			var notified []channel.Event
			var notifyMu sync.Mutex
			unsub := st.Subscribe(func(ev channel.Event) {
				notifyMu.Lock()
				notified = append(notified, ev)
				notifyMu.Unlock()
			})
			defer unsub()

			ch, created, err := st.EnsureChannel(ctx, channel.Channel{
				ID:             "general",
				Type:           channel.TypePublic,
				Name:           "general",
				DefaultAgentID: "orchestrator",
				IsDefault:      true,
			})
			if err != nil || !created || ch.ID != "general" {
				t.Fatalf("EnsureChannel general: ch=%+v created=%v err=%v", ch, created, err)
			}
			if err := st.AddMember(ctx, "general", "orchestrator"); err != nil {
				t.Fatalf("AddMember: %v", err)
			}

			// Internal durable_entry kinds MUST be rejected.
			for _, badKind := range []contract.ChannelEventKind{"pi.user", "pi.assistant", "pi.tool_result", "pi.system", "pi.compaction", "pi.reset"} {
				if _, err := st.Append(ctx, channel.AppendRequest{
					ChannelID: "general",
					Kind:      badKind,
					AuthorID:  "worker-1",
					ActorKind: channel.ActorAgent,
					Text:      "raw reasoning trace",
				}); !errors.Is(err, channel.ErrInvalidEventKind) {
					t.Fatalf("expected ErrInvalidEventKind for %q, got %v", badKind, err)
				}
			}

			// 1. User message with SendKey idempotency.
			m1, err := st.Append(ctx, channel.AppendRequest{
				ChannelID: "general",
				Kind:      contract.ChannelEventMessage,
				AuthorID:  "user",
				ActorKind: channel.ActorUser,
				Text:      "Fix login timeout @worker-1",
				Mentions:  []string{"@worker-1"},
				SendKey:   "msg-1",
			})
			if err != nil || m1.Deduplicated || m1.Event.Seq != 1 || m1.Event.GlobalSeq != 1 {
				t.Fatalf("append m1: %+v err=%v", m1, err)
			}
			if !slices.Equal(m1.Event.Mentions, []string{"worker-1"}) {
				t.Fatalf("expected normalized mentions [worker-1], got %v", m1.Event.Mentions)
			}
			m1Dup, err := st.Append(ctx, channel.AppendRequest{
				ChannelID: "general",
				Kind:      contract.ChannelEventMessage,
				AuthorID:  "user",
				ActorKind: channel.ActorUser,
				Text:      "duplicate",
				SendKey:   "msg-1",
			})
			if err != nil || !m1Dup.Deduplicated || m1Dup.Event.Seq != 1 {
				t.Fatalf("expected SendKey deduplication, got %+v err=%v", m1Dup, err)
			}

			clk.Advance(time.Second)

			// 2. Question card from agent referencing sessionId only.
			q1, err := st.PostQuestion(ctx, "general", "worker-1", "sess-123", channel.QuestionCard{
				QuestionID: "q-1",
				Prompt:     "Allow Redis cache fallback?",
				Options:    []string{"Yes", "No"},
			}, "user")
			if err != nil || q1.Event.Seq != 2 || q1.Event.Kind != contract.ChannelEventQuestion {
				t.Fatalf("PostQuestion: %+v err=%v", q1, err)
			}

			clk.Advance(time.Second)

			// 3. Final report summary referencing sessionId only.
			r1, err := st.PostReport(ctx, "general", "worker-1", "sess-123", channel.ReportSummary{
				IssueID:   "iss-42",
				Outcome:   "completed",
				Summary:   "Added retry backoff and passing tests.",
				Delivered: "merged",
			})
			if err != nil || r1.Event.Seq != 3 || r1.Event.Kind != contract.ChannelEventReport {
				t.Fatalf("PostReport: %+v err=%v", r1, err)
			}

			// 4. Reaction referencing seq 1.
			rc1, err := st.AddReaction(ctx, "general", "worker-1", channel.ActorAgent, 1, "👀")
			if err != nil || rc1.Event.Seq != 4 || rc1.Event.Kind != contract.ChannelEventReaction {
				t.Fatalf("AddReaction: %+v err=%v", rc1, err)
			}

			// Verify ChannelEventView projection & sessionId reference-only separation.
			views, err := st.ListEventViews(ctx, "general", 0, 100)
			if err != nil || len(views) != 4 {
				t.Fatalf("ListEventViews: len=%d err=%v", len(views), err)
			}
			if views[0].Kind != contract.ChannelEventMessage || views[0].SessionID != "" {
				t.Fatalf("unexpected view[0]: %+v", views[0])
			}
			if views[1].Kind != contract.ChannelEventQuestion || views[1].SessionID != "sess-123" {
				t.Fatalf("unexpected view[1]: %+v", views[1])
			}
			if views[2].Kind != contract.ChannelEventReport || views[2].SessionID != "sess-123" {
				t.Fatalf("unexpected view[2]: %+v", views[2])
			}
			if views[3].Kind != contract.ChannelEventReaction || views[3].Text != "👀" {
				t.Fatalf("unexpected view[3]: %+v", views[3])
			}

			// Per-actor read cursors: user authored seq 1 (read_seq=1), so 2 non-reaction events (2,3) unread for user!
			unreadUser, err := st.UnreadCount(ctx, "general", "user")
			if err != nil || unreadUser != 2 {
				t.Fatalf("expected 2 unread non-reaction events for user, got %d err=%v", unreadUser, err)
			}
			// Monotonic cursor advance and no backwards regression.
			cur, err := st.AdvanceReadCursor(ctx, "general", "user", 3)
			if err != nil || cur.ReadSeq != 3 {
				t.Fatalf("AdvanceReadCursor(3): %+v err=%v", cur, err)
			}
			curRegress, err := st.AdvanceReadCursor(ctx, "general", "user", 1)
			if err != nil || curRegress.ReadSeq != 3 {
				t.Fatalf("expected cursor not to regress below 3, got %+v err=%v", curRegress, err)
			}
			unreadAfter, err := st.UnreadCount(ctx, "general", "user")
			if err != nil || unreadAfter != 0 {
				t.Fatalf("expected 0 unread after cursor=3, got %d err=%v", unreadAfter, err)
			}

			// Thread creation reuses same thread per issueId.
			t1, t1Created, err := st.OpenThreadForIssue(ctx, "iss-42", "general", "Issue 42", "repo-1")
			if err != nil || !t1Created {
				t.Fatalf("OpenThreadForIssue 1: %+v created=%v err=%v", t1, t1Created, err)
			}
			t2, t2Created, err := st.OpenThreadForIssue(ctx, "iss-42", "general", "Issue 42", "repo-1")
			if err != nil || t2Created || t2.ID != t1.ID {
				t.Fatalf("OpenThreadForIssue reuse failed: %+v created=%v err=%v", t2, t2Created, err)
			}

			notifyMu.Lock()
			gotNotified := len(notified)
			notifyMu.Unlock()
			if gotNotified != 4 {
				t.Fatalf("expected 4 post-commit notifications (dedup excluded), got %d", gotNotified)
			}

			// SQLite-specific checks: restart durability + append-only triggers.
			if reopen != nil {
				_ = st.Close()
				st = reopen()

				// SendKey still deduplicates after restart.
				afterRestartDup, err := st.Append(ctx, channel.AppendRequest{
					ChannelID: "general",
					Kind:      contract.ChannelEventMessage,
					AuthorID:  "user",
					ActorKind: channel.ActorUser,
					Text:      "retry after crash",
					SendKey:   "msg-1",
				})
				if err != nil || !afterRestartDup.Deduplicated || afterRestartDup.Event.Seq != 1 {
					t.Fatalf("expected SendKey dedup after restart, got %+v err=%v", afterRestartDup, err)
				}

				globalFeed, err := st.EventsAfterGlobal(ctx, 2, 10)
				if err != nil || len(globalFeed) != 2 || globalFeed[0].GlobalSeq != 3 || globalFeed[1].GlobalSeq != 4 {
					t.Fatalf("EventsAfterGlobal(2) after restart: %+v err=%v", globalFeed, err)
				}

				// Verify SQLite append-only triggers reject UPDATE and DELETE on channel_event.
				rawDB, err := sql.Open("sqlite", dbPath)
				if err != nil {
					t.Fatalf("open raw sqlite: %v", err)
				}
				defer rawDB.Close()
				if _, err := rawDB.Exec(`UPDATE channel_event SET text = 'tampered' WHERE seq = 1`); err == nil {
					t.Fatalf("expected append-only trigger to block UPDATE on channel_event")
				}
				if _, err := rawDB.Exec(`DELETE FROM channel_event WHERE seq = 1`); err == nil {
					t.Fatalf("expected append-only trigger to block DELETE on channel_event")
				}
			}
		})
	}
}

func TestChannelConcurrentAppendsRace(t *testing.T) {
	ctx := context.Background()
	st := channel.NewMemoryStore()
	defer st.Close()

	if _, err := st.CreateChannel(ctx, channel.Channel{ID: "ch-race", Type: channel.TypePublic, Name: "race"}); err != nil {
		t.Fatal(err)
	}

	const n = 40
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			_, err := st.PostMessage(ctx, "ch-race", "user", channel.ActorUser, "msg")
			if err != nil {
				t.Errorf("PostMessage %d: %v", idx, err)
			}
		}(i)
	}
	wg.Wait()

	views, err := st.ListEventViews(ctx, "ch-race", 0, 100)
	if err != nil || len(views) != n {
		t.Fatalf("expected %d views, got %d err=%v", n, len(views), err)
	}
	for i, v := range views {
		if v.Seq != int64(i+1) {
			t.Fatalf("expected seq %d at index %d, got %d", i+1, i, v.Seq)
		}
	}
}

func TestChannelMigrationsUpStatusDownAllUp(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "channel-migrate.db")
	sqlDB, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer sqlDB.Close()
	sqlDB.SetMaxOpenConns(1)
	if _, err := sqlDB.ExecContext(ctx, "PRAGMA busy_timeout=5000"); err != nil {
		t.Fatalf("pragma: %v", err)
	}

	scopeFS, err := db.ScopeFS("channel")
	if err != nil {
		t.Fatalf("ScopeFS(channel): %v", err)
	}
	runner, err := migrate.New(sqlDB, "channel", scopeFS)
	if err != nil {
		t.Fatalf("migrate.New: %v", err)
	}

	// Initial Status: 1 pending migration.
	st0, err := runner.Status(ctx)
	if err != nil || len(st0) != 1 || st0[0].Applied || st0[0].Version != 1 || st0[0].Scope != "channel" {
		t.Fatalf("unexpected initial status: %+v err=%v", st0, err)
	}

	// Up applies 0001_channel.up.sql.
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

	// Verify all 4 tables, 3 indexes, and 2 triggers exist.
	assertChannelObjectsExist(t, sqlDB, true)

	// Attach Store via OpenDB and exercise dbgen queries + append-only triggers.
	clk := newFixedClock()
	store1, err := channel.OpenDB(ctx, sqlDB, channel.WithClock(clk))
	if err != nil {
		t.Fatalf("OpenDB after Up: %v", err)
	}
	if _, err := store1.CreateChannel(ctx, channel.Channel{ID: "general", Type: channel.TypePublic, Name: "general"}); err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if err := store1.AddMember(ctx, "general", "alice"); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	if err := store1.AddMember(ctx, "general", "bob"); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	if err := store1.RemoveMember(ctx, "general", "bob"); err != nil {
		t.Fatalf("RemoveMember: %v", err)
	}
	if members, err := store1.ListMembers(ctx, "general"); err != nil || !slices.Equal(members, []string{"alice"}) {
		t.Fatalf("ListMembers: %v err=%v", members, err)
	}
	if chs, err := store1.ListChannels(ctx); err != nil || len(chs) != 1 || chs[0].ID != "general" {
		t.Fatalf("ListChannels: %+v err=%v", chs, err)
	}
	if _, err := store1.GetChannel(ctx, "general"); err != nil {
		t.Fatalf("GetChannel: %v", err)
	}
	ev1, err := store1.PostMessage(ctx, "general", "alice", channel.ActorUser, "hello", "bob")
	if err != nil || ev1.Event.Seq != 1 || ev1.Event.GlobalSeq != 1 {
		t.Fatalf("PostMessage 1: %+v err=%v", ev1, err)
	}
	ev2, err := store1.PostMessage(ctx, "general", "bob", channel.ActorUser, "world")
	if err != nil || ev2.Event.Seq != 2 || ev2.Event.GlobalSeq != 2 {
		t.Fatalf("PostMessage 2: %+v err=%v", ev2, err)
	}
	if got, err := store1.GetEvent(ctx, "general", 1); err != nil || got.Text != "hello" {
		t.Fatalf("GetEvent: %+v err=%v", got, err)
	}
	if listAll, err := store1.ListEvents(ctx, "general", 0, 0); err != nil || len(listAll) != 2 {
		t.Fatalf("ListEvents unlimited: len=%d err=%v", len(listAll), err)
	}
	if listLim, err := store1.ListEvents(ctx, "general", 0, 1); err != nil || len(listLim) != 1 {
		t.Fatalf("ListEvents limited: len=%d err=%v", len(listLim), err)
	}
	if globAll, err := store1.EventsAfterGlobal(ctx, 0, 0); err != nil || len(globAll) != 2 {
		t.Fatalf("EventsAfterGlobal unlimited: len=%d err=%v", len(globAll), err)
	}
	if globLim, err := store1.EventsAfterGlobal(ctx, 0, 1); err != nil || len(globLim) != 1 {
		t.Fatalf("EventsAfterGlobal limited: len=%d err=%v", len(globLim), err)
	}
	if cursors, err := store1.ListReadCursors(ctx, "general"); err != nil || len(cursors) != 2 {
		t.Fatalf("ListReadCursors: %+v err=%v", cursors, err)
	}
	if rc, err := store1.GetReadCursor(ctx, "general", "alice"); err != nil || rc.ReadSeq != 1 {
		t.Fatalf("GetReadCursor: %+v err=%v", rc, err)
	}

	// Verify append-only triggers reject UPDATE and DELETE after Up.
	if _, err := sqlDB.ExecContext(ctx, `UPDATE channel_event SET text = 'tampered' WHERE seq = 1`); err == nil || !strings.Contains(err.Error(), "channel_event is append-only") {
		t.Fatalf("expected append-only trigger error on UPDATE, got %v", err)
	}
	if _, err := sqlDB.ExecContext(ctx, `DELETE FROM channel_event WHERE seq = 1`); err == nil || !strings.Contains(err.Error(), "channel_event is append-only") {
		t.Fatalf("expected append-only trigger error on DELETE, got %v", err)
	}
	_ = store1.Close()

	// Checksum mismatch detection when applied up script is modified.
	upOrig, err := fs.ReadFile(scopeFS, "migrations/0001_channel.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	downOrig, err := fs.ReadFile(scopeFS, "migrations/0001_channel.down.sql")
	if err != nil {
		t.Fatal(err)
	}
	tamperedFS := fstest.MapFS{
		"migrations/0001_channel.up.sql":   {Data: append(upOrig, []byte("\n-- tampered\n")...)},
		"migrations/0001_channel.down.sql": {Data: downOrig},
	}
	tamperedRunner, err := migrate.New(sqlDB, "channel", tamperedFS)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tamperedRunner.Up(ctx); !errors.Is(err, migrate.ErrChecksumMismatch) {
		t.Fatalf("expected ErrChecksumMismatch, got %v", err)
	}

	// DownAll cleanly drops triggers, indexes, and tables.
	reverted, err := runner.DownAll(ctx)
	if err != nil || reverted != 1 {
		t.Fatalf("DownAll: reverted=%d err=%v", reverted, err)
	}
	st2, err := runner.Status(ctx)
	if err != nil || len(st2) != 1 || st2[0].Applied {
		t.Fatalf("unexpected status after DownAll: %+v err=%v", st2, err)
	}
	assertChannelObjectsExist(t, sqlDB, false)

	// Re-Up restores full parity cleanly.
	reapplied, err := runner.Up(ctx)
	if err != nil || reapplied != 1 {
		t.Fatalf("re-Up: applied=%d err=%v", reapplied, err)
	}
	st3, err := runner.Status(ctx)
	if err != nil || len(st3) != 1 || !st3[0].Applied {
		t.Fatalf("unexpected status after re-Up: %+v err=%v", st3, err)
	}
	assertChannelObjectsExist(t, sqlDB, true)

	store2, err := channel.OpenDB(ctx, sqlDB, channel.WithClock(clk))
	if err != nil {
		t.Fatalf("OpenDB after re-Up: %v", err)
	}
	defer store2.Close()
	if _, err := store2.CreateChannel(ctx, channel.Channel{ID: "general", Type: channel.TypePublic, Name: "general"}); err != nil {
		t.Fatalf("CreateChannel after re-Up: %v", err)
	}
	evFresh, err := store2.PostMessage(ctx, "general", "alice", channel.ActorUser, "after re-up")
	if err != nil || evFresh.Event.Seq != 1 || evFresh.Event.GlobalSeq != 1 {
		t.Fatalf("expected fresh seq=1, globalSeq=1 after DownAll+Up, got %+v err=%v", evFresh, err)
	}
	if _, err := sqlDB.ExecContext(ctx, `UPDATE channel_event SET text = 'tampered' WHERE seq = 1`); err == nil || !strings.Contains(err.Error(), "channel_event is append-only") {
		t.Fatalf("expected append-only trigger error after re-Up UPDATE, got %v", err)
	}
	if _, err := sqlDB.ExecContext(ctx, `DELETE FROM channel_event WHERE seq = 1`); err == nil || !strings.Contains(err.Error(), "channel_event is append-only") {
		t.Fatalf("expected append-only trigger error after re-Up DELETE, got %v", err)
	}
}

func TestOpenSQLiteFromDBNonOwning(t *testing.T) {
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

	clk := newFixedClock()
	st, err := channel.OpenSQLiteFromDB(ctx, pool.WriteDB, channel.WithClock(clk))
	if err != nil {
		t.Fatalf("OpenSQLiteFromDB: %v", err)
	}
	if _, err := st.CreateChannel(ctx, channel.Channel{ID: "general", Type: channel.TypePublic, Name: "general"}); err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if _, err := st.PostMessage(ctx, "general", "user", channel.ActorUser, "shared hello"); err != nil {
		t.Fatalf("PostMessage: %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatalf("st.Close: %v", err)
	}
	if err := pool.WriteDB.PingContext(ctx); err != nil {
		t.Fatalf("shared WriteDB closed by Store.Close: %v", err)
	}

	st2, err := channel.OpenSQLiteFromDB(ctx, pool.WriteDB, channel.WithClock(clk))
	if err != nil {
		t.Fatalf("reattach OpenSQLiteFromDB: %v", err)
	}
	defer st2.Close()
	ev2, err := st2.PostMessage(ctx, "general", "user", channel.ActorUser, "second")
	if err != nil || ev2.Event.GlobalSeq != 2 || ev2.Event.Seq != 2 {
		t.Fatalf("expected monotonic seq=2 after reattach, got %+v err=%v", ev2, err)
	}
}

func assertChannelObjectsExist(t *testing.T, sqlDB *sql.DB, want bool) {
	t.Helper()
	objects := []struct {
		typ  string
		name string
	}{
		{"table", "channel"},
		{"table", "channel_member"},
		{"table", "channel_event"},
		{"table", "channel_read_cursor"},
		{"index", "channel_issue_thread_idx"},
		{"index", "channel_event_send_key_idx"},
		{"index", "channel_event_chan_seq_idx"},
		{"trigger", "channel_event_no_update"},
		{"trigger", "channel_event_no_delete"},
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
