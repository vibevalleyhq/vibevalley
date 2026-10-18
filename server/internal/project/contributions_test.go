package project

import (
	"context"
	"path/filepath"
	"testing"
	"vibevalley/internal/testkit"
)

func TestContributionObservationOwnsNestedRepositoriesAndWorktreeIdentity(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "nested", "repo")
	testkit.Repo(t, repo, 2, 1)
	tree := filepath.Join(root, ".worktrees", "copy")
	testkit.Git(t, repo, "worktree", "add", "-q", "-b", "side", tree)
	p := projects(t, root)
	repos := p.Contributions(context.Background(), nil)
	if len(repos) != 1 || repos[0].Commits != 2 {
		t.Fatalf("observation: %+v", repos)
	}
}
