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
