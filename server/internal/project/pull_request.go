package project

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"vibevalley/internal/protocol"
)

func (p *Service) UsesPullRequests(name string) bool {
	return slices.Contains(p.prProjects, name) && p.pullRequestCapability(name).Available
}

func (p *Service) github(ctx context.Context, args ...string) ([]byte, error) {
	if p.GitHubProbe != nil {
		return p.GitHubProbe(ctx, args...)
	}
	return runGitHub(ctx, args...)
}

func (p *Service) githubRepo(ctx context.Context, name string) (string, error) {
	origin, _, err := gitRun(ctx, filepath.Join(p.root, name), "remote", "get-url", "origin")
	if err != nil {
		return "", err
	}
	repo := githubOrigin(origin)
	if repo == "" {
		return "", fmt.Errorf("不是 GitHub 仓库")
	}
	return repo, nil
}

func (p *Service) SubmitPullRequest(ctx context.Context, place Workplace, issue protocol.Issue, conclusion string) (*protocol.PullRequest, error) {
	if place.Branch != IssueBranch(issue.Number) {
		return nil, fmt.Errorf("工单分支不匹配")
	}
	checked, err := p.checkMerge(place, "")
	if err != nil {
		return nil, failed(err)
	}
	defer p.serially(place.Project)()
	path := filepath.Join(p.root, place.Project)
	if err := unchangedBranch(path, place.Branch, checked); err != nil {
		return nil, failed(err)
	}
	repo, err := p.githubRepo(ctx, place.Project)
	if err != nil {
		return nil, err
	}
	main, err := git(path, "symbolic-ref", "--short", "HEAD")
	if err != nil {
		return nil, err
	}
	files, err := conflictsOf(path, main, checked)
	if err != nil {
		return nil, err
	}
	if len(files) > 0 {
		return nil, MergeFailure{Kind: "conflict", Base: main, Files: files}
	}
	pushCtx, cancel := context.WithTimeout(ctx, cloneTimeout)
	defer cancel()
	if p.GitPush != nil {
		err = p.GitPush(pushCtx, place.Cwd, place.Branch)
	} else {
		_, _, err = gitRun(pushCtx, place.Cwd, "push", "-u", "origin", place.Branch)
	}
	if err != nil {
		return nil, fmt.Errorf("推送工单分支失败，请检查 origin 和登录后重试")
	}
	if issue.PullRequest != nil && issue.PullRequest.State == protocol.PullRequestStateOpen {
		return issue.PullRequest, nil
	}
	// Recover a successful creation whose receipt was lost before it reached SQLite.
	out, err := p.github(ctx, "pr", "list", "--repo", repo, "--head", place.Branch, "--base", main, "--state", "open", "--json", "url,number")
	if err != nil {
		return nil, fmt.Errorf("查询已有 PR 失败；分支已推送，可重试")
	}
	var existing []protocol.PullRequest
	if err := json.Unmarshal(out, &existing); err != nil {
		return nil, fmt.Errorf("无法读取已有 PR")
	}
	if len(existing) > 0 {
		pr := existing[0]
		pr.State = protocol.PullRequestStateOpen
		return &pr, nil
	}
	body := fmt.Sprintf("工单 #%d\n\n%s\n\n检查通过（没有 .vibevalley/check 时按项目默认规则放行）。", issue.Number, conclusion)
	out, err = p.github(ctx, "pr", "create", "--repo", repo, "--head", place.Branch, "--base", main, "--title", issue.Title, "--body", body)
	if err != nil {
		return nil, fmt.Errorf("创建 PR 失败；分支已推送，可重试")
	}
	url := strings.TrimSpace(string(out))
	prefix := "https://github.com/" + repo + "/pull/"
	number, err := strconv.ParseInt(strings.TrimPrefix(url, prefix), 10, 64)
	if err != nil || number <= 0 || !strings.HasPrefix(url, prefix) {
		return nil, fmt.Errorf("无法读取新建 PR 的地址；可重试查询")
	}
	return &protocol.PullRequest{URL: url, Number: number, State: protocol.PullRequestStateOpen}, nil
}

func (p *Service) PullRequestState(ctx context.Context, name string, number int64) (protocol.PullRequestState, error) {
	repo, err := p.githubRepo(ctx, name)
	if err != nil {
		return "", err
	}
	out, err := p.github(ctx, "pr", "view", strconv.FormatInt(number, 10), "--repo", repo, "--json", "state,mergedAt")
	if err != nil {
		return "", fmt.Errorf("查询 PR #%d 失败", number)
	}
	var result struct {
		State    string     `json:"state"`
		MergedAt *time.Time `json:"mergedAt"`
	}
	if json.Unmarshal(out, &result) != nil {
		return "", fmt.Errorf("无法读取 PR #%d 状态", number)
	}
	if result.MergedAt != nil || result.State == "MERGED" {
		return protocol.PullRequestStateMerged, nil
	}
	switch result.State {
	case "OPEN":
		return protocol.PullRequestStateOpen, nil
	case "CLOSED":
		return protocol.PullRequestStateClosed, nil
	default:
		return "", fmt.Errorf("无法识别 PR #%d 状态", number)
	}
}

func (p *Service) issueWorkplace(name string, number int64) Workplace {
	return Workplace{Project: name, Cwd: filepath.Join(p.trees, fmt.Sprintf("%s.%d", name, number)), Branch: IssueBranch(number)}
}

func (p *Service) FinishPullRequest(name string, number int64) (Merged, error) {
	defer p.serially(name)()
	place := p.issueWorkplace(name, number)
	path := filepath.Join(p.root, name)
	if _, err := os.Stat(place.Cwd); err == nil {
		if _, err := git(path, "worktree", "remove", "--force", place.Cwd); err != nil {
			return Merged{}, fmt.Errorf("PR 已结束，清理 worktree 失败：%w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return Merged{}, err
	}
	if gitOk(path, "show-ref", "--verify", "refs/heads/"+place.Branch) {
		if _, err := git(path, "branch", "-D", place.Branch); err != nil {
			return Merged{}, fmt.Errorf("PR 已结束，清理本地分支失败：%w", err)
		}
	}
	return Merged{}, nil
}
