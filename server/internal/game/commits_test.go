package game

import (
	"context"
	"path/filepath"
	"slices"
	"testing"

	"vibevalley/internal/base"
	"vibevalley/internal/farmtest"
)

// Commits on real git repositories in throwaway folders (commits.test.ts). Offline.

func TestCrewCommitsCountedOncePerRepository(t *testing.T) {
	root := t.TempDir()
	farmtest.Repo(t, filepath.Join(root, "app"), 3, 2)
	// A helper's worktree: one more commit of mine on its branch, in the same repository.
	tree := filepath.Join(root, ".worktrees", "w1")
	farmtest.Git(t, filepath.Join(root, "app"), "worktree", "add", "-q", "-b", "vibevalley/w1", tree)
	farmtest.Git(t, tree, "commit", "-q", "--allow-empty", "-m", "helper work")
	// Another repository, one level deeper.
	farmtest.Repo(t, filepath.Join(root, "tools", "cli"), 1, 0)
	c, _ := newCommits(base.Config{WorkRoot: root}, nil)
	count := c.Count(context.Background())
	farmtest.Eq(t, len(count.Repos), 2, "the worktree is not a second repository")
	farmtest.Eq(t, count.Total, int64(5), "3 + 1 on the worktree branch in app, 1 in cli; the colleague's 2 do not count")
	got := []int64{count.Repos[0].Commits, count.Repos[1].Commits}
	slices.Sort(got)
	farmtest.Eq(t, got, []int64{1, 4}, "per repository")
}
