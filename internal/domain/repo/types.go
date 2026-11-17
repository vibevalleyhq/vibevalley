package repo

import (
	"context"
	"errors"
	"time"
)

var (
	ErrNotFound        = errors.New("repo: record not found")
	ErrInvalidArgument = errors.New("repo: invalid argument")
	ErrInvalidRepoName = errors.New("repo: invalid repository name")
	ErrDuplicate       = errors.New("repo: duplicate record")
	ErrDirtyWorktree   = errors.New("repo: worktree has uncommitted changes")
	ErrMergeConflict   = errors.New("repo: merge conflict detected")
	ErrSymlinkEscape   = errors.New("repo: path escapes workspace root")
	ErrStoreClosed     = errors.New("repo: store is closed")
)

// WorktreeStatus tracks the lifecycle of a per-issue git worktree.
type WorktreeStatus string

const (
	WorktreeActive   WorktreeStatus = "active"
	WorktreeReleased WorktreeStatus = "released"
	WorktreeMerged   WorktreeStatus = "merged"
	WorktreeRemoved  WorktreeStatus = "removed"
)

// Clock provides timestamps for repo and worktree records.
type Clock interface {
	NowMs() int64
}

type realClock struct{}

func (realClock) NowMs() int64 { return time.Now().UnixMilli() }

// Repository describes a registered git repository inside the workspace.
type Repository struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	RootPath      string `json:"rootPath"`
	RemoteURL     string `json:"remoteUrl,omitempty"`
	DefaultBranch string `json:"defaultBranch"`
	CreatedAtMs   int64  `json:"createdAtMs"`
	UpdatedAtMs   int64  `json:"updatedAtMs"`
}

// Worktree tracks an issue-bound git worktree and branch (`vibevalley/issue-<issueId>`).
type Worktree struct {
	ID          string         `json:"id"`
	RepoID      string         `json:"repoId"`
	IssueID     string         `json:"issueId"`
	Branch      string         `json:"branch"`
	BaseBranch  string         `json:"baseBranch"`
	Path        string         `json:"path"`
	Status      WorktreeStatus `json:"status"`
	HeadSHA     string         `json:"headSha,omitempty"`
	Reused      bool           `json:"reused,omitempty"`
	CreatedAtMs int64          `json:"createdAtMs"`
	UpdatedAtMs int64          `json:"updatedAtMs"`
}

// WorktreeCleanStatus reports whether a worktree has uncommitted or untracked changes.
type WorktreeCleanStatus struct {
	Clean        bool     `json:"clean"`
	ChangedFiles []string `json:"changedFiles,omitempty"`
	HeadSHA      string   `json:"headSha,omitempty"`
}

// ConflictCheckResult reports non-mutating `git merge-tree --write-tree` preflight output.
type ConflictCheckResult struct {
	HasConflict   bool     `json:"hasConflict"`
	ConflictFiles []string `json:"conflictFiles,omitempty"`
	TreeSHA       string   `json:"treeSha,omitempty"`
}

// ReleaseResult distinguishes clean cleanup from preserved dirty worktrees.
type ReleaseResult struct {
	Released bool   `json:"released"`
	Kept     bool   `json:"kept"`
	Reason   string `json:"reason,omitempty"`
}

// MergeResult captures the outcome of merging an issue worktree into target branch.
type MergeResult struct {
	Merged        bool     `json:"merged"`
	CommitSHA     string   `json:"commitSha,omitempty"`
	Conflict      bool     `json:"conflict,omitempty"`
	ConflictFiles []string `json:"conflictFiles,omitempty"`
}

// Option configures a repo Registry.
type Option func(*registryConfig)

type registryConfig struct {
	clock    Clock
	workRoot string
}

// WithClock overrides the clock used for timestamps.
func WithClock(clock Clock) Option {
	return func(c *registryConfig) {
		if clock != nil {
			c.clock = clock
		}
	}
}

// WithWorkRoot sets the workspace root holding `repos/` and `worktrees/`.
func WithWorkRoot(workRoot string) Option {
	return func(c *registryConfig) {
		c.workRoot = workRoot
	}
}

type repoBackend interface {
	saveRepo(ctx context.Context, r Repository) error
	getRepo(ctx context.Context, id string) (Repository, bool, error)
	getRepoByName(ctx context.Context, name string) (Repository, bool, error)
	listRepos(ctx context.Context) ([]Repository, error)
	deleteRepo(ctx context.Context, id string) error
	saveWorktree(ctx context.Context, wt Worktree) error
	getWorktree(ctx context.Context, repoID, issueID string) (Worktree, bool, error)
	listWorktrees(ctx context.Context, repoID string) ([]Worktree, error)
	close() error
}
