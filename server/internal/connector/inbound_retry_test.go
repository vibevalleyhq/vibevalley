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

func TestWeixinRetriesFailedPageWithoutAdvancingCursor(t *testing.T) {
	for _, failure := range []string{"database", "say", "cursor"} {
		t.Run(failure, func(t *testing.T) {
			f := connectorTestFarm(t)
			b := f.Connector.bridges[protocol.ConnectorIDWeixin]
			ctx := context.Background()
			if err := f.Connector.q.ConnectAccount(ctx, generated.ConnectAccountParams{Connector: string(b.id), Secrets: `{}`, OwnerID: voiceNullable(voiceOwner)}); err != nil {
				t.Fatal(err)
			}
			if err := b.reload(); err != nil {
				t.Fatal(err)
			}
			page := &replayPage{message: voiceWx(voiceOwner, "do work", "reply")}
			f.Connector.ilink = page
			calls := 0
			broken := true
			f.Connector.say = func(context.Context, string, *string) error {
				calls++
				if failure == "say" && broken {
					return errors.New("manager unavailable")
				}
				return nil
			}
			if failure == "database" {
				if _, err := f.DB.Exec(`ALTER TABLE connector_inbound RENAME TO saved_inbound`); err != nil {
					t.Fatal(err)
				}
			}
			saved := "old-page"
			run := func() *voiceFailure {
				receive, cancel := context.WithCancel(ctx)
				defer cancel()
				return b.adapter.Receive(receive, map[string]string{}, voiceReceiving{
					Cursor: saved,
					Got:    func(m voiceInbound) error { return b.got(receive, m) },
					SaveCursor: func(cursor string) error {
						if failure == "cursor" && broken {
							return errors.New("cursor write failed")
						}
						saved = cursor
						cancel()
						return nil
					},
				})
			}
			if err := run(); err == nil {
				t.Fatal("page failure was hidden")
			}
			if saved != "old-page" {
				t.Fatal("failed page was acknowledged")
			}
			if failure == "database" {
				if calls != 0 {
					t.Fatal("ran command without duplicate check")
				}
				if _, err := f.DB.Exec(`ALTER TABLE saved_inbound RENAME TO connector_inbound`); err != nil {
					t.Fatal(err)
				}
			}
			if failure == "say" {
				if _, err := f.Connector.q.InboundSeen(ctx, generated.InboundSeenParams{Connector: string(b.id), ExtID: page.message.MessageID}); err == nil {
					t.Fatal("failed handoff was marked consumed")
				}
			}
			broken = false
			if err := run(); err != nil {
				t.Fatal(err)
			}
			if saved != "next-page" {
				t.Fatalf("recovered cursor: %s", saved)
			}
			if len(page.cursors) != 2 || page.cursors[0] != "old-page" || page.cursors[1] != "old-page" {
				t.Fatalf("replayed cursors: %v", page.cursors)
			}
			want := 1
			if failure == "say" {
				want = 2
			}
			if calls != want {
				t.Fatalf("handoffs: got %d want %d", calls, want)
			}
			if _, err := f.Connector.q.InboundSeen(ctx, generated.InboundSeenParams{Connector: string(b.id), ExtID: page.message.MessageID}); err != nil {
				t.Fatal(err)
			}
		})
	}
}
