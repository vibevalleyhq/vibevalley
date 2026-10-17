package issue_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/session"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/internal/workspace"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/oartest"
)

func lifecycleWorld(t *testing.T) *workspace.Workspace {
	t.Helper()
	cfg := fixture.Config(t.TempDir(), t.TempDir(), ":memory:")
	cfg.Project.MaxSessions = 1
	f, err := workspace.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	f.Runtime.Registry, err = oar.NewRuntimeRegistry(oartest.Runtime(oartest.Options{ID: "pi", Turn: func(turn *oartest.Turn) error { <-turn.Context.Done(); return nil }}))
	if err != nil {
		t.Fatal(err)
	}
	f.Runtime.Probe = func(context.Context, string) protocol.RuntimeInfo { return fixture.Pi() }
	t.Cleanup(func() { f.Session.OnStop(); f.Core.Close(); f.Close() })
	return f
}

func noWorktree(t *testing.T, f *workspace.Workspace) {
	t.Helper()
	cmd := exec.Command("git", "worktree", "list", "--porcelain")
	cmd.Dir = filepath.Join(f.WorkRoot, "demo")
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(out), "worktree ") != 1 {
		t.Fatalf("orphan worktree: %s", out)
	}
	cmd = exec.Command("git", "branch", "--list", "vibevalley/*")
	cmd.Dir = filepath.Join(f.WorkRoot, "demo")
	out, err = cmd.Output()
	if err != nil || strings.TrimSpace(string(out)) != "" {
		t.Fatalf("orphan branch: %s (%v)", out, err)
	}
}

func TestFailedSpawnReleasesWorktree(t *testing.T) {
	f := lifecycleWorld(t)
	a := fixture.Lab(t)
	a.Runtime, a.Worktree = "missing-runtime", true
	got := f.Session.Send(context.Background(), a, "test", "demo", session.HireOptions{})
	if got.Refused == "" || got.Session != nil {
		t.Fatalf("spawn = %+v", got)
	}
	noWorktree(t, f)
}

func TestFailedIssueLinkDoesNotPublishOrKeepSession(t *testing.T) {
	f := lifecycleWorld(t)
	if _, err := f.DB.Exec(`CREATE TRIGGER reject_issue BEFORE INSERT ON issue BEGIN SELECT RAISE(ABORT, 'test write failure'); END`); err != nil {
		t.Fatal(err)
	}
	a := fixture.Lab(t)
	a.Worktree = true
	got := f.Issue.Hire(context.Background(), a, "test", "demo", session.HireOptions{})
	if !strings.Contains(got.Refused, "test write failure") || got.Session != nil {
		t.Fatalf("hire = %+v", got)
	}
	if len(f.Core.State().Sessions) != 0 || len(f.Session.Roster()) != 0 {
		t.Fatal("failed link left a session visible")
	}
	noWorktree(t, f)
}

func TestConcurrentSendHonorsProjectCapacity(t *testing.T) {
	f := lifecycleWorld(t)
	a := fixture.Lab(t)
	var wg sync.WaitGroup
	gate := make(chan struct{})
	results := make(chan session.Hired, 2)
	for range 2 {
		wg.Go(func() {
			<-gate
			results <- f.Session.Send(context.Background(), a, "test", "demo", session.HireOptions{})
		})
	}
	close(gate)
	wg.Wait()
	close(results)
	admitted := 0
	for got := range results {
		if got.Session != nil {
			admitted++
		} else if got.Refused == "" {
			t.Fatal("refusal lacks a reason")
		}
	}
	if admitted != 1 || len(f.Core.State().Sessions) != 1 {
		t.Fatalf("admitted %d sessions into one slot", admitted)
	}
}

func TestMoveDoesNotRewritePlaybookRanks(t *testing.T) {
	f := lifecycleWorld(t)
	one, err := f.Issue.Add(protocol.IssueRequest{Title: "one"})
	if err != nil {
		t.Fatal(err)
	}
	pb := protocol.Playbook{ID: "p1", Title: "plan", Project: "demo", State: protocol.PlaybookStateDraft, Nodes: []protocol.PlaybookNode{{ID: "a", Title: "first", State: protocol.NodeStateWaiting}, {ID: "b", Title: "second", State: protocol.NodeStateWaiting}}}
	if err := f.Issue.PutPlaybook(pb); err != nil {
		t.Fatal(err)
	}
	q := generated.New(f.DB)
	before, err := q.Family(context.Background(), pb.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Issue.Move(one.ID, ""); err != nil {
		t.Fatal(err)
	}
	for _, was := range before {
		now, err := q.GetIssue(context.Background(), was.ID)
		if err != nil {
			t.Fatal(err)
		}
		if now.Rank != was.Rank {
			t.Fatalf("%s rank changed from %d to %d", was.ID, was.Rank, now.Rank)
		}
	}
}

func TestResolveReturnsGitFailure(t *testing.T) {
	f := lifecycleWorld(t)
	got := f.Issue.Hire(context.Background(), fixture.Lab(t), "test", "demo", session.HireOptions{})
	if got.Session == nil {
		t.Fatal(got.Refused)
	}
	repo := filepath.Join(f.WorkRoot, "demo")
	if err := os.Rename(filepath.Join(repo, ".git"), filepath.Join(repo, ".git-hidden")); err != nil {
		t.Fatal(err)
	}
	err := f.Issue.Resolve(*got.Session.Issue)
	if err == nil || strings.Contains(err.Error(), "没有冲突") {
		t.Fatalf("git failure masked as no conflicts: %v", err)
	}
}

func TestIssueActionsOwnLatestExecution(t *testing.T) {
	f := lifecycleWorld(t)
	first := f.Issue.Hire(context.Background(), fixture.Lab(t), "first", "demo", session.HireOptions{})
	if first.Session == nil {
		t.Fatal(first.Refused)
	}
	id := *first.Session.Issue
	f.Session.Dismiss(first.Session.ID)
	second := f.Issue.Hire(context.Background(), fixture.Lab(t), "second", "demo", session.HireOptions{Issue: id})
	if second.Session == nil {
		t.Fatal(second.Refused)
	}
	if _, err := f.Issue.Changes(id, protocol.CallerOwner); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Issue.Merge(id); err == nil {
		t.Fatal("busy execution accepted for harvest")
	}
	if f.Session.Find(second.Session.ID) == nil {
		t.Fatal("refused harvest removed active execution")
	}
	if err := f.Issue.Cancel(id); err != nil {
		t.Fatal(err)
	}
	if f.Session.Find(second.Session.ID) != nil {
		t.Fatal("cancel by issue did not dismiss latest execution")
	}
	if _, err := f.Issue.Changes(id, protocol.CallerOwner); err == nil {
		t.Fatal("closed execution reported an empty successful preview")
	}
}
