package session

import (
	"context"
	"errors"
	"fmt"

	"vibevalley/internal/project"
	"vibevalley/internal/protocol"
)

func (c *sessions) Merge(id string) (project.Merged, error) {
	return c.harvest(id, protocol.IssueCloseMerged, c.projects.Merge)
}

func (c *sessions) MergeInto(id, target string) ([]string, error) {
	merged, err := c.harvest(id, protocol.IssueCloseMergedIntoGraph, func(place project.Workplace) (project.Merged, error) {
		return c.projects.MergeInto(place, target)
	})
	return merged.Hashes, err
}

// The worktree cannot be woken or dismissed between closing smith and finishing the merge. A failed merge retains
// the hand and its branch; only a successful merge revokes the identity and publishes departure.
func (c *sessions) harvest(id string, closed protocol.IssueClose, merge func(project.Workplace) (project.Merged, error)) (project.Merged, error) {
	c.admission.Lock()
	defer c.admission.Unlock()
	h, current := c.hand(id), c.core.Session(id)
	if h == nil || current == nil {
		return project.Merged{}, protocol.Missing{What: "帮工 " + id}
	}
	if closed == protocol.IssueCloseMerged && current.Graph != nil {
		return project.Merged{}, protocol.Refused{Reason: fmt.Sprintf("%s 在做种植计划 %s 里的活：做完会自动合进计划分支，收获整个计划时再进主分支", current.Name, current.Graph.ID)}
	}
	h.mu.Lock()
	pending := len(h.triggers) > 0
	h.mu.Unlock()
	if protocol.IsBusy(*current) || pending {
		return project.Merged{}, protocol.Refused{Reason: current.Name + " 还在干活：等这一轮做完，或者先叫停，再收"}
	}
	c.rest(h)
	merged, err := merge(h.place)
	if err != nil {
		var failure project.MergeFailure
		if errors.As(err, &failure) && failure.Kind == "conflict" {
			c.core.Apply(protocol.FactConflict{ID: id, Conflict: &protocol.Conflict{Base: failure.Base, Files: failure.Files}})
		}
		return project.Merged{}, err
	}
	if merged.PullRequest != nil {
		return merged, nil
	}
	commits := int64(0)
	if closed == protocol.IssueCloseMerged {
		commits = int64(merged.Commits)
	}
	c.leave(h, closed, commits)
	if merged.Warning != "" {
		c.core.Notice(protocol.NoticeLevelWarn, merged.Warning)
	}
	return merged, nil
}

func (c *sessions) SubmitPullRequest(ctx context.Context, id string, issue protocol.Issue, save func(*protocol.PullRequest) error) (project.Merged, error) {
	return c.harvest(id, protocol.IssueCloseMerged, func(place project.Workplace) (project.Merged, error) {
		h := c.hand(id)
		h.mu.Lock()
		conclusion := pullRequestConclusion(h.lastText)
		h.mu.Unlock()
		pr, err := c.projects.SubmitPullRequest(ctx, place, issue, conclusion)
		if err != nil {
			return project.Merged{}, err
		}
		if err := save(pr); err != nil {
			return project.Merged{}, err
		}
		return project.Merged{PullRequest: pr, Text: "PR：" + pr.URL}, nil
	})
}

func (c *sessions) FinishPullRequest(id string, number int64, closed protocol.IssueClose) error {
	_, err := c.harvest(id, closed, func(place project.Workplace) (project.Merged, error) {
		return c.projects.FinishPullRequest(place.Project, number)
	})
	return err
}
