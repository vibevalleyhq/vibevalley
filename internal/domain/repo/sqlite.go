package repo

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	_ "modernc.org/sqlite"
)

var repoSchemaDDL = []string{
	`CREATE TABLE IF NOT EXISTS repo_repository (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL UNIQUE,
		state_json TEXT NOT NULL,
		created_at_ms INTEGER NOT NULL,
		updated_at_ms INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS repo_worktree (
		repo_id TEXT NOT NULL,
		issue_id TEXT NOT NULL,
		status TEXT NOT NULL,
		state_json TEXT NOT NULL,
		created_at_ms INTEGER NOT NULL,
		updated_at_ms INTEGER NOT NULL,
		PRIMARY KEY (repo_id, issue_id)
	)`,
}

type sqliteRepoBackend struct {
	mu     sync.Mutex
	db     *sql.DB
	ownsDB bool
}

func openSQLiteRepoBackend(ctx context.Context, path string) (*sqliteRepoBackend, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("%w: empty sqlite path", ErrInvalidArgument)
	}
	isMem := path == ":memory:" || strings.Contains(path, "mode=memory") || strings.Contains(path, ":memory:")
	if !isMem && !strings.HasPrefix(path, "file:") {
		if dir := filepath.Dir(path); dir != "" && dir != "." {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return nil, fmt.Errorf("repo: mkdir %s: %w", dir, err)
			}
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("repo: open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	pragmas := []string{
		"PRAGMA busy_timeout=5000",
		"PRAGMA foreign_keys=ON",
		"PRAGMA synchronous=NORMAL",
	}
	if !isMem {
		pragmas = append([]string{"PRAGMA journal_mode=WAL"}, pragmas...)
	}
	for _, p := range pragmas {
		if _, err := db.ExecContext(ctx, p); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("repo: %s: %w", p, err)
		}
	}
	for _, ddl := range repoSchemaDDL {
		if _, err := db.ExecContext(ctx, ddl); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("repo: apply schema: %w", err)
		}
	}
	return &sqliteRepoBackend{db: db, ownsDB: true}, nil
}

func (b *sqliteRepoBackend) saveRepo(ctx context.Context, r Repository) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	raw, err := json.Marshal(r)
	if err != nil {
		return err
	}
	_, err = b.db.ExecContext(ctx, `INSERT INTO repo_repository (id, name, state_json, created_at_ms, updated_at_ms)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET
			name = excluded.name,
			state_json = excluded.state_json,
			updated_at_ms = excluded.updated_at_ms`,
		r.ID, r.Name, string(raw), r.CreatedAtMs, r.UpdatedAtMs,
	)
	return err
}

func (b *sqliteRepoBackend) getRepo(ctx context.Context, id string) (Repository, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	var raw string
	err := b.db.QueryRowContext(ctx, `SELECT state_json FROM repo_repository WHERE id = ?`, id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return Repository{}, false, nil
	}
	if err != nil {
		return Repository{}, false, err
	}
	var r Repository
	if err := json.Unmarshal([]byte(raw), &r); err != nil {
		return Repository{}, false, err
	}
	return r, true, nil
}

func (b *sqliteRepoBackend) getRepoByName(ctx context.Context, name string) (Repository, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	var raw string
	err := b.db.QueryRowContext(ctx, `SELECT state_json FROM repo_repository WHERE name = ?`, name).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return Repository{}, false, nil
	}
	if err != nil {
		return Repository{}, false, err
	}
	var r Repository
	if err := json.Unmarshal([]byte(raw), &r); err != nil {
		return Repository{}, false, err
	}
	return r, true, nil
}

func (b *sqliteRepoBackend) listRepos(ctx context.Context) ([]Repository, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	rows, err := b.db.QueryContext(ctx, `SELECT state_json FROM repo_repository ORDER BY created_at_ms ASC, id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Repository
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var r Repository
		if err := json.Unmarshal([]byte(raw), &r); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (b *sqliteRepoBackend) deleteRepo(ctx context.Context, id string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, err := b.db.ExecContext(ctx, `DELETE FROM repo_worktree WHERE repo_id = ?`, id); err != nil {
		return err
	}
	_, err := b.db.ExecContext(ctx, `DELETE FROM repo_repository WHERE id = ?`, id)
	return err
}

func (b *sqliteRepoBackend) saveWorktree(ctx context.Context, wt Worktree) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	raw, err := json.Marshal(wt)
	if err != nil {
		return err
	}
	_, err = b.db.ExecContext(ctx, `INSERT INTO repo_worktree (repo_id, issue_id, status, state_json, created_at_ms, updated_at_ms)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (repo_id, issue_id) DO UPDATE SET
			status = excluded.status,
			state_json = excluded.state_json,
			updated_at_ms = excluded.updated_at_ms`,
		wt.RepoID, wt.IssueID, string(wt.Status), string(raw), wt.CreatedAtMs, wt.UpdatedAtMs,
	)
	return err
}

func (b *sqliteRepoBackend) getWorktree(ctx context.Context, repoID, issueID string) (Worktree, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	var raw string
	err := b.db.QueryRowContext(ctx, `SELECT state_json FROM repo_worktree WHERE repo_id = ? AND issue_id = ?`, repoID, issueID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return Worktree{}, false, nil
	}
	if err != nil {
		return Worktree{}, false, err
	}
	var wt Worktree
	if err := json.Unmarshal([]byte(raw), &wt); err != nil {
		return Worktree{}, false, err
	}
	return wt, true, nil
}

func (b *sqliteRepoBackend) listWorktrees(ctx context.Context, repoID string) ([]Worktree, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	var rows *sql.Rows
	var err error
	if repoID != "" {
		rows, err = b.db.QueryContext(ctx, `SELECT state_json FROM repo_worktree WHERE repo_id = ? ORDER BY created_at_ms ASC, issue_id ASC`, repoID)
	} else {
		rows, err = b.db.QueryContext(ctx, `SELECT state_json FROM repo_worktree ORDER BY created_at_ms ASC, repo_id ASC, issue_id ASC`)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Worktree
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var wt Worktree
		if err := json.Unmarshal([]byte(raw), &wt); err != nil {
			return nil, err
		}
		out = append(out, wt)
	}
	return out, rows.Err()
}

func (b *sqliteRepoBackend) close() error {
	if b.ownsDB && b.db != nil {
		return b.db.Close()
	}
	return nil
}
