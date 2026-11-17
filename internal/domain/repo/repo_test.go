package repo_test

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/vibevalleyhq/vibevalley/internal/domain/repo"
	"github.com/vibevalleyhq/vibevalley/pkg/db"
	"github.com/vibevalleyhq/vibevalley/pkg/migrate"
)

func gitExec(t *testing.T, dir string, args ...string) {
	t.Helper()
	full := append([]string{"-C", dir}, args...)
	cmd := exec.Command("git", full...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, string(out))
	}
}

func TestRepoGitWorktreeLifecycleMergeConflictAndPersistence(t *testing.T) {
	ctx := context.Background()
	tmpDir := t.TempDir()
	workRoot := filepath.Join(tmpDir, "workspace")
	dbPath := filepath.Join(tmpDir, "repo.db")

	reg, err := repo.OpenSQLiteRegistry(ctx, dbPath, repo.WithWorkRoot(workRoot))
	if err != nil {
		t.Fatal(err)
	}

	// Reject traversal/bad repo names.
	if _, err := reg.CreateOrInitRepo(ctx, "bad", "../escape", "main", ""); !errors.Is(err, repo.ErrInvalidRepoName) {
		t.Fatalf("expected ErrInvalidRepoName, got %v", err)
	}

	rp, err := reg.CreateOrInitRepo(ctx, "repo-1", "demo-app", "main", "")
	if err != nil {
		t.Fatal(err)
	}

	// Create worktree for issue-42 and commit a file inside it.
	wt, err := reg.CreateOrReuseWorktree(ctx, rp.ID, "42", "main")
	if err != nil || wt.Branch != "vibevalley/issue-42" || wt.Reused {
		t.Fatalf("CreateOrReuseWorktree 1: %+v err=%v", wt, err)
	}
	// Calling again reuses the existing worktree.
	wtReuse, err := reg.CreateOrReuseWorktree(ctx, rp.ID, "42", "main")
	if err != nil || !wtReuse.Reused || wtReuse.Path != wt.Path {
		t.Fatalf("expected reused worktree, got %+v err=%v", wtReuse, err)
	}

	// Uncommitted file triggers dirty check & ReleaseWorktree preservation!
	featureFile := filepath.Join(wt.Path, "hello.txt")
	if err := os.WriteFile(featureFile, []byte("hello world\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cleanStat, err := reg.CheckClean(ctx, wt.Path)
	if err != nil || cleanStat.Clean || len(cleanStat.ChangedFiles) != 1 {
		t.Fatalf("expected dirty worktree, got %+v err=%v", cleanStat, err)
	}
	relKept, err := reg.ReleaseWorktree(ctx, rp.ID, "42", false)
	if err != nil || !relKept.Kept || relKept.Released {
		t.Fatalf("expected dirty worktree kept, got %+v err=%v", relKept, err)
	}
	if _, err := reg.MergeWorktree(ctx, rp.ID, "42"); !errors.Is(err, repo.ErrDirtyWorktree) {
		t.Fatalf("expected ErrDirtyWorktree on dirty merge, got %v", err)
	}

	// Commit change in worktree, verify clean conflict check & merge into main.
	gitExec(t, wt.Path, "add", "hello.txt")
	gitExec(t, wt.Path, "-c", "user.name=Dev", "-c", "user.email=dev@local", "commit", "-m", "Add hello.txt")

	confRes, err := reg.ConflictCheck(ctx, rp.ID, wt.Branch, "main")
	if err != nil || confRes.HasConflict {
		t.Fatalf("expected clean merge-tree, got %+v err=%v", confRes, err)
	}
	mergeRes, err := reg.MergeWorktree(ctx, rp.ID, "42")
	if err != nil || !mergeRes.Merged || mergeRes.CommitSHA == "" {
		t.Fatalf("MergeWorktree: %+v err=%v", mergeRes, err)
	}

	// Verify commit count increased and merged file exists on main!
	if _, err := os.Stat(filepath.Join(rp.RootPath, "hello.txt")); err != nil {
		t.Fatalf("expected merged hello.txt on main: %v", err)
	}
	contribs, err := reg.Contributions(ctx, rp.ID, "")
	if err != nil || contribs < 2 {
		t.Fatalf("expected >= 2 commits, got %d err=%v", contribs, err)
	}

	// Verify conflict detection with another worktree editing hello.txt differently!
	wt2, err := reg.CreateOrReuseWorktree(ctx, rp.ID, "43", "main")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(wt2.Path, "hello.txt"), []byte("branch 43 change\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitExec(t, wt2.Path, "add", "hello.txt")
	gitExec(t, wt2.Path, "-c", "user.name=Dev", "-c", "user.email=dev@local", "commit", "-m", "Modify on 43")

	// Also commit conflicting change directly on main.
	if err := os.WriteFile(filepath.Join(rp.RootPath, "hello.txt"), []byte("main conflicting change\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitExec(t, rp.RootPath, "add", "hello.txt")
	gitExec(t, rp.RootPath, "-c", "user.name=Dev", "-c", "user.email=dev@local", "commit", "-m", "Modify on main")

	confRes2, err := reg.ConflictCheck(ctx, rp.ID, wt2.Branch, "main")
	if err != nil || !confRes2.HasConflict {
		t.Fatalf("expected conflict detected by git merge-tree, got %+v err=%v", confRes2, err)
	}
	if _, err := reg.MergeWorktree(ctx, rp.ID, "43"); !errors.Is(err, repo.ErrMergeConflict) {
		t.Fatalf("expected ErrMergeConflict, got %v", err)
	}

	// Reopen SQLite and verify repo & worktree records persist across restarts.
	_ = reg.Close()
	reg2, err := repo.OpenSQLiteRegistry(ctx, dbPath, repo.WithWorkRoot(workRoot))
	if err != nil {
		t.Fatal(err)
	}
	defer reg2.Close()

	reopenedWt, err := reg2.GetWorktree(ctx, rp.ID, "42")
	if err != nil || reopenedWt.Status != repo.WorktreeMerged {
		t.Fatalf("reopened worktree 42 mismatch: %+v err=%v", reopenedWt, err)
	}
}

func TestRepoMigrationsUpStatusDownAllUp(t *testing.T) {
	ctx := context.Background()
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "repo-mig.db")
	sqlDB, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	defer sqlDB.Close()

	scopeFS, err := db.ScopeFS("repo")
	if err != nil {
		t.Fatalf("ScopeFS(repo): %v", err)
	}
	runner, err := migrate.New(sqlDB, "repo", scopeFS)
	if err != nil {
		t.Fatalf("migrate.New: %v", err)
	}

	applied, err := runner.Up(ctx)
	if err != nil || applied != 1 {
		t.Fatalf("Up: applied=%d err=%v", applied, err)
	}
	statuses, err := runner.Status(ctx)
	if err != nil || len(statuses) != 1 || !statuses[0].Applied || statuses[0].Scope != "repo" || statuses[0].Version != 1 {
		t.Fatalf("Status after Up: %+v err=%v", statuses, err)
	}
	for _, tbl := range []string{"repo_repository", "repo_worktree"} {
		var name string
		if err := sqlDB.QueryRowContext(ctx, `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, tbl).Scan(&name); err != nil {
			t.Fatalf("expected table %s after Up: %v", tbl, err)
		}
	}

	reverted, err := runner.DownAll(ctx)
	if err != nil || reverted != 1 {
		t.Fatalf("DownAll: reverted=%d err=%v", reverted, err)
	}
	statusesAfterDown, err := runner.Status(ctx)
	if err != nil || len(statusesAfterDown) != 1 || statusesAfterDown[0].Applied {
		t.Fatalf("Status after DownAll: %+v err=%v", statusesAfterDown, err)
	}
	var remaining int
	if err := sqlDB.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'repo_%'`).Scan(&remaining); err != nil {
		t.Fatalf("count remaining repo_* tables: %v", err)
	}
	if remaining != 0 {
		t.Fatalf("expected 0 repo_* tables after DownAll, found %d", remaining)
	}

	reapplied, err := runner.Up(ctx)
	if err != nil || reapplied != 1 {
		t.Fatalf("re-Up: applied=%d err=%v", reapplied, err)
	}
	_ = sqlDB.Close()

	reg, err := repo.OpenSQLiteRegistry(ctx, dbPath, repo.WithWorkRoot(filepath.Join(tmpDir, "work")))
	if err != nil {
		t.Fatalf("OpenSQLiteRegistry after re-Up: %v", err)
	}
	defer reg.Close()
	rp, err := reg.RegisterRepo(ctx, repo.Repository{ID: "r1", Name: "r1", RootPath: filepath.Join(tmpDir, "work", "repos", "r1")})
	if err != nil || rp.ID != "r1" {
		t.Fatalf("RegisterRepo after re-Up: %+v err=%v", rp, err)
	}
	got, err := reg.GetRepo(ctx, "r1")
	if err != nil || got.Name != "r1" {
		t.Fatalf("GetRepo after re-Up: %+v err=%v", got, err)
	}
	if err := reg.DeleteRepo(ctx, "r1"); err != nil {
		t.Fatalf("DeleteRepo after re-Up: %v", err)
	}
}

func TestOpenSQLiteRegistryFromDBNonOwning(t *testing.T) {
	ctx := context.Background()
	tmpDir := t.TempDir()
	pool, err := db.OpenPool(ctx, filepath.Join(tmpDir, "shared.db"))
	if err != nil {
		t.Fatalf("OpenPool: %v", err)
	}
	defer pool.Close()

	runner, err := migrate.New(pool.WriteDB, db.PlatformScope, db.MigrationsFS)
	if err != nil {
		t.Fatalf("migrate.New: %v", err)
	}
	if _, err := runner.Up(ctx); err != nil {
		t.Fatalf("Up: %v", err)
	}

	reg, err := repo.OpenSQLiteRegistryFromDB(ctx, pool.WriteDB, repo.WithWorkRoot(filepath.Join(tmpDir, "work")))
	if err != nil {
		t.Fatalf("OpenSQLiteRegistryFromDB: %v", err)
	}
	if _, err := reg.RegisterRepo(ctx, repo.Repository{ID: "shared-r1", Name: "shared-r1", RootPath: filepath.Join(tmpDir, "work", "repos", "shared-r1")}); err != nil {
		t.Fatalf("RegisterRepo: %v", err)
	}
	if err := reg.Close(); err != nil {
		t.Fatalf("reg.Close: %v", err)
	}
	if err := pool.WriteDB.PingContext(ctx); err != nil {
		t.Fatalf("shared WriteDB closed by Registry.Close: %v", err)
	}

	reg2, err := repo.OpenSQLiteRegistryFromDB(ctx, pool.WriteDB)
	if err != nil {
		t.Fatalf("reattach OpenSQLiteRegistryFromDB: %v", err)
	}
	defer reg2.Close()
	got, err := reg2.GetRepo(ctx, "shared-r1")
	if err != nil || got.Name != "shared-r1" {
		t.Fatalf("reattached GetRepo: %+v err=%v", got, err)
	}
}
