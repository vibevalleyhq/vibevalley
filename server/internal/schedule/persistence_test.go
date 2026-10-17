package schedule

import (
	"context"
	"testing"
	"time"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/db/generated"
)

func TestTickRetriesWithoutPublishingAfterWriteFailure(t *testing.T) {
	f := open(t, t.TempDir())
	defer f.Close()
	now := int64(1_800_000_000_000)
	f.Schedule.Now = func() int64 { return now }
	sc, err := f.Schedule.Add(protocol.ScheduleRequest{Name: "retry", Text: "work", When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenOnce{At: now + 1}}})
	if err != nil {
		t.Fatal(err)
	}
	due, stop := f.Schedule.Due().Subscribe()
	defer stop()
	if _, err := f.DB.Exec(`CREATE TRIGGER fail_run BEFORE UPDATE OF last_run ON schedule BEGIN SELECT RAISE(FAIL, 'write failed'); END`); err != nil {
		t.Fatal(err)
	}
	now++
	f.Schedule.Tick()
	if got := f.Schedule.List()[0]; !got.Enabled || got.LastRun != nil {
		t.Fatalf("advanced after failure: %+v", got)
	}
	for _, got := range f.Core.State().Schedules {
		if got.ID == sc.ID && (!got.Enabled || got.LastRun != nil) {
			t.Fatalf("published after failure: %+v", got)
		}
	}
	select {
	case got := <-due:
		t.Fatalf("dispatched after failure: %+v", got)
	default:
	}
	if _, err := f.DB.Exec(`DROP TRIGGER fail_run`); err != nil {
		t.Fatal(err)
	}
	f.Schedule.Tick()
	select {
	case got := <-due:
		if got.Schedule.ID != sc.ID {
			t.Fatal(got)
		}
	case <-time.After(time.Second):
		t.Fatal("retry did not dispatch")
	}
}

func TestEnableRecurringScheduleHasNoPartialCommit(t *testing.T) {
	f := open(t, t.TempDir())
	defer f.Close()
	sc, err := f.Schedule.Add(protocol.ScheduleRequest{Name: "recurring", Text: "work", When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenEvery{Minutes: 5}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Schedule.SetEnabled(sc.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := f.DB.Exec(`CREATE TRIGGER fail_run BEFORE UPDATE OF last_run ON schedule BEGIN SELECT RAISE(FAIL, 'write failed'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Schedule.SetEnabled(sc.ID, true); err == nil {
		t.Fatal("expected failure")
	}
	rows, err := generated.New(f.DB).Schedules(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Enabled || rows[0].LastRun.Valid {
		t.Fatalf("partial commit: %+v", rows)
	}
	if f.Schedule.List()[0].Enabled {
		t.Fatal("memory changed")
	}
}
