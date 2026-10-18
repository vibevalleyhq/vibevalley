package connector

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"vibevalley/internal/base"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/x/clock"
)

// Transport acknowledgement means durable acceptance, not completion of the manager's turn.
type voiceInbox struct {
	bridge *voiceBridge
	wake   chan struct{}
}

func (i *voiceInbox) accept(ctx context.Context, messages []voiceInbound, cursor string) error {
	b := i.bridge
	err := b.accountChange(ctx, func(q *generated.Queries) error {
		if _, err := q.ConnectorAccount(ctx, string(b.id)); err != nil {
			return err
		}
		for _, m := range messages {
			if m.ID == "" {
				m.ID = base.NewID()
			}
			payload, err := json.Marshal(m)
			if err != nil {
				return err
			}
			if err := q.AcceptInbound(ctx, generated.AcceptInboundParams{Connector: string(b.id), ExtID: m.ID, Payload: string(payload), CreatedAt: clock.NowMs()}); err != nil {
				return err
			}
		}
		if cursor != "" {
			return q.AccountCursor(ctx, generated.AccountCursorParams{Connector: string(b.id), Cursor: cursor})
		}
		return nil
	})
	if err != nil {
		if ctx.Err() == nil {
			b.setErr(err.Error())
		}
		return err
	}
	select {
	case i.wake <- struct{}{}:
	default:
	}
	return nil
}

func (i *voiceInbox) drain(ctx context.Context) error {
	b := i.bridge
	rows, err := b.c.q.PendingInbound(ctx, string(b.id))
	if err != nil {
		return err
	}
	for _, row := range rows {
		if err := ctx.Err(); err != nil {
			return err
		}
		var m voiceInbound
		if err := json.Unmarshal([]byte(row.Payload), &m); err != nil {
			return err
		}
		if m.ID != row.ExtID {
			return errors.New("收件记录的编号不一致")
		}
		if err := b.got(ctx, m); err != nil {
			return err
		}
		if err := b.c.q.DeliverInbound(ctx, generated.DeliverInboundParams{Connector: string(b.id), ExtID: row.ExtID}); err != nil {
			return err
		}
	}
	return nil
}

func (i *voiceInbox) run(ctx context.Context) {
	for ctx.Err() == nil {
		if err := i.drain(ctx); err != nil && ctx.Err() == nil {
			i.bridge.setErr(err.Error())
		}
		timer := time.NewTimer(time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-i.wake:
			timer.Stop()
		case <-timer.C:
		}
	}
}

// SDK handlers may outlive Listen. Seal acceptance and join in-flight writes before the receiver returns.
func (i *voiceInbox) receive(ctx context.Context, secrets map[string]string) *voiceFailure {
	b := i.bridge
	row, err := b.c.q.ConnectorAccount(ctx, string(b.id))
	if err != nil {
		return &voiceFailure{Kind: "failed", Reason: err.Error()}
	}
	var mu sync.Mutex
	var pending sync.WaitGroup
	closed := false
	accept := func(messages []voiceInbound, cursor string) error {
		mu.Lock()
		if closed || ctx.Err() != nil {
			mu.Unlock()
			return context.Canceled
		}
		pending.Add(1)
		mu.Unlock()
		defer pending.Done()
		return i.accept(ctx, messages, cursor)
	}
	result := b.adapter.Receive(ctx, secrets, voiceReceiving{Cursor: row.Cursor, Accept: accept})
	mu.Lock()
	closed = true
	mu.Unlock()
	pending.Wait()
	return result
}
