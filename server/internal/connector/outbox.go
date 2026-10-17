package connector

import (
	"context"
	"database/sql"
	"log"
	"sync"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/x/clock"
)

// Held messages are tried again after voiceRetryFirst, then twice as long after each try that fails, up to
// voiceRetryMost; one going out starts over. The owner's next message sends them at once anyway. Variables: tests
// shorten them.
var (
	voiceRetryFirst = 30 * time.Second
	voiceRetryMost  = 30 * time.Minute
)

func voiceRetryAfter(wait time.Duration, clear bool) time.Duration {
	if clear {
		return voiceRetryFirst
	}
	return min(2*wait, voiceRetryMost)
}

type voiceOutbox struct {
	bridge  *voiceBridge
	sending sync.Mutex
	wake    chan struct{}
}

func (o *voiceOutbox) run(ctx context.Context) {
	wait := voiceRetryFirst
	timer := time.NewTimer(wait)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-o.wake:
			o.drain(ctx, false)
			wait = voiceRetryFirst
		case <-timer.C:
			wait = voiceRetryAfter(wait, o.drain(ctx, false))
		}
		timer.Reset(wait)
	}
}

// A fresh reply opens the platform's delivery window; older messages precede its answer.
func (o *voiceOutbox) reply(ctx context.Context) { o.drain(ctx, true) }

func (o *voiceOutbox) retire(ctx context.Context, q *generated.Queries, reason string) error {
	return q.DropPendingOutbox(ctx, generated.DropPendingOutboxParams{Error: voiceNullable(reason), Connector: string(o.bridge.id)})
}

func (o *voiceOutbox) confirm(ctx context.Context, ids []string, ext string) error {
	b := o.bridge
	tx, err := b.c.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	q := b.c.q.WithTx(tx)
	for _, id := range ids {
		if err := q.OutboxSent(ctx, generated.OutboxSentParams{SentAt: sql.NullInt64{Int64: clock.NowMs(), Valid: true}, ExtID: voiceNullable(ext), ID: id}); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Stops at the first the app will not take. late: it waited, so many go as one digest.
func (o *voiceOutbox) drain(ctx context.Context, late bool) bool {
	o.sending.Lock()
	defer o.sending.Unlock()
	b := o.bridge
	if ctx.Err() != nil {
		return false
	}
	a := b.accountNow()
	if a == nil || a.owner == "" || a.paused() {
		return true
	}
	pending, err := b.c.q.PendingOutbox(ctx, string(b.id))
	if err != nil {
		log.Printf("vibevalley: %s: %v", b.id, err)
		return false
	}
	if len(pending) == 0 {
		return true
	}
	type batch struct {
		ids  []string
		text string
	}
	var batches []batch
	if late && len(pending) > digestOver {
		lines := make([]string, len(pending))
		ids := make([]string, len(pending))
		for i, r := range pending {
			lines[i], ids[i] = r.Body, r.ID
		}
		batches = []batch{{ids, flushText(lines)[0]}}
	} else {
		for _, r := range pending {
			batches = append(batches, batch{[]string{r.ID}, r.Body})
		}
	}
	for _, out := range batches {
		ext, failure := b.adapter.Send(ctx, a.secrets, a.owner, out.text, a.replyContext)
		if failure == nil {
			if err := o.confirm(ctx, out.ids, ext); err != nil {
				b.setErr(err.Error())
				return false
			}
			b.setErr("")
			continue
		}
		for _, id := range out.ids {
			b.kept(b.c.q.OutboxFailed(ctx, generated.OutboxFailedParams{Error: voiceNullable(failure.Reason), ID: id}))
		}
		switch failure.Kind {
		case "stale":
			b.pause()
		case "restricted":
			// The app would not take it now (WeChat's, QQ's reply window): tried again later, and with the owner's
			// next message.
			b.setErr("")
		default:
			b.setErr(failure.Reason)
		}
		return false
	}
	return true
}

func (o *voiceOutbox) offer(m protocol.ChatMessage, state *protocol.CoreState) {
	b := o.bridge
	a := b.accountNow()
	if a == nil || a.owner == "" || !forOwner(m) {
		return
	}
	var chat *protocol.Chat
	if state != nil {
		chat = state.Chat
	}
	where := protocol.ConversationOf(chat, m.Conversation)
	var mine *string
	if a.channel != nil {
		mine = a.channel
	} else if general := protocol.GeneralOf(chat); general != nil {
		mine = &general.ID
	}
	channel := protocol.ChannelOf(chat, where)
	if (channel == nil) != (mine == nil) || (channel != nil && channel.ID != *mine) {
		return
	}
	ctx := context.Background()
	tx, err := b.c.db.BeginTx(ctx, nil)
	if err != nil {
		b.setErr(err.Error())
		return
	}
	defer tx.Rollback()
	q := b.c.q.WithTx(tx)
	for _, piece := range splitText(ownerLine(m, where), maxChars[b.id]) {
		if err := q.AddOutbox(ctx, generated.AddOutboxParams{ID: base.NewID(), Connector: string(b.id), MessageID: m.ID, Body: piece, CreatedAt: clock.NowMs()}); err != nil {
			b.setErr(err.Error())
			return
		}
	}
	if err := tx.Commit(); err != nil {
		b.setErr(err.Error())
		return
	}
	select {
	case o.wake <- struct{}{}:
	default:
	}
}
