package issue

import (
	"context"
	"encoding/json"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/x/clock"
)

func (d *dispatch) Queue(id string, queued bool) (protocol.Issue, error) {
	return d.issues.queue(id, queued, d.chat.General(), nil)
}

// Queueing keeps the first dispatch context until the issue starts or leaves the queue.
func (is *issues) queue(id string, queued bool, channel string, by *protocol.RunTrigger) (protocol.Issue, error) {
	if _, err := is.unsent(id); err != nil {
		return protocol.Issue{}, err
	}
	ctx := context.Background()
	tx, err := is.db.Begin()
	if err != nil {
		return protocol.Issue{}, err
	}
	defer tx.Rollback()
	q := is.q.WithTx(tx)
	if queued {
		trigger := protocol.RunTrigger{Kind: protocol.RunTriggerKindIssue}
		if by != nil {
			trigger = *by
		}
		body, err := json.Marshal(trigger)
		if err != nil {
			return protocol.Issue{}, err
		}
		if err := q.EnqueueIssue(ctx, generated.EnqueueIssueParams{Issue: id, Channel: channel, TriggeredBy: string(body)}); err != nil {
			return protocol.Issue{}, err
		}
		if err := q.QueueIssue(ctx, generated.QueueIssueParams{At: issueAt(clock.NowMs()), ID: id}); err != nil {
			return protocol.Issue{}, err
		}
	} else {
		if err := q.DequeueIssue(ctx, id); err != nil {
			return protocol.Issue{}, err
		}
		if err := q.UnqueueIssue(ctx, id); err != nil {
			return protocol.Issue{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return protocol.Issue{}, err
	}
	is.publish(id)
	return is.Get(id)
}

func (is *issues) queuedDispatch(id string) (string, protocol.RunTrigger, error) {
	row, err := is.q.QueuedIssue(context.Background(), id)
	if err != nil {
		return "", protocol.RunTrigger{}, err
	}
	var by protocol.RunTrigger
	if err := json.Unmarshal([]byte(row.TriggeredBy), &by); err != nil {
		return "", by, err
	}
	return row.Channel, by, nil
}
