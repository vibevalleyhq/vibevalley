package issue_test

import (
	"context"
	"database/sql"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/db/generated"
)

func TestHistoryReturnsRealSessionsAndExplicitMissingRecords(t *testing.T) {
	f := lifecycleWorld(t)
	issue, err := f.Issue.Add(protocol.IssueRequest{Title: "history"})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	q := generated.New(f.DB)
	old := protocol.Session{ID: "ended", Agent: "lab", Name: "old", Runtime: "pi", Brief: "history", HiredAt: 1}
	if err := q.KeepSession(ctx, generated.KeepSessionParams{ID: old.ID, Agent: old.Agent, Name: old.Name, Runtime: old.Runtime, Brief: old.Brief, HiredAt: old.HiredAt}); err != nil {
		t.Fatal(err)
	}
	if err := q.EndSession(ctx, generated.EndSessionParams{ID: old.ID, EndedAt: sql.NullInt64{Int64: 2, Valid: true}, Closed: sql.NullString{String: "merged", Valid: true}}); err != nil {
		t.Fatal(err)
	}
	live := protocol.Session{ID: "live", Agent: "lab", Name: "current", Runtime: "pi", Brief: "history", HiredAt: 3, Phase: protocol.Phase{Value: protocol.PhaseRipe{}}}
	f.Core.Apply(protocol.FactHired{Session: live})
	for _, s := range []protocol.Session{old, live, {ID: "missing", Agent: "lab", Brief: "history", HiredAt: 4}} {
		if err := f.Issue.Ran(issue.ID, s); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := f.Issue.History()
	if err != nil || len(rows) != 1 {
		t.Fatalf("history: %+v, %v", rows, err)
	}
	got := rows[0]
	if got.Issue.ID != issue.ID || len(got.Sessions) != 2 || got.Sessions[0].ID != old.ID || got.Sessions[1].ID != live.ID {
		t.Fatalf("join/order: %+v", got)
	}
	if _, ok := got.Sessions[0].Phase.Value.(protocol.PhaseClosed); !ok {
		t.Fatalf("ended phase was invented: %T", got.Sessions[0].Phase.Value)
	}
	if _, ok := got.Sessions[1].Phase.Value.(protocol.PhaseRipe); !ok {
		t.Fatalf("live phase was replaced: %T", got.Sessions[1].Phase.Value)
	}
	if len(got.MissingSessions) != 1 || got.MissingSessions[0] != "missing" {
		t.Fatalf("missing record not explicit: %+v", got.MissingSessions)
	}
}

func TestHistoryDoesNotCallUnreadableRecordsMissing(t *testing.T) {
	f := lifecycleWorld(t)
	if _, err := f.Issue.Add(protocol.IssueRequest{Title: "history"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.DB.Exec("DROP TABLE session"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Issue.History(); err == nil {
		t.Fatal("unreadable session store became an empty history")
	}
}
