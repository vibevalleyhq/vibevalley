package memory

import (
	"context"
	"database/sql"
	"fmt"
	"slices"
	"testing"
	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/db/generated"
)

func TestDifferentNotesWithoutTermsAreNotDuplicates(t *testing.T) {
	for _, pair := range [][2]string{{"甲", "乙"}, {"a", "b"}, {"✅", "❌"}} {
		known := []protocol.Memory{{Kind: protocol.MemoryKindNote, Text: pair[0]}}
		if !memoryIsNewNote(known, pair[1], nil) {
			t.Fatalf("distinct notes treated as duplicates: %q", pair)
		}
		if memoryIsNewNote(known, pair[0], nil) {
			t.Fatalf("exact duplicate accepted: %q", pair[0])
		}
	}
}

func TestKeepRollsBackNotesWhenJobWriteFails(t *testing.T) {
	f, err := newWorld(fixture.Config(t.TempDir(), t.TempDir(), ":memory:"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.DB.Exec(`CREATE TRIGGER fail_job BEFORE INSERT ON memory WHEN NEW.kind = 'issue' BEGIN SELECT RAISE(FAIL, 'write failed'); END`); err != nil {
		t.Fatal(err)
	}
	run := FinishedRun{Agent: "lab", Session: "s1", Project: "demo", Job: "work", Said: "记住：不要覆盖用户改动", Outcome: protocol.OutcomeCompleted}
	if err := f.Memory.keep(run); err == nil {
		t.Fatal("expected failure")
	}
	if got := f.Memory.List("lab"); len(got) != 0 {
		t.Fatalf("partial write: %+v", got)
	}
	if _, err := f.DB.Exec(`DROP TRIGGER fail_job`); err != nil {
		t.Fatal(err)
	}
	if err := f.Memory.keep(run); err != nil {
		t.Fatal(err)
	}
	if got := f.Memory.List("lab"); len(got) != 2 {
		t.Fatalf("retry: %+v", got)
	}
}

func TestKeepDeduplicatesSimilarNotesWithinOneRun(t *testing.T) {
	f, err := newWorld(fixture.Config(t.TempDir(), t.TempDir(), ":memory:"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	run := FinishedRun{Agent: "lab", Session: "s1", Project: "demo", Job: "work", Said: "记住：use pnpm test\n记住：use pnpm test!", Outcome: protocol.OutcomeCompleted}
	if err := f.Memory.keep(run); err != nil {
		t.Fatal(err)
	}
	if got := f.Memory.List("lab"); len(got) != 2 {
		t.Fatalf("same-run duplicate: %+v", got)
	}
}

func TestFadingForecastMatchesActualEviction(t *testing.T) {
	f, err := newWorld(fixture.Config(t.TempDir(), t.TempDir(), ":memory:"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	q := generated.New(f.DB)
	for i := range protocol.MemoryKeep {
		id := fmt.Sprintf("old-%03d", i)
		if i%2 == 0 {
			_, err = q.AddNote(context.Background(), generated.AddNoteParams{ID: id, Agent: "lab", Body: id, CreatedAt: 1})
		} else {
			err = q.KeepJob(context.Background(), generated.KeepJobParams{ID: id, Agent: "lab", Body: id, CreatedAt: 1, Session: sql.NullString{String: id, Valid: true}})
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	var predicted []string
	before := f.Memory.List("lab")
	for _, m := range before {
		if m.Fading {
			predicted = append(predicted, m.ID)
		}
	}
	for i, notes := range []string{"记住：apple\n记住：banana\n记住：cherry\n记住：durian", "记住：elephant\n记住：flamingo\n记住：giraffe\n记住：hamster"} {
		if err := f.Memory.keep(FinishedRun{Agent: "lab", Session: fmt.Sprint(i), Project: "demo", Job: "work", Said: notes, Outcome: protocol.OutcomeCompleted}); err != nil {
			t.Fatal(err)
		}
	}
	after := f.Memory.List("lab")
	var removed []string
	for _, m := range before {
		if !slices.ContainsFunc(after, func(a protocol.Memory) bool { return a.ID == m.ID }) {
			removed = append(removed, m.ID)
		}
	}
	if len(predicted) != 10 || !slices.Equal(predicted, removed) {
		t.Fatalf("forecast=%v actual=%v", predicted, removed)
	}
}
