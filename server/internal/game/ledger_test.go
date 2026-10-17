package game

import (
	"context"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"vibevalley/internal/core"
	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/x/ptr"
)

func gameOpen(t *testing.T, home string) *world {
	t.Helper()
	f, err := newWorld(fixture.Config(home, t.TempDir(), ""))
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func ledgerKinds(t *testing.T, f *world) []string {
	t.Helper()
	rows, err := f.DB.Query("select kind from game_ledger order by id")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var k string
		rows.Scan(&k)
		out = append(out, k)
	}
	return out
}

func TestLedger(t *testing.T) {
	home := t.TempDir()
	f := gameOpen(t, home)
	if err := f.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	_, events, stop := f.Core.Events()
	defer stop()

	agent := "lab"
	f.Game.Record(protocol.LedgerEntryHarvested{Session: "w1", Agent: &agent, Project: "demo", Runtime: "pi", Commits: 1, Runs: 1})
	var news *protocol.ProgressNews
	for news == nil {
		select {
		case e := <-events:
			if p, ok := e.Value.(protocol.FactProgress); ok {
				news = p.News
			}
		case <-time.After(5 * time.Second):
			t.Fatal("no progress fact")
		}
	}
	if news.Coins == nil || *news.Coins < 35 || ptr.Value(news.Session) != "w1" {
		t.Fatalf("news: %+v", news)
	}
	progress := f.Core.State().Progress
	if progress == nil || progress.Coins != *news.Coins || progress.Counts["harvests"] != 1 {
		t.Fatalf("progress: %+v", progress)
	}

	f.Core.Apply(protocol.FactHired{Session: protocol.Session{ID: "w2", Name: "帮工", Agent: "lab", Runtime: "pi", Task: "试试", Phase: protocol.Phase{Value: protocol.PhaseWorking{}}}})
	f.Core.Apply(protocol.FactReport{ID: "w2", Outcome: protocol.OutcomeFailed, Summary: "坏了", Runs: 1})
	f.Core.Apply(protocol.FactCommits{Commits: protocol.CommitCount{Total: 1000}})
	want := []string{"harvested", "hired", "failed", "level"}
	testkit.Await(t, "the ledger has "+strings.Join(want, ", "), func() ([]string, bool) { k := ledgerKinds(t, f); return k, reflect.DeepEqual(k, want) })

	before := *f.Core.State().Progress
	f.Close()

	again := gameOpen(t, home)
	defer again.Close()
	if after := again.Core.State().Progress; after == nil || !reflect.DeepEqual(*after, before) {
		t.Fatalf("the ledger folds back to the same progress:\n%+v\n%+v", after, before)
	}
	if err := again.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if kinds := ledgerKinds(t, again); kinds[len(kinds)-1] != "level" {
		t.Fatalf("no catch-up for a level already on the ledger: %v", kinds)
	}
}

// What the owner did reaches the ledger from the service it went through, whatever the entry point.
func TestTheOwnersReviewAndCallAreCounted(t *testing.T) {
	f := gameOpen(t, t.TempDir())
	if err := f.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.Core.Did(core.OwnerDid{Kind: core.OwnerReviewed, Session: "w1"})
	f.Core.Did(core.OwnerDid{Kind: core.OwnerTalked})
	// Two services, so in either order.
	want := []string{"reviewed", "voice"}
	testkit.Await(t, "the ledger has both", func() ([]string, bool) { k := ledgerKinds(t, f); slices.Sort(k); return k, reflect.DeepEqual(k, want) })
}
