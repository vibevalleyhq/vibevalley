package issue

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
	"github.com/vibevalleyhq/vibevalley/pkg/db"
	dbgen "github.com/vibevalleyhq/vibevalley/pkg/db/generated"
	"github.com/vibevalleyhq/vibevalley/pkg/migrate"
)

type sqliteIssueBackend struct {
	mu      sync.Mutex
	pool    *db.Pool
	db      *sql.DB
	queries *dbgen.Queries
	ownsDB  bool
}

func openSQLiteIssueBackend(ctx context.Context, path string) (*sqliteIssueBackend, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("%w: empty sqlite path", ErrInvalidArgument)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	pool, err := db.OpenPool(ctx, path)
	if err != nil {
		return nil, fmt.Errorf("issue: open sqlite: %w", err)
	}
	runner, err := migrate.New(pool.WriteDB, db.PlatformScope, db.MigrationsFS)
	if err != nil {
		_ = pool.Close()
		return nil, fmt.Errorf("issue: init migrations: %w", err)
	}
	if _, err := runner.Up(ctx); err != nil {
		_ = pool.Close()
		return nil, fmt.Errorf("issue: apply migrations: %w", err)
	}
	return &sqliteIssueBackend{
		pool:    pool,
		db:      pool.WriteDB,
		queries: dbgen.New(pool.WriteDB),
		ownsDB:  true,
	}, nil
}

func openSQLiteIssueFromDB(ctx context.Context, sqlDB *sql.DB, runMigrate, ownsDB bool) (*sqliteIssueBackend, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if sqlDB == nil {
		return nil, fmt.Errorf("%w: sql.DB is required", ErrInvalidArgument)
	}
	if runMigrate {
		fsys, err := db.ScopeFS("issue")
		if err != nil {
			if ownsDB {
				_ = sqlDB.Close()
			}
			return nil, fmt.Errorf("issue: load migrations: %w", err)
		}
		runner, err := migrate.New(sqlDB, "issue", fsys)
		if err != nil {
			if ownsDB {
				_ = sqlDB.Close()
			}
			return nil, fmt.Errorf("issue: init migrations: %w", err)
		}
		if _, err := runner.Up(ctx); err != nil {
			if ownsDB {
				_ = sqlDB.Close()
			}
			return nil, fmt.Errorf("issue: apply migrations: %w", err)
		}
	}
	return &sqliteIssueBackend{
		db:      sqlDB,
		queries: dbgen.New(sqlDB),
		ownsDB:  ownsDB,
	}, nil
}

func (b *sqliteIssueBackend) createIssue(ctx context.Context, iss Issue) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	qtx := b.queries.WithTx(tx)

	if _, err := qtx.GetIssue(ctx, iss.ID); err == nil {
		return fmt.Errorf("%w: issue %q", ErrDuplicate, iss.ID)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err := saveIssueWith(ctx, qtx, iss); err != nil {
		return err
	}
	return tx.Commit()
}

func (b *sqliteIssueBackend) upsertIssue(ctx context.Context, iss Issue) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	return saveIssueWith(ctx, b.queries, iss)
}

func saveIssueWith(ctx context.Context, q *dbgen.Queries, iss Issue) error {
	raw, err := json.Marshal(iss)
	if err != nil {
		return err
	}
	return q.UpsertIssue(ctx, dbgen.UpsertIssueParams{
		ID:             iss.ID,
		Title:          iss.Title,
		Status:         string(iss.Status),
		RepoID:         iss.RepoID,
		AssigneeID:     iss.AssigneeID,
		SessionID:      iss.SessionID,
		ConversationID: iss.ConversationID,
		StateJson:      string(raw),
		CreatedAtMs:    iss.CreatedAtMs,
		UpdatedAtMs:    iss.UpdatedAtMs,
	})
}

func (b *sqliteIssueBackend) getIssue(ctx context.Context, id string) (Issue, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	raw, err := b.queries.GetIssue(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Issue{}, false, nil
	}
	if err != nil {
		return Issue{}, false, err
	}
	iss, err := decodeIssueJSON(raw)
	if err != nil {
		return Issue{}, false, err
	}
	return iss, true, nil
}

func (b *sqliteIssueBackend) findIssueByConversationOrSession(ctx context.Context, conversationID, sessionID string) (Issue, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if conversationID != "" {
		raw, err := b.queries.GetIssueByConversation(ctx, conversationID)
		if err == nil {
			iss, uErr := decodeIssueJSON(raw)
			if uErr != nil {
				return Issue{}, false, uErr
			}
			return iss, true, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return Issue{}, false, err
		}
	}
	if sessionID != "" {
		raw, err := b.queries.GetIssueBySession(ctx, sessionID)
		if err == nil {
			iss, uErr := decodeIssueJSON(raw)
			if uErr != nil {
				return Issue{}, false, uErr
			}
			return iss, true, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return Issue{}, false, err
		}
	}
	return Issue{}, false, nil
}

func (b *sqliteIssueBackend) listIssues(ctx context.Context, statuses ...contract.IssueStatus) ([]Issue, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	var rows []string
	var err error
	if len(statuses) == 0 {
		rows, err = b.queries.ListIssues(ctx)
	} else {
		statusStrs := make([]string, len(statuses))
		for i, st := range statuses {
			statusStrs[i] = string(st)
		}
		rows, err = b.queries.ListIssuesByStatus(ctx, statusStrs)
	}
	if err != nil {
		return nil, err
	}
	var out []Issue
	for _, raw := range rows {
		iss, err := decodeIssueJSON(raw)
		if err != nil {
			return nil, err
		}
		out = append(out, iss)
	}
	return out, nil
}

func (b *sqliteIssueBackend) createCron(ctx context.Context, c CronSchedule) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	qtx := b.queries.WithTx(tx)

	if _, err := qtx.GetCron(ctx, c.ID); err == nil {
		return fmt.Errorf("%w: cron %q", ErrDuplicate, c.ID)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err := saveCronWith(ctx, qtx, c); err != nil {
		return err
	}
	return tx.Commit()
}

func (b *sqliteIssueBackend) updateCron(ctx context.Context, c CronSchedule) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	qtx := b.queries.WithTx(tx)

	if _, err := qtx.GetCron(ctx, c.ID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("%w: cron %q", ErrNotFound, c.ID)
		}
		return err
	}
	if err := saveCronWith(ctx, qtx, c); err != nil {
		return err
	}
	return tx.Commit()
}

func saveCronWith(ctx context.Context, q *dbgen.Queries, c CronSchedule) error {
	raw, err := json.Marshal(c)
	if err != nil {
		return err
	}
	var enabled, pending int64
	if c.Enabled {
		enabled = 1
	}
	if c.PendingApproval {
		pending = 1
	}
	return q.UpsertCron(ctx, dbgen.UpsertCronParams{
		ID:              c.ID,
		Enabled:         enabled,
		PendingApproval: pending,
		NextRunAtMs:     c.NextRunAtMs,
		LastRunAtMs:     c.LastRunAtMs,
		StateJson:       string(raw),
		CreatedAtMs:     c.CreatedAtMs,
		UpdatedAtMs:     c.UpdatedAtMs,
	})
}

func (b *sqliteIssueBackend) getCron(ctx context.Context, id string) (CronSchedule, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	raw, err := b.queries.GetCron(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return CronSchedule{}, false, nil
	}
	if err != nil {
		return CronSchedule{}, false, err
	}
	c, err := decodeCronJSON(raw)
	if err != nil {
		return CronSchedule{}, false, err
	}
	return c, true, nil
}

func (b *sqliteIssueBackend) listCrons(ctx context.Context) ([]CronSchedule, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	rows, err := b.queries.ListCrons(ctx)
	if err != nil {
		return nil, err
	}
	return decodeCronList(rows)
}

func (b *sqliteIssueBackend) dueCrons(ctx context.Context, nowMs int64) ([]CronSchedule, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	rows, err := b.queries.ListDueCrons(ctx, nowMs)
	if err != nil {
		return nil, err
	}
	return decodeCronList(rows)
}

func (b *sqliteIssueBackend) close() error {
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

func decodeIssueJSON(raw string) (Issue, error) {
	var iss Issue
	if err := json.Unmarshal([]byte(raw), &iss); err != nil {
		return Issue{}, err
	}
	return cloneIssue(iss), nil
}

func decodeCronJSON(raw string) (CronSchedule, error) {
	var c CronSchedule
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		return CronSchedule{}, err
	}
	return cloneCron(c), nil
}

func decodeCronList(rows []string) ([]CronSchedule, error) {
	var out []CronSchedule
	for _, raw := range rows {
		c, err := decodeCronJSON(raw)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, nil
}
