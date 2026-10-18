package handler_test

import (
	"context"
	"database/sql"
	"fmt"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"

	"vibevalley/internal/handler"
	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/internal/workspace"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/x/ptr"
)

func TestGitHubRefreshAndTimerFinishPullRequests(t *testing.T) {
	for _, manual := range []bool{true, false} {
		t.Run(fmt.Sprint(manual), func(t *testing.T) {
			cfg := fixture.Config(t.TempDir(), t.TempDir(), ":memory:")
			cfg.GitHub.PRPollSeconds = 1
			f, err := workspace.New(cfg)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(f.Close)
			var views atomic.Int64
			f.Project.GitHubProbe = func(_ context.Context, args ...string) ([]byte, error) {
				switch args[0] {
				case "--version":
					return []byte("gh version 2.80.0"), nil
				case "auth":
					return []byte("Logged in to github.com account gardener (keyring)"), nil
				case "repo":
					return []byte(`{"viewerPermission":"WRITE"}`), nil
				case "pr":
					views.Add(1)
					return []byte(`{"state":"MERGED","mergedAt":"2026-10-18T10:00:00Z"}`), nil
				}
				return nil, fmt.Errorf("unexpected gh %v", args)
			}
			srv := httptest.NewServer(handler.New(f))
			defer srv.Close()
			c := &protocol.Client{Base: srv.URL}
			ctx := context.Background()
			issue, err := c.IssueCreate(ctx, protocol.IssueRequest{Title: "poll", Project: ptr.To("sample")})
			if err != nil {
				t.Fatal(err)
			}
			place, err := f.Project.Workplace("sample", "w1", true, "", issue.Number)
			if err != nil {
				t.Fatal(err)
			}
			testkit.Git(t, place.Cwd, "remote", "add", "origin", "https://github.com/test/sample.git")
			q := generated.New(f.DB)
			if err := q.AddSession(ctx, generated.AddSessionParams{Issue: issue.ID, Session: "w1", StartedAt: 1}); err != nil {
				t.Fatal(err)
			}
			if err := q.SetIssuePullRequest(ctx, generated.SetIssuePullRequestParams{ID: issue.ID, PullRequest: sql.NullString{Valid: true, String: `{"url":"https://github.com/test/sample/pull/7","number":7,"state":"open"}`}}); err != nil {
				t.Fatal(err)
			}
			if manual {
				if _, err := c.GithubRefresh(ctx); err != nil {
					t.Fatal(err)
				}
			} else {
				life, cancel := context.WithCancel(ctx)
				if err := f.Issue.OnStart(life); err != nil {
					t.Fatal(err)
				}
				defer func() { cancel(); f.Issue.OnStop() }()
			}
			testkit.Until(t, "PR closes through API", func() bool {
				got, e := c.IssueGet(ctx, issue.ID)
				return e == nil && got.Closed != nil && *got.Closed == protocol.IssueCloseMerged && got.PullRequest != nil && got.PullRequest.State == protocol.PullRequestStateMerged
			})
			if _, err := os.Stat(place.Cwd); !os.IsNotExist(err) {
				t.Fatalf("worktree remains: %v", err)
			}
			if _, err := c.GithubRefresh(ctx); err != nil {
				t.Fatal(err)
			}
			if views.Load() != 1 {
				t.Fatalf("closed PR was polled again: %d", views.Load())
			}
		})
	}
}
