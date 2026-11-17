package repo

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

type wtKey struct {
	repoID  string
	issueID string
}

type memRepoBackend struct {
	mu        sync.RWMutex
	repos     map[string]Repository
	byName    map[string]string
	worktrees map[wtKey]Worktree
}

func newMemoryRepoBackend() *memRepoBackend {
	return &memRepoBackend{
		repos:     make(map[string]Repository),
		byName:    make(map[string]string),
		worktrees: make(map[wtKey]Worktree),
	}
}

func (m *memRepoBackend) saveRepo(_ context.Context, r Repository) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.repos[r.ID] = r
	m.byName[r.Name] = r.ID
	return nil
}

func (m *memRepoBackend) getRepo(_ context.Context, id string) (Repository, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	r, ok := m.repos[id]
	return r, ok, nil
}

func (m *memRepoBackend) getRepoByName(_ context.Context, name string) (Repository, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	id, ok := m.byName[name]
	if !ok {
		return Repository{}, false, nil
	}
	r, exists := m.repos[id]
	return r, exists, nil
}

func (m *memRepoBackend) listRepos(_ context.Context) ([]Repository, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Repository, 0, len(m.repos))
	for _, r := range m.repos {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAtMs != out[j].CreatedAtMs {
			return out[i].CreatedAtMs < out[j].CreatedAtMs
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func (m *memRepoBackend) deleteRepo(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.repos[id]; ok {
		delete(m.byName, r.Name)
	}
	delete(m.repos, id)
	for k := range m.worktrees {
		if k.repoID == id {
			delete(m.worktrees, k)
		}
	}
	return nil
}

func (m *memRepoBackend) saveWorktree(_ context.Context, wt Worktree) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.worktrees[wtKey{repoID: wt.RepoID, issueID: wt.IssueID}] = wt
	return nil
}

func (m *memRepoBackend) getWorktree(_ context.Context, repoID, issueID string) (Worktree, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	wt, ok := m.worktrees[wtKey{repoID: repoID, issueID: issueID}]
	return wt, ok, nil
}

func (m *memRepoBackend) listWorktrees(_ context.Context, repoID string) ([]Worktree, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []Worktree
	for k, wt := range m.worktrees {
		if repoID == "" || k.repoID == repoID {
			out = append(out, wt)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAtMs != out[j].CreatedAtMs {
			return out[i].CreatedAtMs < out[j].CreatedAtMs
		}
		return out[i].IssueID < out[j].IssueID
	})
	return out, nil
}

func (m *memRepoBackend) close() error { return nil }

// Registry manages git repositories and per-issue worktrees with per-repo lock serialization.
type Registry struct {
	backend  repoBackend
	clock    Clock
	workRoot string

	locksMu   sync.Mutex
	repoLocks map[string]*sync.Mutex

	closed    atomic.Bool
	closeOnce sync.Once
	closeErr  error
}

// NewMemoryRegistry creates an in-memory repo & worktree Registry.
func NewMemoryRegistry(opts ...Option) *Registry {
	return newRegistry(newMemoryRepoBackend(), opts...)
}

// OpenSQLiteRegistry creates or reopens a SQLite WAL-backed repo & worktree Registry at path.
func OpenSQLiteRegistry(ctx context.Context, path string, opts ...Option) (*Registry, error) {
	b, err := openSQLiteRepoBackend(ctx, path)
	if err != nil {
		return nil, err
	}
	return newRegistry(b, opts...), nil
}

// OpenSQLiteRegistryFromDB attaches a repo & worktree Registry to an already-migrated *sql.DB
// without running migrations or closing sqlDB on Close.
func OpenSQLiteRegistryFromDB(ctx context.Context, sqlDB *sql.DB, opts ...Option) (*Registry, error) {
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
	}
	b, err := openSQLiteRepoFromDB(sqlDB)
	if err != nil {
		return nil, err
	}
	return newRegistry(b, opts...), nil
}

func newRegistry(b repoBackend, opts ...Option) *Registry {
	cfg := registryConfig{clock: realClock{}}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}
	return &Registry{
		backend:   b,
		clock:     cfg.clock,
		workRoot:  cfg.workRoot,
		repoLocks: make(map[string]*sync.Mutex),
	}
}

func (r *Registry) repoLock(repoID string) *sync.Mutex {
	r.locksMu.Lock()
	defer r.locksMu.Unlock()
	mu, ok := r.repoLocks[repoID]
	if !ok {
		mu = &sync.Mutex{}
		r.repoLocks[repoID] = mu
	}
	return mu
}

// Close releases underlying storage resources.
func (r *Registry) Close() error {
	r.closeOnce.Do(func() {
		r.closed.Store(true)
		r.closeErr = r.backend.close()
	})
	return r.closeErr
}

// CreateOrInitRepo initializes a git repository under `<workRoot>/repos/<name>` (or `RootPath`)
// with an initial commit on defaultBranch and persists it in the registry.
func (r *Registry) CreateOrInitRepo(ctx context.Context, id, name, defaultBranch, remoteURL string) (Repository, error) {
	if r.closed.Load() {
		return Repository{}, ErrStoreClosed
	}
	if err := ValidateRepoName(name); err != nil {
		return Repository{}, err
	}
	if r.workRoot == "" {
		return Repository{}, fmt.Errorf("%w: workRoot is required for CreateOrInitRepo", ErrInvalidArgument)
	}
	if id == "" {
		id = name
	}
	if defaultBranch == "" {
		defaultBranch = "main"
	}

	reposRoot := filepath.Join(r.workRoot, "repos")
	repoPath := filepath.Join(reposRoot, name)
	if err := os.MkdirAll(reposRoot, 0o755); err != nil {
		return Repository{}, err
	}
	if err := ValidatePathInside(reposRoot, repoPath); err != nil {
		return Repository{}, err
	}

	mu := r.repoLock(id)
	mu.Lock()
	defer mu.Unlock()

	if _, ok, err := r.backend.getRepoByName(ctx, name); err != nil {
		return Repository{}, err
	} else if ok {
		return Repository{}, fmt.Errorf("%w: repo %q", ErrDuplicate, name)
	}

	if err := gitInitWithInitialCommit(ctx, repoPath, defaultBranch); err != nil {
		return Repository{}, err
	}

	now := r.clock.NowMs()
	repo := Repository{
		ID:            id,
		Name:          name,
		RootPath:      repoPath,
		RemoteURL:     remoteURL,
		DefaultBranch: defaultBranch,
		CreatedAtMs:   now,
		UpdatedAtMs:   now,
	}
	if err := r.backend.saveRepo(ctx, repo); err != nil {
		return Repository{}, err
	}
	return repo, nil
}

// RegisterRepo records an existing repository directory in the registry.
func (r *Registry) RegisterRepo(ctx context.Context, repo Repository) (Repository, error) {
	if r.closed.Load() {
		return Repository{}, ErrStoreClosed
	}
	if err := ValidateRepoName(repo.Name); err != nil {
		return Repository{}, err
	}
	if strings.TrimSpace(repo.RootPath) == "" {
		return Repository{}, fmt.Errorf("%w: rootPath is required", ErrInvalidArgument)
	}
	if repo.ID == "" {
		repo.ID = repo.Name
	}
	if repo.DefaultBranch == "" {
		repo.DefaultBranch = "main"
	}
	now := r.clock.NowMs()
	if repo.CreatedAtMs == 0 {
		repo.CreatedAtMs = now
	}
	if repo.UpdatedAtMs == 0 {
		repo.UpdatedAtMs = repo.CreatedAtMs
	}
	if err := r.backend.saveRepo(ctx, repo); err != nil {
		return Repository{}, err
	}
	return repo, nil
}

// GetRepo returns a registered repository by ID.
func (r *Registry) GetRepo(ctx context.Context, id string) (Repository, error) {
	if r.closed.Load() {
		return Repository{}, ErrStoreClosed
	}
	repo, ok, err := r.backend.getRepo(ctx, id)
	if err != nil {
		return Repository{}, err
	}
	if !ok {
		return Repository{}, fmt.Errorf("%w: repo %q", ErrNotFound, id)
	}
	return repo, nil
}

// ListRepos returns all registered repositories sorted deterministically.
func (r *Registry) ListRepos(ctx context.Context) ([]Repository, error) {
	if r.closed.Load() {
		return nil, ErrStoreClosed
	}
	return r.backend.listRepos(ctx)
}

// DeleteRepo removes a repository from the registry.
func (r *Registry) DeleteRepo(ctx context.Context, id string) error {
	if r.closed.Load() {
		return ErrStoreClosed
	}
	return r.backend.deleteRepo(ctx, id)
}

// CreateOrReuseWorktree creates (or reuses if already present) the issue's git worktree and branch `vibevalley/issue-<issueID>`.
func (r *Registry) CreateOrReuseWorktree(ctx context.Context, repoID, issueID, baseBranch string) (Worktree, error) {
	if r.closed.Load() {
		return Worktree{}, ErrStoreClosed
	}
	if strings.TrimSpace(repoID) == "" || strings.TrimSpace(issueID) == "" {
		return Worktree{}, fmt.Errorf("%w: repoId and issueId are required", ErrInvalidArgument)
	}
	if err := ValidateRepoName(issueID); err != nil {
		return Worktree{}, fmt.Errorf("%w: invalid issueId %q", ErrInvalidArgument, issueID)
	}

	mu := r.repoLock(repoID)
	mu.Lock()
	defer mu.Unlock()

	rp, ok, err := r.backend.getRepo(ctx, repoID)
	if err != nil {
		return Worktree{}, err
	}
	if !ok {
		return Worktree{}, fmt.Errorf("%w: repo %q", ErrNotFound, repoID)
	}
	if baseBranch == "" {
		baseBranch = rp.DefaultBranch
	}
	branch := "vibevalley/issue-" + issueID

	wtRoot := filepath.Join(filepath.Dir(rp.RootPath), "..", "worktrees")
	if r.workRoot != "" {
		wtRoot = filepath.Join(r.workRoot, "worktrees")
	}
	wtPath := filepath.Join(wtRoot, rp.Name+"."+issueID)
	if err := os.MkdirAll(wtRoot, 0o755); err != nil {
		return Worktree{}, err
	}
	if err := ValidatePathInside(wtRoot, wtPath); err != nil {
		return Worktree{}, err
	}

	if existing, exists, err := r.backend.getWorktree(ctx, repoID, issueID); err == nil && exists && existing.Status == WorktreeActive {
		if _, statErr := os.Stat(existing.Path); statErr == nil {
			existing.HeadSHA, _ = gitHeadSHA(ctx, existing.Path)
			existing.Reused = true
			existing.UpdatedAtMs = r.clock.NowMs()
			_ = r.backend.saveWorktree(ctx, existing)
			return existing, nil
		}
	}

	if gitBranchExists(ctx, rp.RootPath, branch) {
		if _, stderr, _, err := runGit(ctx, rp.RootPath, "worktree", "add", wtPath, branch); err != nil {
			return Worktree{}, fmt.Errorf("git worktree add existing branch: %v (%s)", err, stderr)
		}
	} else {
		if _, stderr, _, err := runGit(ctx, rp.RootPath, "worktree", "add", "-b", branch, wtPath, baseBranch); err != nil {
			return Worktree{}, fmt.Errorf("git worktree add: %v (%s)", err, stderr)
		}
	}

	headSHA, _ := gitHeadSHA(ctx, wtPath)
	now := r.clock.NowMs()
	wt := Worktree{
		ID:          repoID + ":" + issueID,
		RepoID:      repoID,
		IssueID:     issueID,
		Branch:      branch,
		BaseBranch:  baseBranch,
		Path:        wtPath,
		Status:      WorktreeActive,
		HeadSHA:     headSHA,
		Reused:      false,
		CreatedAtMs: now,
		UpdatedAtMs: now,
	}
	if err := r.backend.saveWorktree(ctx, wt); err != nil {
		return Worktree{}, err
	}
	return wt, nil
}

// GetWorktree fetches the worktree record for (repoID, issueID).
func (r *Registry) GetWorktree(ctx context.Context, repoID, issueID string) (Worktree, error) {
	if r.closed.Load() {
		return Worktree{}, ErrStoreClosed
	}
	wt, ok, err := r.backend.getWorktree(ctx, repoID, issueID)
	if err != nil {
		return Worktree{}, err
	}
	if !ok {
		return Worktree{}, fmt.Errorf("%w: worktree (%s,%s)", ErrNotFound, repoID, issueID)
	}
	return wt, nil
}

// ListWorktrees lists all worktrees registered for repoID (or all repos if empty).
func (r *Registry) ListWorktrees(ctx context.Context, repoID string) ([]Worktree, error) {
	if r.closed.Load() {
		return nil, ErrStoreClosed
	}
	return r.backend.listWorktrees(ctx, repoID)
}

// CheckClean verifies whether the worktree working tree has uncommitted or untracked changes.
func (r *Registry) CheckClean(ctx context.Context, worktreePath string) (WorktreeCleanStatus, error) {
	if r.closed.Load() {
		return WorktreeCleanStatus{}, ErrStoreClosed
	}
	return gitStatusClean(ctx, worktreePath)
}

// ConflictCheck runs non-mutating `git merge-tree --write-tree` to detect conflicts before merging.
func (r *Registry) ConflictCheck(ctx context.Context, repoID, branch, baseBranch string) (ConflictCheckResult, error) {
	if r.closed.Load() {
		return ConflictCheckResult{}, ErrStoreClosed
	}
	rp, err := r.GetRepo(ctx, repoID)
	if err != nil {
		return ConflictCheckResult{}, err
	}
	if baseBranch == "" {
		baseBranch = rp.DefaultBranch
	}
	return gitMergeTreeCheck(ctx, rp.RootPath, baseBranch, branch)
}

// MergeWorktree verifies a clean working tree and zero conflicts, merges into the base branch,
// removes the worktree and branch, and records WorktreeMerged.
func (r *Registry) MergeWorktree(ctx context.Context, repoID, issueID string) (MergeResult, error) {
	if r.closed.Load() {
		return MergeResult{}, ErrStoreClosed
	}
	mu := r.repoLock(repoID)
	mu.Lock()
	defer mu.Unlock()

	rp, ok, err := r.backend.getRepo(ctx, repoID)
	if err != nil {
		return MergeResult{}, err
	}
	if !ok {
		return MergeResult{}, fmt.Errorf("%w: repo %q", ErrNotFound, repoID)
	}
	wt, ok, err := r.backend.getWorktree(ctx, repoID, issueID)
	if err != nil {
		return MergeResult{}, err
	}
	if !ok {
		return MergeResult{}, fmt.Errorf("%w: worktree (%s,%s)", ErrNotFound, repoID, issueID)
	}

	cleanStatus, err := gitStatusClean(ctx, wt.Path)
	if err != nil {
		return MergeResult{}, err
	}
	if !cleanStatus.Clean {
		return MergeResult{}, fmt.Errorf("%w: %v", ErrDirtyWorktree, cleanStatus.ChangedFiles)
	}

	targetBranch := wt.BaseBranch
	if targetBranch == "" {
		targetBranch = rp.DefaultBranch
	}
	conflict, err := gitMergeTreeCheck(ctx, rp.RootPath, targetBranch, wt.Branch)
	if err != nil {
		return MergeResult{}, err
	}
	if conflict.HasConflict {
		return MergeResult{
			Merged:        false,
			Conflict:      true,
			ConflictFiles: conflict.ConflictFiles,
		}, ErrMergeConflict
	}

	if _, stderr, _, err := runGit(ctx, rp.RootPath, "checkout", targetBranch); err != nil {
		return MergeResult{}, fmt.Errorf("git checkout %s: %v (%s)", targetBranch, err, stderr)
	}
	if _, stderr, _, err := runGit(ctx, rp.RootPath,
		"-c", "user.name=VibeValley",
		"-c", "user.email=vibevalley@local",
		"merge", "--no-edit", wt.Branch,
	); err != nil {
		return MergeResult{}, fmt.Errorf("git merge %s: %v (%s)", wt.Branch, err, stderr)
	}
	commitSHA, _ := gitHeadSHA(ctx, rp.RootPath)

	_, _, _, _ = runGit(ctx, rp.RootPath, "worktree", "remove", "--force", wt.Path)
	_, _, _, _ = runGit(ctx, rp.RootPath, "branch", "-D", wt.Branch)

	wt.Status = WorktreeMerged
	wt.HeadSHA = commitSHA
	wt.UpdatedAtMs = r.clock.NowMs()
	if err := r.backend.saveWorktree(ctx, wt); err != nil {
		return MergeResult{}, err
	}
	return MergeResult{Merged: true, CommitSHA: commitSHA}, nil
}

// ReleaseWorktree removes the worktree cleanly ONLY when clean unless force is true.
func (r *Registry) ReleaseWorktree(ctx context.Context, repoID, issueID string, force bool) (ReleaseResult, error) {
	if r.closed.Load() {
		return ReleaseResult{}, ErrStoreClosed
	}
	mu := r.repoLock(repoID)
	mu.Lock()
	defer mu.Unlock()

	rp, ok, err := r.backend.getRepo(ctx, repoID)
	if err != nil {
		return ReleaseResult{}, err
	}
	if !ok {
		return ReleaseResult{}, fmt.Errorf("%w: repo %q", ErrNotFound, repoID)
	}
	wt, ok, err := r.backend.getWorktree(ctx, repoID, issueID)
	if err != nil {
		return ReleaseResult{}, err
	}
	if !ok {
		return ReleaseResult{}, fmt.Errorf("%w: worktree (%s,%s)", ErrNotFound, repoID, issueID)
	}

	if !force {
		cleanStatus, err := gitStatusClean(ctx, wt.Path)
		if err == nil && !cleanStatus.Clean {
			return ReleaseResult{Released: false, Kept: true, Reason: "uncommitted_changes"}, nil
		}
	}

	args := []string{"worktree", "remove"}
	if force {
		args = append(args, "--force")
	}
	args = append(args, wt.Path)
	if _, stderr, _, err := runGit(ctx, rp.RootPath, args...); err != nil {
		return ReleaseResult{}, fmt.Errorf("git worktree remove: %v (%s)", err, stderr)
	}
	wt.Status = WorktreeReleased
	wt.UpdatedAtMs = r.clock.NowMs()
	if err := r.backend.saveWorktree(ctx, wt); err != nil {
		return ReleaseResult{}, err
	}
	return ReleaseResult{Released: true, Kept: false}, nil
}

// ResetWorktree resets the issue branch back to BaseBranch and cleans untracked files.
func (r *Registry) ResetWorktree(ctx context.Context, repoID, issueID string) (Worktree, error) {
	if r.closed.Load() {
		return Worktree{}, ErrStoreClosed
	}
	mu := r.repoLock(repoID)
	mu.Lock()
	defer mu.Unlock()

	wt, ok, err := r.backend.getWorktree(ctx, repoID, issueID)
	if err != nil {
		return Worktree{}, err
	}
	if !ok {
		return Worktree{}, fmt.Errorf("%w: worktree (%s,%s)", ErrNotFound, repoID, issueID)
	}
	if _, stderr, _, err := runGit(ctx, wt.Path, "reset", "--hard", wt.BaseBranch); err != nil {
		return Worktree{}, fmt.Errorf("git reset --hard: %v (%s)", err, stderr)
	}
	if _, stderr, _, err := runGit(ctx, wt.Path, "clean", "-fd"); err != nil {
		return Worktree{}, fmt.Errorf("git clean -fd: %v (%s)", err, stderr)
	}
	wt.HeadSHA, _ = gitHeadSHA(ctx, wt.Path)
	wt.UpdatedAtMs = r.clock.NowMs()
	if err := r.backend.saveWorktree(ctx, wt); err != nil {
		return Worktree{}, err
	}
	return wt, nil
}

// Contributions counts commits in repoID (optionally filtered by author) for farm leveling.
func (r *Registry) Contributions(ctx context.Context, repoID, author string) (int, error) {
	if r.closed.Load() {
		return 0, ErrStoreClosed
	}
	rp, err := r.GetRepo(ctx, repoID)
	if err != nil {
		return 0, err
	}
	args := []string{"rev-list", "--count"}
	if author != "" {
		args = append(args, "--author="+author)
	}
	args = append(args, "HEAD")
	out, stderr, _, err := runGit(ctx, rp.RootPath, args...)
	if err != nil {
		return 0, fmt.Errorf("git rev-list: %v (%s)", err, stderr)
	}
	n, err := strconv.Atoi(strings.TrimSpace(out))
	if err != nil {
		return 0, err
	}
	return n, nil
}
