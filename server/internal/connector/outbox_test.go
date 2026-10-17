package connector

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/pkg/db/generated"
)

type blockedDelivery struct {
	voiceAdapter
	once    sync.Once
	entered chan struct{}
	release chan struct{}
}

func (a *blockedDelivery) Send(ctx context.Context, secrets map[string]string, to, text, reply string) (string, *voiceFailure) {
	a.once.Do(func() {
		close(a.entered)
		select {
		case <-a.release:
		case <-ctx.Done():
		}
	})
	return a.voiceAdapter.Send(ctx, secrets, to, text, reply)
}

func TestOutboxOwnsDeliveryWithoutBlockingFarmEvents(t *testing.T) {
	f, s := voiceConnectorsFarm(t)
	b := f.Connector.bridges[protocol.ConnectorIDWeixin]
	blocked := &blockedDelivery{voiceAdapter: b.adapter, entered: make(chan struct{}), release: make(chan struct{})}
	b.adapter = blocked
	defer close(blocked.release)
	voiceWeixinConnected(t, f)
	f.Channel.ManagerSays(f.Channel.General(), "first", "第一条", true)
	select {
	case <-blocked.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("delivery did not start")
	}
	f.Channel.ManagerSays(f.Channel.General(), "second", "第二条", true)
	testkit.Until(t, "second event queued while delivery is blocked", func() bool { return voiceStatusOf(f, protocol.ConnectorIDWeixin).Pending == 2 })
	if len(s.sentBy(protocol.ConnectorIDWeixin)) != 0 {
		t.Fatal("blocked adapter unexpectedly sent")
	}
}

func TestOutboxConfirmsDigestAsOneBatch(t *testing.T) {
	f, s := voiceConnectorsFarm(t)
	b := f.Connector.bridges[protocol.ConnectorIDWeixin]
	ctx := context.Background()
	if err := f.Connector.q.ConnectAccount(ctx, generated.ConnectAccountParams{Connector: string(b.id), Secrets: `{}`, OwnerID: voiceNullable(voiceOwner)}); err != nil {
		t.Fatal(err)
	}
	if err := b.reload(); err != nil {
		t.Fatal(err)
	}
	for i := range 4 {
		m, err := f.Channel.Say(fmt.Sprint(i), nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := f.Connector.q.AddOutbox(ctx, generated.AddOutboxParams{ID: fmt.Sprint("batch-", i), Connector: string(b.id), MessageID: m.ID, Body: fmt.Sprint("【管家】\n", i), CreatedAt: int64(i)}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.DB.Exec(`CREATE TRIGGER fail_confirmation BEFORE UPDATE ON connector_outbox WHEN NEW.id='batch-3' AND NEW.state='sent' BEGIN SELECT RAISE(ABORT,'confirm failed'); END`); err != nil {
		t.Fatal(err)
	}
	b.outbox.reply(ctx)
	pending, err := f.Connector.q.CountPendingOutbox(ctx, string(b.id))
	if err != nil || pending != 4 {
		t.Fatalf("partial batch confirmation: %d %v", pending, err)
	}
	if len(s.sentBy(protocol.ConnectorIDWeixin)) != 1 {
		t.Fatal("digest was not one external delivery")
	}
	if _, err := f.DB.Exec(`DROP TRIGGER fail_confirmation`); err != nil {
		t.Fatal(err)
	}
	b.outbox.reply(ctx)
	pending, err = f.Connector.q.CountPendingOutbox(ctx, string(b.id))
	if err != nil || pending != 0 {
		t.Fatalf("recovered confirmation: %d %v", pending, err)
	}
}
