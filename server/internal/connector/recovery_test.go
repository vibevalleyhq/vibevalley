package connector

import (
	"context"
	"path/filepath"
	"sync/atomic"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/weixin"
)

func TestInboxRecoversAcceptedWorkAfterRestart(t *testing.T) {
	dir := t.TempDir()
	cfg := fixture.Config(filepath.Join(dir, "home"), filepath.Join(dir, "work"), filepath.Join(dir, "farm.db"))
	first, err := newWorld(cfg)
	if err != nil {
		t.Fatal(err)
	}
	b := first.Connector.bridges[protocol.ConnectorIDWeixin]
	ctx := context.Background()
	if err := first.Connector.q.ConnectAccount(ctx, generated.ConnectAccountParams{Connector: string(b.id), Secrets: `{}`, OwnerID: voiceNullable(voiceOwner)}); err != nil {
		t.Fatal(err)
	}
	if err := b.reload(); err != nil {
		t.Fatal(err)
	}
	if err := b.inbox.accept(ctx, []voiceInbound{{ID: "durable", From: voiceOwner, Text: "resume me"}}, "accepted-cursor"); err != nil {
		t.Fatal(err)
	}
	first.DB.Close()
	first.Close()
	second, err := newWorld(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	script := &voiceScript{weixin: make(chan weixin.Message)}
	second.Connector.ilink = voiceScriptedIlink{script}
	var heard atomic.Int32
	second.Connector.say = func(_ context.Context, text string, _ *string) error {
		if text != "resume me" {
			t.Errorf("payload %q", text)
		}
		heard.Add(1)
		return nil
	}
	if err := second.Start(ctx); err != nil {
		t.Fatal(err)
	}
	testkit.Until(t, "durable inbox replay", func() bool { return heard.Load() == 1 })
	testkit.Until(t, "replayed row completed", func() bool {
		rows, err := second.Connector.q.PendingInbound(ctx, string(b.id))
		return err == nil && len(rows) == 0
	})
	row, err := second.Connector.q.ConnectorAccount(ctx, string(b.id))
	if err != nil || row.Cursor != "accepted-cursor" {
		t.Fatalf("cursor: %s %v", row.Cursor, err)
	}
}

func TestInboxReplaysWhenManagerSucceededBeforeCompletionWrite(t *testing.T) {
	f := connectorTestFarm(t)
	b := f.Connector.bridges[protocol.ConnectorIDWeixin]
	ctx := context.Background()
	if err := f.Connector.q.ConnectAccount(ctx, generated.ConnectAccountParams{Connector: string(b.id), Secrets: `{}`, OwnerID: voiceNullable(voiceOwner)}); err != nil {
		t.Fatal(err)
	}
	b.reload()
	if err := b.inbox.accept(ctx, []voiceInbound{{ID: "at-least-once", From: voiceOwner, Text: "work"}}, ""); err != nil {
		t.Fatal(err)
	}
	calls := 0
	f.Connector.say = func(context.Context, string, *string) error { calls++; return nil }
	if _, err := f.DB.Exec(`CREATE TRIGGER fail_delivery BEFORE UPDATE OF delivered ON connector_inbound BEGIN SELECT RAISE(ABORT,'disk failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := b.inbox.drain(ctx); err == nil {
		t.Fatal("completion failure hidden")
	}
	if _, err := f.DB.Exec(`DROP TRIGGER fail_delivery`); err != nil {
		t.Fatal(err)
	}
	recovered := &voiceInbox{bridge: b, wake: make(chan struct{}, 1)}
	if err := recovered.drain(ctx); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("at-least-once attempts %d", calls)
	}
}
