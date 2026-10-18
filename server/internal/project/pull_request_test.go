package project

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
)

func TestPullRequestRequiresOptInAndCapability(t *testing.T) {
	p := projects(t, projectsDir(t), func(c *base.Config) { c.GitHub.PRProjects = []string{"enabled"} })
	p.githubProjects = map[string]protocol.PullRequestCapability{"other": {Available: true}}
	if p.UsesPullRequests("other") || p.UsesPullRequests("enabled") {
		t.Fatal("both opt-in and capability required")
	}
	p.githubProjects["enabled"] = protocol.PullRequestCapability{Available: true}
	if !p.UsesPullRequests("enabled") {
		t.Fatal("enabled project must use PRs")
	}
}

func TestPullRequestFailuresAndRecovery(t *testing.T) {
	p := projects(t, projectsDir(t))
	place, err := p.Workplace("sample", "w1", true, "", 1)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(p.root, "sample")
	testkit.Git(t, path, "remote", "add", "origin", "https://github.com/test/sample.git")
	os.MkdirAll(filepath.Join(place.Cwd, ".vibevalley"), 0o755)
	check := filepath.Join(place.Cwd, ".vibevalley/check")
	os.WriteFile(check, []byte("#!/bin/sh\necho check-failed\nexit 1\n"), 0o755)
	pushes, calls := 0, 0
	pushFails := true
	p.GitPush = func(context.Context, string, string) error {
		pushes++
		if pushFails {
			return fmt.Errorf("offline")
		}
		return nil
	}
	p.GitHubProbe = func(_ context.Context, args ...string) ([]byte, error) {
		calls++
		if args[0] != "pr" || args[1] != "list" {
			t.Fatalf("unexpected gh: %v", args)
		}
		return []byte(`[{"url":"https://github.com/test/sample/pull/4","number":4}]`), nil
	}
	issue := protocol.Issue{Number: 1, Title: "sample"}
	if _, err := p.SubmitPullRequest(context.Background(), place, issue, "done"); err == nil {
		t.Fatal("failed check accepted")
	}
	testkit.Eq(t, []int{pushes, calls}, []int{0, 0}, "check runs first")
	os.WriteFile(check, []byte("#!/bin/sh\nexit 0\n"), 0o755)
	if _, err := p.SubmitPullRequest(context.Background(), place, issue, "done"); err == nil {
		t.Fatal("failed push accepted")
	}
	testkit.Eq(t, calls, 0, "no PR after failed push")
	pushFails = false
	pr, err := p.SubmitPullRequest(context.Background(), place, issue, "done")
	if err != nil || pr == nil || pr.Number != 4 {
		t.Fatalf("recover existing: %+v %v", pr, err)
	}
	testkit.Eq(t, calls, 1, "recover without creation")
	if _, err := os.Stat(place.Cwd); err != nil {
		t.Fatal(err)
	}
}

func TestPullRequestCheckDescription(t *testing.T) {
	for _, hasCheck := range []bool{false, true} {
		t.Run(fmt.Sprint(hasCheck), func(t *testing.T) {
			p := projects(t, projectsDir(t))
			place, err := p.Workplace("sample", "w1", true, "", 1)
			if err != nil {
				t.Fatal(err)
			}
			testkit.Git(t, filepath.Join(p.root, "sample"), "remote", "add", "origin", "https://github.com/test/sample.git")
			want := "这个项目没有 .vibevalley/check，没跑检查。"
			if hasCheck {
				os.MkdirAll(filepath.Join(place.Cwd, ".vibevalley"), 0o755)
				os.WriteFile(filepath.Join(place.Cwd, ".vibevalley/check"), []byte("#!/bin/sh\nexit 0\n"), 0o755)
				want = ".vibevalley/check 通过。"
			}
			p.GitPush = func(context.Context, string, string) error { return nil }
			p.GitHubProbe = func(_ context.Context, args ...string) ([]byte, error) {
				if args[1] == "list" {
					return []byte("[]"), nil
				}
				testkit.Eq(t, args[len(args)-1], "工单 #1\n\ndone\n\n"+want, "body")
				return []byte("https://github.com/test/sample/pull/1"), nil
			}
			if _, err := p.SubmitPullRequest(context.Background(), place, protocol.Issue{Number: 1, Title: "sample"}, "done"); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestPullRequestSyncMain(t *testing.T) {
	for _, mode := range []string{"checked-out", "other-branch", "dirty", "diverged", "fetch-failure", "not-enabled"} {
		t.Run(mode, func(t *testing.T) {
			p := projects(t, projectsDir(t), func(c *base.Config) { c.GitHub.PRProjects = []string{"sample"} })
			if _, err := p.ensure("sample"); err != nil {
				t.Fatal(err)
			}
			p.githubProjects = map[string]protocol.PullRequestCapability{"sample": {Available: mode != "not-enabled"}}
			path := filepath.Join(p.root, "sample")
			origin := filepath.Join(t.TempDir(), "origin.git")
			testkit.Git(t, path, "clone", "--bare", path, origin)
			testkit.Git(t, path, "remote", "add", "origin", origin)
			testkit.Git(t, path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
			old := testkit.Git(t, path, "rev-parse", "main")
			remote := filepath.Join(t.TempDir(), "remote")
			testkit.Git(t, path, "clone", origin, remote)
			testkit.Git(t, remote, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "--allow-empty", "-m", "remote change")
			testkit.Git(t, remote, "push", "origin", "main")
			latest := testkit.Git(t, remote, "rev-parse", "HEAD")
			want := latest
			switch mode {
			case "other-branch":
				testkit.Git(t, path, "checkout", "-b", "personal")
			case "dirty":
				os.WriteFile(filepath.Join(path, "dirty"), []byte("keep"), 0o644)
				want = old
			case "diverged":
				testkit.Git(t, path, "commit", "--allow-empty", "-m", "local change")
				want = testkit.Git(t, path, "rev-parse", "HEAD")
			case "fetch-failure":
				p.GitFetch = func(_ context.Context, cwd, branch string) error {
					testkit.Eq(t, cwd, path, "fetch directory")
					testkit.Eq(t, branch, "main", "fetch branch")
					return fmt.Errorf("offline")
				}
				want = old
			case "not-enabled":
				want = old
			}
			place, err := p.Workplace("sample", "w1", true, "", 1)
			if err != nil {
				t.Fatal(err)
			}
			testkit.Eq(t, testkit.Git(t, place.Cwd, "rev-parse", "HEAD"), want, "new issue base")
			testkit.Eq(t, testkit.Git(t, path, "rev-parse", "main"), want, "local main")
			if mode == "checked-out" {
				testkit.Git(t, remote, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "--allow-empty", "-m", "merged PR")
				testkit.Git(t, remote, "push", "origin", "main")
				if _, err := p.FinishPullRequest("sample", 1); err != nil {
					t.Fatal(err)
				}
				testkit.Eq(t, testkit.Git(t, path, "rev-parse", "main"), testkit.Git(t, remote, "rev-parse", "HEAD"), "finished PR updates main")
			}
		})
	}
}
