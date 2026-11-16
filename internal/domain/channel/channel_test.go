package channel_test

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/domain/channel"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
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
