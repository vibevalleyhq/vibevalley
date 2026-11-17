package repo

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/vibevalleyhq/vibevalley/pkg/db"
	dbgen "github.com/vibevalleyhq/vibevalley/pkg/db/generated"
	"github.com/vibevalleyhq/vibevalley/pkg/migrate"
)

type sqliteRepoBackend struct {
	mu     sync.Mutex
	pool   *db.Pool
	db     *sql.DB
	q      *dbgen.Queries
	ownsDB bool
}

func openSQLiteRepoBackend(ctx context.Context, path string) (*sqliteRepoBackend, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("%w: empty sqlite path", ErrInvalidArgument)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	pool, err := db.OpenPool(ctx, path)
	if err != nil {
		return nil, fmt.Errorf("repo: open sqlite: %w", err)
	}

	runner, err := migrate.New(pool.WriteDB, db.PlatformScope, db.MigrationsFS)
	if err != nil {
		_ = pool.Close()
		return nil, fmt.Errorf("repo: init migrator: %w", err)
	}
	if _, err := runner.Up(ctx); err != nil {
		_ = pool.Close()
		return nil, fmt.Errorf("repo: apply migrations: %w", err)
	}

	return &sqliteRepoBackend{
		pool:   pool,
		db:     pool.WriteDB,
		q:      dbgen.New(pool.WriteDB),
		ownsDB: true,
	}, nil
}

func openSQLiteRepoFromDB(sqlDB *sql.DB) (*sqliteRepoBackend, error) {
	if sqlDB == nil {
		return nil, fmt.Errorf("%w: sql.DB is required", ErrInvalidArgument)
	}
	return &sqliteRepoBackend{
		db:     sqlDB,
		q:      dbgen.New(sqlDB),
		ownsDB: false,
	}, nil
}

func (b *sqliteRepoBackend) saveRepo(ctx context.Context, r Repository) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	raw, err := json.Marshal(r)
	if err != nil {
		return err
	}
	return b.q.SaveRepo(ctx, dbgen.SaveRepoParams{
		ID:          r.ID,
		Name:        r.Name,
		StateJson:   string(raw),
		CreatedAtMs: r.CreatedAtMs,
		UpdatedAtMs: r.UpdatedAtMs,
	})
}

func decodeOneJSON[T any](raw string, err error) (T, bool, error) {
	var zero T
	if errors.Is(err, sql.ErrNoRows) {
		return zero, false, nil
	}
	if err != nil {
		return zero, false, err
	}
	var out T
	if unmarshalErr := json.Unmarshal([]byte(raw), &out); unmarshalErr != nil {
		return zero, false, unmarshalErr
	}
	return out, true, nil
}

func decodeManyJSON[T any](raws []string) ([]T, error) {
	var out []T
	for _, raw := range raws {
		var item T
		if err := json.Unmarshal([]byte(raw), &item); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, nil
}

func (b *sqliteRepoBackend) getRepo(ctx context.Context, id string) (Repository, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	raw, err := b.q.GetRepo(ctx, id)
	return decodeOneJSON[Repository](raw, err)
}

func (b *sqliteRepoBackend) getRepoByName(ctx context.Context, name string) (Repository, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	raw, err := b.q.GetRepoByName(ctx, name)
	return decodeOneJSON[Repository](raw, err)
}

func (b *sqliteRepoBackend) listRepos(ctx context.Context) ([]Repository, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	raws, err := b.q.ListRepos(ctx)
	if err != nil {
		return nil, err
	}
	return decodeManyJSON[Repository](raws)
}

func (b *sqliteRepoBackend) deleteRepo(ctx context.Context, id string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		_ = tx.Rollback()
	}()
	qtx := b.q.WithTx(tx)
	if err := qtx.DeleteWorktreesByRepo(ctx, id); err != nil {
		return err
	}
	if err := qtx.DeleteRepo(ctx, id); err != nil {
		return err
	}
	return tx.Commit()
}

func (b *sqliteRepoBackend) saveWorktree(ctx context.Context, wt Worktree) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	raw, err := json.Marshal(wt)
	if err != nil {
		return err
	}
	return b.q.SaveWorktree(ctx, dbgen.SaveWorktreeParams{
		RepoID:      wt.RepoID,
		IssueID:     wt.IssueID,
		Status:      string(wt.Status),
		StateJson:   string(raw),
		CreatedAtMs: wt.CreatedAtMs,
		UpdatedAtMs: wt.UpdatedAtMs,
	})
}

func (b *sqliteRepoBackend) getWorktree(ctx context.Context, repoID, issueID string) (Worktree, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	raw, err := b.q.GetWorktree(ctx, dbgen.GetWorktreeParams{
		RepoID:  repoID,
		IssueID: issueID,
	})
	return decodeOneJSON[Worktree](raw, err)
}

func (b *sqliteRepoBackend) listWorktrees(ctx context.Context, repoID string) ([]Worktree, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	var raws []string
	var err error
	if repoID != "" {
		raws, err = b.q.ListWorktreesByRepo(ctx, repoID)
	} else {
		raws, err = b.q.ListAllWorktrees(ctx)
	}
	if err != nil {
		return nil, err
	}
	return decodeManyJSON[Worktree](raws)
}

func (b *sqliteRepoBackend) close() error {
	if !b.ownsDB {
		return nil
	}
	if b.pool != nil {
		return b.pool.Close()
	}
	if b.db != nil {
		return b.db.Close()
	}
	return nil
}
