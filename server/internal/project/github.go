package project

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/clock"
)

type githubDetection struct {
	GitHubProbe    func(context.Context, ...string) ([]byte, error)
	githubRefresh  sync.Mutex
	githubMu       sync.RWMutex
	githubStatus   protocol.GitHubStatus
	githubProjects map[string]protocol.PullRequestCapability
}

var ghVersion = regexp.MustCompile(`(?m)^gh version ([0-9]+\.[0-9]+\.[0-9]+)`)
var ghAccount = regexp.MustCompile(`Logged in to github\.com account ([A-Za-z0-9-]+)(?:\s|$)`)
var ghOrigin = regexp.MustCompile(`^(?:https://github\.com/|ssh://git@github\.com/|git@github\.com:)([A-Za-z0-9-]+)/([A-Za-z0-9_.-]+)/?$`)

func githubOrigin(origin string) string {
	m := ghOrigin.FindStringSubmatch(strings.TrimSpace(origin))
	if m == nil {
		return ""
	}
	repo := strings.TrimSuffix(m[2], ".git")
	if repo == "" || repo == "." || repo == ".." {
		return ""
	}
	return m[1] + "/" + repo
}

func runGitHub(ctx context.Context, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	// Auth status writes to stderr; raw output must never escape the probe.
	cmd := exec.CommandContext(ctx, "gh", args...)
	cmd.Env = append(os.Environ(), "GH_HOST=github.com", "GH_PROMPT_DISABLED=1")
	return cmd.CombinedOutput()
}

func probeGitHub(ctx context.Context, run func(context.Context, ...string) ([]byte, error)) protocol.GitHubStatus {
	s := protocol.GitHubStatus{CheckedAt: clock.NowMs()}
	out, err := run(ctx, "--version")
	if err != nil {
		s.Reason = "gh 检测失败"
		if errors.Is(err, exec.ErrNotFound) {
			s.Reason = "没装 gh"
		}
		return s
	}
	s.Installed = true
	if m := ghVersion.FindSubmatch(out); m != nil {
		s.Version = string(m[1])
	}
	out, err = run(ctx, "auth", "status", "--hostname", "github.com", "--active")
	if err != nil {
		s.Reason = "没登录 GitHub"
		return s
	}
	m := ghAccount.FindSubmatch(out)
	if m == nil {
		s.Reason = "无法确认 GitHub 登录账号"
		return s
	}
	s.LoggedIn = true
	s.Account = string(m[1])
	return s
}

func (p *Service) GitHubStatus() protocol.GitHubStatus {
	p.githubMu.RLock()
	defer p.githubMu.RUnlock()
	if p.githubStatus.CheckedAt == 0 {
		return protocol.GitHubStatus{Reason: "尚未检测 GitHub"}
	}
	return p.githubStatus
}

func (p *Service) RefreshGitHub(ctx context.Context) protocol.GitHubStatus {
	// Serialize refreshes so an earlier observation cannot replace a newer one.
	p.githubRefresh.Lock()
	defer p.githubRefresh.Unlock()
	run := p.GitHubProbe
	if run == nil {
		run = runGitHub
	}
	status := probeGitHub(ctx, run)
	projects := map[string]protocol.PullRequestCapability{}
	for _, project := range p.List() {
		capability := protocol.PullRequestCapability{Reason: status.Reason}
		if status.LoggedIn {
			origin, _, err := gitRun(ctx, project.Path, "remote", "get-url", "origin")
			repo := githubOrigin(origin)
			if !project.Git || err != nil || repo == "" {
				capability.Reason = "不是 GitHub 仓库"
			} else {
				out, err := run(ctx, "repo", "view", repo, "--json", "viewerPermission")
				var result struct {
					ViewerPermission string `json:"viewerPermission"`
				}
				if err != nil || json.Unmarshal(out, &result) != nil {
					capability.Reason = "无法检测 GitHub 仓库权限"
				} else {
					switch result.ViewerPermission {
					case "ADMIN", "MAINTAIN", "WRITE":
						capability.Available = true
						capability.Reason = ""
					default:
						capability.Reason = "没有写权限"
					}
				}
			}
		}
		projects[project.Name] = capability
	}
	p.githubMu.Lock()
	p.githubStatus, p.githubProjects = status, projects
	p.githubMu.Unlock()
	return status
}

func (p *Service) pullRequestCapability(name string) protocol.PullRequestCapability {
	p.githubMu.RLock()
	defer p.githubMu.RUnlock()
	if c, ok := p.githubProjects[name]; ok {
		return c
	}
	if p.githubStatus.Reason != "" {
		return protocol.PullRequestCapability{Reason: p.githubStatus.Reason}
	}
	return protocol.PullRequestCapability{Reason: "尚未检测项目，请刷新 GitHub 状态"}
}
