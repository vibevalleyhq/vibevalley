package issue

// An issue for the manager (protocol.ManagerAgent) is handed to the manager, not to a session. It is open while the manager works on it and
// closed as answered once it has; a run of it is the manager's (session.Service.OpenRun).

import (
	"context"
	"database/sql"
	"errors"
	"log"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/x/clock"
)

type ManagerWork struct {
	Issue   protocol.Issue
	Channel string
	By      protocol.RunTrigger
	// The schedule that came due, when one did.
	Schedule *protocol.Schedule
}

func (is *issues) OfSchedule(id string) (protocol.Issue, bool) {
	row, err := is.q.LatestOfSchedule(context.Background(), sql.NullString{String: id, Valid: true})
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			log.Printf("vibevalley: schedule %s's issue: %v", id, err)
		}
		return protocol.Issue{}, false
	}
	issue, err := is.Get(row.ID)
	return issue, err == nil
}

func (is *issues) Answered(id string) error {
	answered := protocol.IssueCloseAnswered
	if err := is.q.CloseIssue(context.Background(), generated.CloseIssueParams{ClosedAt: issueAt(clock.NowMs()), Closed: issueClosed(&answered), ID: id}); err != nil {
		return err
	}
	is.publish(id)
	return nil
}

func (is *issues) reopen(id string) error {
	if err := is.q.ReopenIssue(context.Background(), id); err != nil {
		return err
	}
	is.publish(id)
	return nil
}

// The manager's turn on them stopped with the server.
func (is *issues) closeManagersOpen(ctx context.Context) {
	ids, err := is.q.OpenOf(ctx, sql.NullString{String: protocol.ManagerAgent, Valid: true})
	if err != nil {
		log.Printf("vibevalley: the manager's open issues: %v", err)
		return
	}
	lost := protocol.IssueCloseLost
	for _, id := range ids {
		if err := is.q.CloseIssue(ctx, generated.CloseIssueParams{ClosedAt: issueAt(clock.NowMs()), Closed: issueClosed(&lost), ID: id}); err == nil {
			is.publish(id)
		}
	}
}

func (d *dispatch) ForManager() *base.Hub[ManagerWork] { return d.forManager }

func (d *dispatch) toManager(issue protocol.Issue, channel string, by protocol.RunTrigger, due *protocol.Schedule) error {
	if isClosed(issue.Status) {
		if err := d.issues.reopen(issue.ID); err != nil {
			return err
		}
	}
	d.forManager.Publish(ManagerWork{Issue: issue, Channel: channel, By: by, Schedule: due})
	return nil
}
