package workspace

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/x/ptr"
)

func TestPullRequestHarvest(t *testing.T) {
	for _, ending := range []string{"MERGED", "CLOSED"} {
		t.Run(ending, func(t *testing.T) {
			home, work := dirs(t)
			configure := func(c *base.Config) { c.GitHub.PRProjects = []string{"clock"} }
			db := filepath.Join(home, "test.db")
			w := openWorldAt(t, home, work, db, configure)
			lab := fixture.Lab(t)
			w.f.Agent.SaveAgent(lab)
			issue, err := w.f.Issue.Add(protocol.IssueRequest{Title: "写版本A", Project: ptr.To("clock"), Assignee: &lab.ID})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = w.f.Issue.Start(context.Background(), issue.ID, ""); err != nil {
				t.Fatal(err)
			}
			w.nextReport(t)
			issue, _ = w.f.Issue.Get(issue.ID)
			id := issue.Sessions[len(issue.Sessions)-1]
			place, _ := w.f.Session.Place(id)
			path := filepath.Join(work, "projects", "clock")
			bare := filepath.Join(work, "origin.git")
			testkit.Git(t, work, "init", "--bare", bare)
			testkit.Git(t, path, "remote", "add", "origin", "https://github.com/test/clock.git")
			testkit.Git(t, path, "remote", "set-url", "--push", "origin", bare)
			before := testkit.Git(t, path, "rev-parse", "main")
			creates, pushes := 0, 0
			state := "OPEN"
			// Finish the startup probe before replacing its runner.
			w.f.Project.RefreshGitHub(context.Background())
			probe := func(_ context.Context, args ...string) ([]byte, error) {
				switch args[0] {
				case "--version":
					return []byte("gh version 2.80.0"), nil
				case "auth":
					return []byte("Logged in to github.com account gardener (keyring)"), nil
				case "repo":
					return []byte(`{"viewerPermission":"WRITE"}`), nil
				case "pr":
					switch args[1] {
					case "list":
						return []byte(`[]`), nil
					case "create":
						creates++
						for _, word := range []string{"--head", place.Branch, "--base", "main", "--title", issue.Title} {
							if !slices.Contains(args, word) {
								t.Fatalf("missing %s: %v", word, args)
							}
						}
						body := args[slices.Index(args, "--body")+1]
						if !strings.Contains(body, fmt.Sprintf("#%d", issue.Number)) || !strings.Contains(body, "写版本A") || !strings.Contains(body, "检查") {
							t.Fatalf("body: %s", body)
						}
						return []byte("https://github.com/test/clock/pull/7\n"), nil
					case "view":
						return []byte(fmt.Sprintf(`{"state":%q,"mergedAt":null}`, state)), nil
					}
				}
				return nil, fmt.Errorf("unexpected gh %v", args)
			}
			w.f.Project.GitHubProbe = probe
			w.f.Project.GitFetch = func(_ context.Context, cwd, branch string) error { return sessionGit(cwd, "fetch", bare, branch) }
			w.f.Project.GitPush = func(ctx context.Context, cwd, branch string) error {
				pushes++
				return sessionGit(cwd, "push", "-u", "origin", branch)
			}
			w.f.Project.RefreshGitHub(context.Background())
			moveDone := func() protocol.Issue {
				t.Helper()
				got, e := w.f.Issue.SetStatus(context.Background(), issue.ID, protocol.IssueStatusDone, "", "")
				if e != nil {
					t.Fatal(e)
				}
				return got
			}
			issue = moveDone()
			if issue.PullRequest == nil || issue.PullRequest.Number != 7 || issue.PullRequest.State != protocol.PullRequestStateOpen || issue.PullRequest.URL != "https://github.com/test/clock/pull/7" {
				t.Fatalf("PR: %+v", issue.PullRequest)
			}
			testkit.Eq(t, issue.Status, protocol.IssueStatusInReview, "review stays open")
			testkit.Eq(t, testkit.Git(t, path, "rev-parse", "main"), before, "main untouched")
			testkit.Eq(t, testkit.Git(t, bare, "rev-parse", place.Branch), testkit.Git(t, place.Cwd, "rev-parse", "HEAD"), "branch pushed")
			if _, err := w.f.Issue.SetStatus(context.Background(), issue.ID, protocol.IssueStatusTodo, "再写版本B", ""); err != nil {
				t.Fatal(err)
			}
			w.nextReport(t)
			issue = moveDone()
			testkit.Eq(t, []int{creates, pushes}, []int{1, 2}, "second harvest only pushes")
			testkit.Eq(t, testkit.Git(t, bare, "rev-parse", place.Branch), testkit.Git(t, place.Cwd, "rev-parse", "HEAD"), "second round pushed")
			w.stop()
			w = openWorldAt(t, home, work, db, configure)
			w.f.Project.RefreshGitHub(context.Background())
			w.f.Project.GitHubProbe = probe
			w.f.Project.GitFetch = func(_ context.Context, cwd, branch string) error { return sessionGit(cwd, "fetch", bare, branch) }
			restored, e := w.f.Issue.Get(issue.ID)
			if e != nil || restored.PullRequest == nil || restored.PullRequest.Number != 7 {
				t.Fatalf("restored: %+v %v", restored, e)
			}
			state = ending
			if err := w.f.Issue.RefreshPullRequests(context.Background()); err != nil {
				t.Fatal(err)
			}
			issue, _ = w.f.Issue.Get(issue.ID)
			want := protocol.IssueCloseMerged
			if ending == "CLOSED" {
				want = protocol.IssueCloseDismissed
			}
			if issue.Closed == nil || *issue.Closed != want {
				t.Fatalf("closed: %+v", issue)
			}
			if w.f.Session.Find(id) != nil {
				t.Fatal("helper still present")
			}
			if _, err := os.Stat(place.Cwd); !os.IsNotExist(err) {
				t.Fatalf("worktree remains: %v", err)
			}
			if err := sessionGit(path, "show-ref", "--verify", "refs/heads/"+place.Branch); err == nil {
				t.Fatal("branch remains")
			}
		})
	}
}
