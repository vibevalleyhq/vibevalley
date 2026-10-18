package observe_test

import (
	"context"
	"testing"
	"time"

	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

type recordSource struct{ *kernel.Kernel }

func (s recordSource) ID() string { return s.SessionID() }

func TestSubscriptionCloseFlushesCoalescedTailWithoutTimerWait(t *testing.T) {
	source := recordSource{kernel.New("s")}
	source.Frame(oar.FrameBody{Type: "text", Events: []oar.EventBody{oar.TextDelta{Text: "last"}}}, kernel.RecordAt{})
	got := make(chan string, 1)
	sub := observe.SubscribeEvents(source, func(e oar.Event) {
		if text, ok := e.Body.(oar.TextDelta); ok {
			got <- text.Text
		}
	}, oar.EventsOptions{Cursor: &oar.Cursor{SessionID: "s", AfterSeq: -1}, CoalesceText: true, MaxHoldMs: 60000})
	select {
	case <-got:
		t.Fatal("text was not coalesced")
	default:
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := sub.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if text := <-got; text != "last" {
		t.Fatal(text)
	}
	if err := sub.Close(ctx); err != nil {
		t.Fatal("close not idempotent", err)
	}
}

func TestSubscriptionCancelOwnsPendingTextTimer(t *testing.T) {
	source := recordSource{kernel.New("s")}
	source.Frame(oar.FrameBody{Type: "text", Events: []oar.EventBody{oar.TextDelta{Text: "discard"}}}, kernel.RecordAt{})
	got := make(chan struct{}, 1)
	sub := observe.SubscribeEvents(source, func(oar.Event) { got <- struct{}{} }, oar.EventsOptions{Cursor: &oar.Cursor{SessionID: "s", AfterSeq: -1}, CoalesceText: true, MaxHoldMs: 20})
	sub.Cancel()
	select {
	case <-got:
		t.Fatal("timer delivered text after cancellation")
	case <-time.After(60 * time.Millisecond):
	}
}

func TestSubscriptionCloseWaitsForConsumerAndLiveOnlyHasNoHistoricalDebt(t *testing.T) {
	source := recordSource{kernel.New("s")}
	source.Frame(oar.FrameBody{Type: "old"}, kernel.RecordAt{})
	entered, release := make(chan struct{}), make(chan struct{})
	sub := observe.SubscribeRecords(source, func(oar.RawEvent) { close(entered); <-release }, nil)
	source.Frame(oar.FrameBody{Type: "new"}, kernel.RecordAt{})
	<-entered
	done := make(chan error, 1)
	go func() { done <- sub.Close(context.Background()) }()
	select {
	case err := <-done:
		t.Fatalf("close passed active consumer: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("close did not settle")
	}
}
