package project

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
)

func TestGitHubProbe(t *testing.T) {
	for _, tc := range []struct {
		name, auth          string
		versionErr, authErr error
		installed, logged   bool
		account, reason     string
	}{
		{"missing", "", exec.ErrNotFound, nil, false, false, "", "没装 gh"},
		{"logged out", "", nil, errors.New("secret"), true, false, "", "没登录 GitHub"},
		{"logged in", "github.com\n  ✓ Logged in to github.com account gardener (keyring)\n  - Active account: true\n  - Token: secret", nil, nil, true, true, "gardener", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			run := func(_ context.Context, args ...string) ([]byte, error) {
				if args[0] == "--version" {
					return []byte("gh version 2.80.0 (2025-09-01)\n"), tc.versionErr
				}
				return []byte(tc.auth), tc.authErr
			}
			got := probeGitHub(context.Background(), run)
			if got.Installed != tc.installed || got.LoggedIn != tc.logged || got.Account != tc.account || got.Reason != tc.reason {
				t.Fatalf("%+v", got)
			}
			if strings.Contains(got.Reason+got.Account+got.Version, "secret") {
				t.Fatal("leaked command output")
			}
		})
	}
}

func TestGitHubPermissionsAndCache(t *testing.T) {
	p := projects(t, projectsDir(t))
	made, err := p.Create(protocol.NewProject{Name: "garden"})
	if err != nil {
		t.Fatal(err)
	}
	testkit.Git(t, made.Path, "remote", "add", "origin", "git@github.com:owner/repo.git")
	calls := 0
	permission := "WRITE"
	p.GitHubProbe = func(_ context.Context, args ...string) ([]byte, error) {
		calls++
		switch args[0] {
		case "--version":
			return []byte("gh version 2.80.0"), nil
		case "auth":
			return []byte("Logged in to github.com account gardener (keyring)\n- Active account: true"), nil
		default:
			return []byte(`{"viewerPermission":"` + permission + `"}`), nil
		}
	}
	p.RefreshGitHub(context.Background())
	for _, perm := range []string{"WRITE", "ADMIN", "MAINTAIN", "READ", "TRIAGE"} {
		permission = perm
		p.RefreshGitHub(context.Background())
		before := calls
		for range 2 {
			got := p.Summary(made).PullRequest
			want := perm == "WRITE" || perm == "ADMIN" || perm == "MAINTAIN"
			if got.Available != want || (!want && got.Reason != "没有写权限") {
				t.Fatalf("%s: %+v", perm, got)
			}
		}
		if calls != before {
			t.Fatal("list invoked gh")
		}
	}
	testkit.Git(t, made.Path, "remote", "set-url", "origin", "https://gitlab.com/owner/repo")
	p.RefreshGitHub(context.Background())
	if got := p.Summary(made).PullRequest; got.Available || got.Reason != "不是 GitHub 仓库" {
		t.Fatalf("%+v", got)
	}
}

func TestGitHubOrigins(t *testing.T) {
	for _, s := range []string{"git@github.com:owner/repo.git", "ssh://git@github.com/owner/repo.git", "https://github.com/owner/repo.git"} {
		if githubOrigin(s) != "owner/repo" {
			t.Fatal(s)
		}
	}
	for _, s := range []string{"https://github.com.evil/o/r", "https://token@github.com/o/r", "/tmp/repo", "https://github.com/o/r/issues"} {
		if githubOrigin(s) != "" {
			t.Fatal(s)
		}
	}
}

func TestGitHubRefreshClearsPermissionsWhenLoggedOut(t *testing.T) {
	p := projects(t, projectsDir(t))
	made, err := p.Create(protocol.NewProject{Name: "garden"})
	if err != nil {
		t.Fatal(err)
	}
	testkit.Git(t, made.Path, "remote", "add", "origin", "https://github.com/owner/repo.git")
	mode := "logged in"
	p.GitHubProbe = func(_ context.Context, args ...string) ([]byte, error) {
		if mode == "missing" {
			return nil, exec.ErrNotFound
		}
		if args[0] == "--version" {
			return []byte("gh version 2.80.0"), nil
		}
		if mode == "logged out" {
			return []byte("token: secret"), errors.New("secret")
		}
		if args[0] == "auth" {
			return []byte("Logged in to github.com account gardener (keyring)"), nil
		}
		return []byte(`{"viewerPermission":"WRITE"}`), nil
	}
	p.RefreshGitHub(context.Background())
	if !p.Summary(made).PullRequest.Available {
		t.Fatal("expected write permission")
	}
	for _, tc := range []struct{ mode, reason string }{{"logged out", "没登录 GitHub"}, {"missing", "没装 gh"}} {
		mode = tc.mode
		status := p.RefreshGitHub(context.Background())
		got := p.Summary(made).PullRequest
		if got.Available || got.Reason != tc.reason || status.Reason != tc.reason {
			t.Fatalf("%+v %+v", status, got)
		}
	}
}
