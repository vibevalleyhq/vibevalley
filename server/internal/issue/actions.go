package issue

import (
	"context"
	"vibevalley/internal/protocol"
)

func (s *Service) liveSession(id string) (string, error) {
	session, err := s.issues.latest(id)
	if err != nil {
		return "", err
	}
	if s.merges.sessions.Find(session) == nil {
		return "", protocol.Missing{What: "帮工 " + session}
	}
	return session, nil
}

func (s *Service) Comment(id string, body protocol.CommentRequest) error {
	issue, err := s.Get(id)
	if err != nil {
		return err
	}
	if issue.Status == protocol.IssueStatusDone || issue.Status == protocol.IssueStatusCanceled {
		return protocol.Refused{Reason: "这张工单关上了：带一句话重开它"}
	}
	session, err := s.liveSession(id)
	if err != nil {
		return err
	}
	_, err = s.merges.chat.TellSession("user", session, body.Text)
	return err
}

func (s *Service) Changes(id string, by protocol.Caller) (protocol.Changes, error) {
	session, err := s.liveSession(id)
	if err != nil {
		return protocol.Changes{}, err
	}
	changes, err := s.merges.changesFor(session, by)
	if err != nil {
		return protocol.Changes{}, err
	}
	if changes == nil {
		return protocol.Changes{}, protocol.Missing{What: "帮工 " + session}
	}
	return *changes, nil
}

func (s *Service) Merge(id string) (string, error) {
	s.prMu.Lock()
	defer s.prMu.Unlock()
	issue, err := s.Get(id)
	if err != nil {
		return "", err
	}
	session, err := s.liveSession(id)
	if err != nil {
		return "", err
	}
	if issue.Project != nil && issue.Graph == nil && issue.Task == nil && ((issue.PullRequest != nil && issue.PullRequest.State == protocol.PullRequestStateOpen) || s.merges.projects.UsesPullRequests(*issue.Project)) {
		merged, err := s.merges.sessions.SubmitPullRequest(context.Background(), session, issue, func(pr *protocol.PullRequest) error { return s.savePullRequest(issue.ID, pr) })
		if err != nil {
			return "", s.merges.mergeError(session, err)
		}
		return merged.Text, nil
	}
	return s.merges.merge(session)
}

func (s *Service) Resolve(id string) error {
	session, err := s.liveSession(id)
	if err != nil {
		return err
	}
	return s.merges.resolve(session)
}

func (s *Service) Cancel(id string) error {
	session, err := s.liveSession(id)
	if err != nil {
		return err
	}
	if !s.merges.sessions.Dismiss(session) {
		return protocol.Missing{What: "帮工 " + session}
	}
	return nil
}
