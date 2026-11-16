package watch_test

import (
	"context"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/pkg/chord/delta"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/watch"
)

func TestWatchSingleFlightNoOverlap(t *testing.T) {
	doc, err := watch.NewDocument(map[string]any{
		"text":  "",
		"count": int64(0),
	})
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var active atomic.Int32
	var maxActive atomic.Int32
	firstEntered := make(chan struct{})
	releaseFirst := make(chan struct{})
	var deliveryCount atomic.Int32
	doneCh := make(chan watch.Event[map[string]any], 8)

	h, err := doc.Watch(ctx, func(cbCtx context.Context, ev watch.Event[map[string]any]) {
		cur := active.Add(1)
		for {
			prev := maxActive.Load()
			if cur <= prev || maxActive.CompareAndSwap(prev, cur) {
				break
			}
		}
		defer active.Add(-1)

		n := deliveryCount.Add(1)
		if n == 1 {
			close(firstEntered)
			<-releaseFirst
		}
		doneCh <- ev
	})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Stop()

	<-firstEntered

	// While first callback is blocked, publish 50 streaming appends and counter bumps.
	for i := range 50 {
		if _, err := doc.Mutate(func(d *delta.Draft) error {
			if err := d.AppendText([]string{"text"}, fmt.Sprintf("%d,", i)); err != nil {
				return err
			}
			return d.Set([]string{"count"}, int64(i+1))
		}); err != nil {
			t.Fatal(err)
		}
	}

	close(releaseFirst)

	ev1 := <-doneCh
	if ev1.Rev != 1 {
		t.Fatalf("expected initial rev 1, got %d", ev1.Rev)
	}

	var latest watch.Event[map[string]any]
	select {
	case latest = <-doneCh:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for coalesced delivery")
	}

	if maxActive.Load() != 1 {
		t.Fatalf("consumer callback overlapped: maxActive=%d", maxActive.Load())
	}
	if latest.Rev != 51 {
		t.Fatalf("expected coalesced delivery at rev 51, got %d", latest.Rev)
	}
	if latest.Value["count"] != int64(50) {
		t.Fatalf("expected count=50, got %v", latest.Value["count"])
	}
	if len(latest.Ops) != 2 {
		t.Fatalf("expected 50 mutations coalesced to 2 ops (1 append + 1 replace), got %d: %#v", len(latest.Ops), latest.Ops)
	}
}

func TestWatchSlowConsumer15000OpsRootReplace(t *testing.T) {
	initBuckets := make(map[string]any, 100)
	for b := range 100 {
		initBuckets[fmt.Sprintf("b_%d", b)] = map[string]any{}
	}
	doc, err := watch.NewDocument(initBuckets, watch.WithHistorySize[map[string]any](16))
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	firstEntered := make(chan struct{})
	releaseFirst := make(chan struct{})
	events := make(chan watch.Event[map[string]any], 8)
	var callNum atomic.Int32

	h, err := doc.Watch(ctx, func(cbCtx context.Context, ev watch.Event[map[string]any]) {
		if callNum.Add(1) == 1 {
			close(firstEntered)
			<-releaseFirst
		}
		events <- ev
	})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Stop()

	<-firstEntered

	for i := range 15_000 {
		bucket := fmt.Sprintf("b_%d", i%100)
		key := fmt.Sprintf("k_%d", i)
		if _, err := doc.Mutate(func(d *delta.Draft) error {
			return d.Set([]string{bucket, key}, int64(i))
		}); err != nil {
			t.Fatal(err)
		}
	}

	close(releaseFirst)

	ev1 := <-events
	if ev1.Rev != 1 {
		t.Fatalf("expected rev 1, got %d", ev1.Rev)
	}

	var ev2 watch.Event[map[string]any]
	select {
	case ev2 = <-events:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for overflow root replace delivery")
	}

	if !ev2.Overflow {
		t.Fatal("expected Overflow=true after 15,000 slow-consumer ops")
	}
	if ev2.Rev != 15_001 {
		t.Fatalf("expected rev 15001, got %d", ev2.Rev)
	}
	if len(ev2.Ops) != 1 || ev2.Ops[0].Kind != delta.OpReplace || len(ev2.Ops[0].Path) != 0 {
		t.Fatalf("expected single [[\"r\", latestRoot]] op, got %#v", ev2.Ops)
	}

	_, docSnap, _ := doc.Snapshot()
	if !delta.Equal(ev2.Ops[0].Value, docSnap.Value()) {
		t.Fatal("root replace payload does not match latest document snapshot")
	}

	// Verify no extra trailing notifications arrive.
	select {
	case extra := <-events:
		t.Fatalf("unexpected extra event: %#v", extra)
	case <-time.After(30 * time.Millisecond):
	}
}

func TestWatchRetireAndRebuildContinuity(t *testing.T) {
	doc, err := watch.NewDocument(map[string]any{"status": "booting"})
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	events := make(chan watch.Event[map[string]any], 8)
	h, err := doc.Watch(ctx, func(cbCtx context.Context, ev watch.Event[map[string]any]) {
		events <- ev
	})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Stop()

	ev := <-events
	if ev.Rev != 1 || ev.Retired || ev.Value["status"] != "booting" {
		t.Fatalf("unexpected initial event: %#v", ev)
	}

	if _, err := doc.Mutate(func(d *delta.Draft) error {
		return d.Set([]string{"status"}, "running")
	}); err != nil {
		t.Fatal(err)
	}
	ev = <-events
	if ev.Rev != 2 || ev.Retired || ev.Value["status"] != "running" {
		t.Fatalf("unexpected update event: %#v", ev)
	}

	doc.Retire()
	ev = <-events
	if !ev.Retired || ev.Rev != 2 || len(ev.Ops) != 0 || ev.Value["status"] != "running" {
		t.Fatalf("expected retired=true preserving last value without ops, got %#v", ev)
	}

	if _, err := doc.Rebuild(map[string]any{"status": "rebuilt", "epoch": int64(2)}); err != nil {
		t.Fatal(err)
	}
	ev = <-events
	if ev.Retired || ev.Rev != 3 || ev.Value["status"] != "rebuilt" || ev.Value["epoch"] != int64(2) {
		t.Fatalf("unexpected rebuild event: %#v", ev)
	}
	if len(ev.Ops) != 1 || ev.Ops[0].Kind != delta.OpReplace || len(ev.Ops[0].Path) != 0 {
		t.Fatalf("expected root replace on rebuild, got %#v", ev.Ops)
	}
}

func TestWatchIdempotentStopAndInsideCallback(t *testing.T) {
	baseGoroutines := runtime.NumGoroutine()

	doc, err := watch.NewDocument(map[string]any{"x": int64(1)})
	if err != nil {
		t.Fatal(err)
	}

	var hPtr atomic.Pointer[watch.WatchHandle[map[string]any]]
	ready := make(chan struct{})
	stoppedInCb := make(chan struct{})
	h, err := doc.Watch(context.Background(), func(cbCtx context.Context, ev watch.Event[map[string]any]) {
		<-ready
		// Calling Stop inside the callback itself must be safe and non-deadlocking.
		h := hPtr.Load()
		h.Stop()
		h.Stop()
		close(stoppedInCb)
	})
	if err != nil {
		t.Fatal(err)
	}
	hPtr.Store(h)
	close(ready)

	<-stoppedInCb
	h.Stop()
	h.Wait()

	// Context cancellation also tears down cleanly.
	ctx, cancel := context.WithCancel(context.Background())
	h2, err := doc.Watch(ctx, func(cbCtx context.Context, ev watch.Event[map[string]any]) {})
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case <-h2.Done():
	case <-time.After(time.Second):
		t.Fatal("handle did not exit on ctx cancel")
	}

	deadline := time.Now().Add(200 * time.Millisecond)
	for runtime.NumGoroutine() > baseGoroutines && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := runtime.NumGoroutine(); got > baseGoroutines {
		t.Fatalf("goroutine leak: baseline=%d current=%d", baseGoroutines, got)
	}
}

func TestDocumentRingBufferCatchupAndFallback(t *testing.T) {
	doc, err := watch.NewDocument(map[string]any{"n": int64(0), "log": ""}, watch.WithHistorySize[map[string]any](8))
	if err != nil {
		t.Fatal(err)
	}

	for i := int64(1); i <= 12; i++ {
		if _, err := doc.Mutate(func(d *delta.Draft) error {
			if err := d.Set([]string{"n"}, i); err != nil {
				return err
			}
			return d.AppendText([]string{"log"}, fmt.Sprintf("%d,", i))
		}); err != nil {
			t.Fatal(err)
		}
	}
	// Current rev is 13. Ring holds last 8 revisions (6..13), so baseRev = 5.

	// Reconnect at rev 10 (inside ring buffer) -> incremental coalesced ops (no root replace).
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	incCh := make(chan watch.Event[map[string]any], 2)
	hInc, err := doc.Watch(ctx, func(_ context.Context, ev watch.Event[map[string]any]) {
		incCh <- ev
	}, watch.WithFromRev(10))
	if err != nil {
		t.Fatal(err)
	}
	defer hInc.Stop()

	incEv := <-incCh
	if incEv.Rev != 13 || len(incEv.Ops) != 2 {
		t.Fatalf("expected 2 coalesced incremental ops at rev 13, got rev=%d ops=%#v", incEv.Rev, incEv.Ops)
	}
	for _, op := range incEv.Ops {
		if op.Kind == delta.OpReplace && len(op.Path) == 0 {
			t.Fatalf("expected incremental catchup, got root replace: %#v", incEv.Ops)
		}
	}

	// Reconnect at rev 2 (evicted from ring buffer) -> fallback root replace.
	fbCh := make(chan watch.Event[map[string]any], 2)
	hFb, err := doc.Watch(ctx, func(_ context.Context, ev watch.Event[map[string]any]) {
		fbCh <- ev
	}, watch.WithFromRev(2))
	if err != nil {
		t.Fatal(err)
	}
	defer hFb.Stop()

	fbEv := <-fbCh
	if fbEv.Rev != 13 || len(fbEv.Ops) != 1 || fbEv.Ops[0].Kind != delta.OpReplace || len(fbEv.Ops[0].Path) != 0 {
		t.Fatalf("expected fallback root replace at rev 13, got %#v", fbEv)
	}
}

func TestDocumentTypedStructWatch(t *testing.T) {
	type livePanel struct {
		Status string `json:"status"`
		Tokens int64  `json:"tokens"`
	}

	doc, err := watch.NewDocument(livePanel{Status: "idle", Tokens: 0})
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch := make(chan watch.Event[livePanel], 4)
	h, err := doc.Watch(ctx, func(_ context.Context, ev watch.Event[livePanel]) {
		ch <- ev
	})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Stop()

	ev := <-ch
	if ev.Value.Status != "idle" || ev.Value.Tokens != 0 {
		t.Fatalf("unexpected initial struct: %#v", ev.Value)
	}

	if _, err := doc.Mutate(func(d *delta.Draft) error {
		if err := d.Set([]string{"status"}, "streaming"); err != nil {
			return err
		}
		return d.Set([]string{"tokens"}, int64(128))
	}); err != nil {
		t.Fatal(err)
	}

	ev = <-ch
	if ev.Value.Status != "streaming" || ev.Value.Tokens != 128 || ev.Rev != 2 {
		t.Fatalf("unexpected updated struct event: %#v", ev)
	}
}

func TestWatchRawInterface(t *testing.T) {
	doc, err := watch.NewDocument(map[string]any{"msg": "hello"})
	if err != nil {
		t.Fatal(err)
	}
	var src watch.RawSource = doc

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch := make(chan watch.RawEvent, 4)
	rh, err := src.WatchRaw(ctx, 0, func(_ context.Context, ev watch.RawEvent) {
		ch <- ev
	})
	if err != nil {
		t.Fatal(err)
	}
	defer rh.Stop()

	ev := <-ch
	if ev.Rev != 1 || ev.Snapshot == nil {
		t.Fatalf("unexpected raw event: %#v", ev)
	}

	var _ sync.Locker = (*sync.Mutex)(nil)
}
