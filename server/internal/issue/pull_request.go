package issue

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/x/clock"
)

func (s *Service) savePullRequest(id string, pr *protocol.PullRequest) error {
	if err := s.issues.q.SetIssuePullRequest(context.Background(), generated.SetIssuePullRequestParams{ID: id, PullRequest: issueJSON(pr, true)}); err != nil {
		return err
	}
	s.issues.publish(id)
	return nil
}

func (s *Service) pollPullRequests(ctx context.Context) {
	interval := s.poll
	if interval <= 0 {
		interval = 180 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.RefreshPullRequests(ctx); err != nil {
				log.Printf("vibevalley: refresh pull requests: %v", err)
			}
		}
	}
}

func (s *Service) RefreshPullRequests(ctx context.Context) error {
	s.prMu.Lock()
	defer s.prMu.Unlock()
	all, err := s.List()
	if err != nil {
		return err
	}
	var failures []error
	for _, issue := range all {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if issue.PullRequest == nil || issue.PullRequest.State != protocol.PullRequestStateOpen || issue.Project == nil {
			continue
		}
		state, err := s.merges.projects.PullRequestState(ctx, *issue.Project, issue.PullRequest.Number)
		if err == nil && state != protocol.PullRequestStateOpen {
			err = s.finishPullRequest(issue, state)
		}
		if err != nil {
			failures = append(failures, fmt.Errorf("工单 #%d: %w", issue.Number, err))
		}
	}
	return errors.Join(failures...)
}

func (s *Service) finishPullRequest(issue protocol.Issue, state protocol.PullRequestState) error {
	closed := protocol.IssueCloseMerged
	if state == protocol.PullRequestStateClosed {
		closed = protocol.IssueCloseDismissed
	}
	id, err := s.issues.latest(issue.ID)
	if err != nil {
		return err
	}
	if s.merges.sessions.Find(id) != nil {
		if err := s.merges.sessions.FinishPullRequest(id, issue.Number, closed); err != nil {
			return err
		}
	} else if _, err := s.merges.projects.FinishPullRequest(*issue.Project, issue.Number); err != nil {
		return err
	}
	tx, err := s.issues.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	q := s.issues.q.WithTx(tx)
	ctx := context.Background()
	if err := q.CloseIssue(ctx, generated.CloseIssueParams{ID: issue.ID, Closed: issueClosed(&closed), ClosedAt: issueAt(clock.NowMs())}); err != nil {
		return err
	}
	pr := *issue.PullRequest
	pr.State = state
	if err := q.SetIssuePullRequest(ctx, generated.SetIssuePullRequestParams{ID: issue.ID, PullRequest: issueJSON(&pr, true)}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.issues.publish(issue.ID)
	return nil
}
