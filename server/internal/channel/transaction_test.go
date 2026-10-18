package channel

import (
	"errors"
	"testing"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/clock"
)

func TestRolledBackMessageDoesNotResetWakeBreaker(t *testing.T) {
	f, x := chatTestFarm(t, t.TempDir(), ":memory:")
	x.hire(t, "w1", "work", "demo", nil)
	c := f.Channel
	c.mu.Lock()
	defer c.mu.Unlock()
	c.broken["w1"] = true
	c.failures["w1"] = protocol.WakeBreaker
	failure := errors.New("commit failed")
	err := c.inTx(func(s chatStore) error {
		if _, err := s.insertMessage("rollback-message", c.general, "user", "chat", "@w1 retry", true, nil, "", clock.NowMs()); err != nil {
			return err
		}
		written, err := c.settle(s, "rollback-message")
		if err != nil {
			return err
		}
		if len(written.resetWake) != 1 {
			t.Fatalf("expected wake reset after commit: %+v", written)
		}
		return failure
	})
	if !errors.Is(err, failure) {
		t.Fatal(err)
	}
	if !c.broken["w1"] || c.failures["w1"] != protocol.WakeBreaker {
		t.Fatal("rollback changed wake breaker")
	}
	row, err := c.store().message("rollback-message")
	if err != nil || row != nil {
		t.Fatalf("rollback retained message: %+v %v", row, err)
	}
}

func TestReadingReceiptRollsBackAsAUnit(t *testing.T) {
	f, _ := chatTestFarm(t, t.TempDir(), ":memory:")
	c := f.Channel
	c.ManagerSays(c.general, "read", "hello", true, "")
	history, err := c.History(c.general, nil, nil)
	if err != nil || len(history) != 1 {
		t.Fatal(history, err)
	}
	message := history[0]
	if err := c.store().addSeenMark("user", message.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.DB.Exec(`CREATE TRIGGER fail_receipt BEFORE DELETE ON channel_seen_mark BEGIN SELECT RAISE(FAIL,'receipt failed'); END`); err != nil {
		t.Fatal(err)
	}
	if err := c.MarkRead(c.general, message.Number); err == nil {
		t.Fatal("expected failed receipt")
	}
	if cursor, err := c.store().readCursor("user", c.general); err != nil || cursor != nil {
		t.Fatalf("partial cursor: %v %v", cursor, err)
	}
	if _, err := f.DB.Exec(`DROP TRIGGER fail_receipt`); err != nil {
		t.Fatal(err)
	}
	if err := c.MarkRead(c.general, message.Number); err != nil {
		t.Fatal(err)
	}
	if cursor, err := c.store().readCursor("user", c.general); err != nil || cursor == nil || *cursor != message.Number {
		t.Fatalf("cursor: %v %v", cursor, err)
	}
}

func TestThreadOwnerFailureLeavesNoDispatch(t *testing.T) {
	f, _ := chatTestFarm(t, t.TempDir(), ":memory:")
	c := f.Channel
	h := protocol.Session{ID: "unopened", Name: "helper", Brief: "work", Agent: "lab", Runtime: "fake"}
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, err := f.DB.Exec(`CREATE TRIGGER fail_owner BEFORE INSERT ON channel_follow WHEN NEW.reason = 'owner' BEGIN SELECT RAISE(FAIL,'owner failed'); END`); err != nil {
		t.Fatal(err)
	}
	if err := c.openedJob(h); err == nil {
		t.Fatal("expected owner failure")
	}
	history, err := c.History(c.general, nil, nil)
	if err != nil || len(history) != 0 {
		t.Fatalf("orphan dispatch: %+v %v", history, err)
	}
	if _, err := f.DB.Exec(`DROP TRIGGER fail_owner`); err != nil {
		t.Fatal(err)
	}
	if err := c.openedJob(h); err != nil {
		t.Fatal(err)
	}
	thread := c.issueThreadOf(h.ID)
	if thread == nil {
		t.Fatal("missing thread")
	}
	followers, err := c.store().followers(*thread)
	if err != nil || len(followers) != 1 || followers[0] != h.ID {
		t.Fatal(followers, err)
	}
	if err := c.openedJob(h); err != nil {
		t.Fatal(err)
	}
	history, err = c.History(c.general, nil, nil)
	if err != nil || len(history) != 1 {
		t.Fatalf("retry duplicated dispatch: %+v %v", history, err)
	}
}

func TestStreamingCommitCanRetryWithoutAnotherMessage(t *testing.T) {
	f, _ := chatTestFarm(t, t.TempDir(), ":memory:")
	c := f.Channel
	c.ManagerSays(c.general, "stream", "partial", false, "")
	if _, err := f.DB.Exec(`CREATE TRIGGER fail_final BEFORE UPDATE ON channel_message WHEN NEW.final = 1 BEGIN SELECT RAISE(FAIL,'final failed'); END`); err != nil {
		t.Fatal(err)
	}
	c.ManagerSays(c.general, "stream", "complete", true, "")
	history, err := c.History(c.general, nil, nil)
	if err != nil || len(history) != 1 || history[0].Final || history[0].Text != "partial" {
		t.Fatal(history, err)
	}
	if _, err := f.DB.Exec(`DROP TRIGGER fail_final`); err != nil {
		t.Fatal(err)
	}
	c.ManagerSays(c.general, "stream", "complete", true, "")
	history, err = c.History(c.general, nil, nil)
	if err != nil || len(history) != 1 || !history[0].Final || history[0].Text != "complete" {
		t.Fatal(history, err)
	}
}
