package kernel

import (
	"context"
	"errors"
	"sync"
	"testing"

	"vibevalley/pkg/smith/oar"
)

func TestPendingControlOwnsOneReplyAndCanceledWait(t *testing.T) {
	k := New("s")
	p := k.BeginControl(oar.RequestBody{Kind: oar.RequestAbort}, RecordAt{ID: "native-id"})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := p.Wait(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("wait: %v", err)
	}
	var group sync.WaitGroup
	for range 10 {
		group.Go(func() { p.Settle(oar.Accepted()) })
	}
	group.Wait()
	got, err := p.Wait(context.Background())
	if err != nil || got.Request.ID != "native-id" || got.Response.RequestID != "native-id" {
		t.Fatalf("result: %+v %v", got, err)
	}
	if len(k.Records()) != 2 {
		t.Fatalf("duplicate response: %d records", len(k.Records()))
	}
}

func TestPendingControlOwnsReachabilityAndEmptyInput(t *testing.T) {
	k := New("s")
	empty := k.BeginControl(oar.RequestBody{Kind: oar.RequestPrompt}, RecordAt{})
	if !empty.Settled() {
		t.Fatal("empty input not settled")
	}
	k.Respond("", oar.ExitedBody(nil), RecordAt{})
	gone := k.BeginControl(oar.RequestBody{Kind: oar.RequestAbort}, RecordAt{})
	result, err := gone.Wait(context.Background())
	if err != nil || result.Response.Response.Kind != oar.ResponseRejected || result.Response.Response.Code != oar.CodeRuntimeExited {
		t.Fatalf("gone: %+v %v", result, err)
	}
}
