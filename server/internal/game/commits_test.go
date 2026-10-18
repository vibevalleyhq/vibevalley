package game

import (
	"context"
	"path/filepath"
	"slices"
	"testing"

	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
)

func TestSessionsCommitsCountedOncePerRepository(t *testing.T) {
	root := t.TempDir()
	testkit.Repo(t, filepath.Join(root, "projects", "app"), 3, 2)
	tree := filepath.Join(root, "worktrees", "w1")
	testkit.Git(t, filepath.Join(root, "projects", "app"), "worktree", "add", "-q", "-b", "vibevalley/w1", tree)
	testkit.Git(t, tree, "commit", "-q", "--allow-empty", "-m", "session work")
	testkit.Repo(t, filepath.Join(root, "projects", "tools", "cli"), 1, 0)
	w, err := newWorld(fixture.Config(t.TempDir(), root, ""))
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	count := w.Game.Count(context.Background())
	testkit.Eq(t, len(count.Repos), 2, "the worktree is not a second repository")
	testkit.Eq(t, count.Total, int64(5), "3 + 1 on the worktree branch in app, 1 in cli; the colleague's 2 do not count")
	got := []int64{count.Repos[0].Commits, count.Repos[1].Commits}
	slices.Sort(got)
	testkit.Eq(t, got, []int64{1, 4}, "per repository")
}
