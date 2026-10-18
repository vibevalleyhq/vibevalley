package connector

import (
	"context"
	"errors"
	"testing"
	"time"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/weixin"
)

type replayPage struct {
	voiceScriptedIlink
	message weixin.Message
	cursors []string
}

func (p *replayPage) GetUpdates(_ context.Context, _ weixin.Account, cursor string, _ time.Duration) (weixin.Updates, error) {
	p.cursors = append(p.cursors, cursor)
	return weixin.Updates{Msgs: []weixin.Message{p.message}, GetUpdatesBuf: "next-page"}, nil
}

func TestWeixinPageAcceptanceIsAtomicAndDeliveryRetries(t *testing.T) {
	f := connectorTestFarm(t)
	b := f.Connector.bridges[protocol.ConnectorIDWeixin]
	ctx := context.Background()
	if err := f.Connector.q.ConnectAccount(ctx, generated.ConnectAccountParams{Connector: string(b.id), Secrets: `{}`, OwnerID: voiceNullable(voiceOwner)}); err != nil {
		t.Fatal(err)
	}
	if err := b.reload(); err != nil {
		t.Fatal(err)
	}
	page := &replayPage{message: voiceWx(voiceOwner, "work", "reply")}
	f.Connector.ilink = page
	if _, err := f.DB.Exec(`CREATE TRIGGER fail_cursor BEFORE UPDATE OF cursor ON connector_account BEGIN SELECT RAISE(ABORT,'disk failure'); END`); err != nil {
		t.Fatal(err)
	}
	run := func() *voiceFailure {
		receive, cancel := context.WithCancel(ctx)
		defer cancel()
		row, err := f.Connector.q.ConnectorAccount(ctx, string(b.id))
		if err != nil {
			t.Fatal(err)
		}
		return b.adapter.Receive(receive, nil, voiceReceiving{Cursor: row.Cursor, Accept: func(ms []voiceInbound, cursor string) error {
			err := b.inbox.accept(receive, ms, cursor)
			if err == nil {
				cancel()
			}
			return err
		}})
	}
	if err := run(); err == nil {
		t.Fatal("cursor failure hidden")
	}
	rows, err := f.Connector.q.PendingInbound(ctx, string(b.id))
	if err != nil || len(rows) != 0 {
		t.Fatalf("partial page: %v %v", rows, err)
	}
	if _, err := f.DB.Exec(`DROP TRIGGER fail_cursor`); err != nil {
		t.Fatal(err)
	}
	if err := run(); err != nil {
		t.Fatal(err)
	}
	row, _ := f.Connector.q.ConnectorAccount(ctx, string(b.id))
	if row.Cursor != "next-page" {
		t.Fatal(row.Cursor)
	}
	if len(page.cursors) != 2 || page.cursors[0] != "" || page.cursors[1] != "" {
		t.Fatal(page.cursors)
	}
	if err := run(); err != nil {
		t.Fatal(err)
	}
	rows, _ = f.Connector.q.PendingInbound(ctx, string(b.id))
	if len(rows) != 1 {
		t.Fatal("duplicate page created duplicate inbox rows")
	}
	attempts := 0
	f.Connector.say = func(context.Context, string, *string) error {
		attempts++
		if attempts == 1 {
			return errors.New("manager down")
		}
		return nil
	}
	if err := b.inbox.drain(ctx); err == nil {
		t.Fatal("delivery failure hidden")
	}
	rows, _ = f.Connector.q.PendingInbound(ctx, string(b.id))
	if len(rows) != 1 {
		t.Fatal("failed delivery was acknowledged")
	}
	if err := b.inbox.drain(ctx); err != nil {
		t.Fatal(err)
	}
	rows, _ = f.Connector.q.PendingInbound(ctx, string(b.id))
	if len(rows) != 0 || attempts != 2 {
		t.Fatalf("pending %d attempts %d", len(rows), attempts)
	}
}
