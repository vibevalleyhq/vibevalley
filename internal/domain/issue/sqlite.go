package issue

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
	_ "modernc.org/sqlite"
)

var issueSchemaDDL = []string{
	`CREATE TABLE IF NOT EXISTS issue (
		id TEXT PRIMARY KEY,
		title TEXT NOT NULL,
		status TEXT NOT NULL,
		repo_id TEXT NOT NULL DEFAULT '',
		assignee_id TEXT NOT NULL DEFAULT '',
		session_id TEXT NOT NULL DEFAULT '',
		conversation_id TEXT NOT NULL DEFAULT '',
		state_json TEXT NOT NULL,
		created_at_ms INTEGER NOT NULL,
		updated_at_ms INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS issue_status_idx ON issue(status)`,
	`CREATE INDEX IF NOT EXISTS issue_conv_idx ON issue(conversation_id)`,
	`CREATE INDEX IF NOT EXISTS issue_session_idx ON issue(session_id)`,

	`CREATE TABLE IF NOT EXISTS issue_cron (
		id TEXT PRIMARY KEY,
		enabled INTEGER NOT NULL DEFAULT 1,
		pending_approval INTEGER NOT NULL DEFAULT 0,
		next_run_at_ms INTEGER NOT NULL DEFAULT 0,
		last_run_at_ms INTEGER NOT NULL DEFAULT 0,
		state_json TEXT NOT NULL,
		created_at_ms INTEGER NOT NULL,
		updated_at_ms INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS issue_cron_due_idx ON issue_cron(enabled, pending_approval, next_run_at_ms)`,
}

type sqliteIssueBackend struct {
	mu     sync.Mutex
	db     *sql.DB
	ownsDB bool
}

func openSQLiteIssueBackend(ctx context.Context, path string) (*sqliteIssueBackend, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("%w: empty sqlite path", ErrInvalidArgument)
	}
	isMem := path == ":memory:" || strings.Contains(path, "mode=memory") || strings.Contains(path, ":memory:")
	if !isMem && !strings.HasPrefix(path, "file:") {
		if dir := filepath.Dir(path); dir != "" && dir != "." {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return nil, fmt.Errorf("issue: mkdir %s: %w", dir, err)
			}
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("issue: open sqlite: %w", err)
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
			return nil, fmt.Errorf("issue: %s: %w", p, err)
		}
	}
	return openSQLiteIssueFromDB(ctx, db, true)
}

func openSQLiteIssueFromDB(ctx context.Context, db *sql.DB, ownsDB bool) (*sqliteIssueBackend, error) {
	if db == nil {
		return nil, fmt.Errorf("%w: sql.DB is required", ErrInvalidArgument)
	}
	for _, ddl := range issueSchemaDDL {
		if _, err := db.ExecContext(ctx, ddl); err != nil {
			if ownsDB {
				_ = db.Close()
			}
			return nil, fmt.Errorf("issue: apply schema: %w", err)
		}
	}
	return &sqliteIssueBackend{db: db, ownsDB: ownsDB}, nil
}

func (b *sqliteIssueBackend) createIssue(ctx context.Context, iss Issue) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok, err := b.getIssueLocked(ctx, iss.ID); err != nil {
		return err
	} else if ok {
		return fmt.Errorf("%w: issue %q", ErrDuplicate, iss.ID)
	}
	return b.saveIssueLocked(ctx, iss)
}

func (b *sqliteIssueBackend) upsertIssue(ctx context.Context, iss Issue) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.saveIssueLocked(ctx, iss)
}

func (b *sqliteIssueBackend) saveIssueLocked(ctx context.Context, iss Issue) error {
	raw, err := json.Marshal(iss)
	if err != nil {
		return err
	}
	_, err = b.db.ExecContext(ctx, `INSERT INTO issue (
		id, title, status, repo_id, assignee_id, session_id, conversation_id, state_json, created_at_ms, updated_at_ms
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT (id) DO UPDATE SET
		title = excluded.title,
		status = excluded.status,
		repo_id = excluded.repo_id,
		assignee_id = excluded.assignee_id,
		session_id = excluded.session_id,
		conversation_id = excluded.conversation_id,
		state_json = excluded.state_json,
		updated_at_ms = excluded.updated_at_ms`,
		iss.ID, iss.Title, string(iss.Status), iss.RepoID, iss.AssigneeID, iss.SessionID,
		iss.ConversationID, string(raw), iss.CreatedAtMs, iss.UpdatedAtMs,
	)
	return err
}

func (b *sqliteIssueBackend) getIssue(ctx context.Context, id string) (Issue, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.getIssueLocked(ctx, id)
}

func (b *sqliteIssueBackend) getIssueLocked(ctx context.Context, id string) (Issue, bool, error) {
	var raw string
	err := b.db.QueryRowContext(ctx, `SELECT state_json FROM issue WHERE id = ?`, id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return Issue{}, false, nil
	}
	if err != nil {
		return Issue{}, false, err
	}
	var iss Issue
	if err := json.Unmarshal([]byte(raw), &iss); err != nil {
		return Issue{}, false, err
	}
	return cloneIssue(iss), true, nil
}

func (b *sqliteIssueBackend) findIssueByConversationOrSession(ctx context.Context, conversationID, sessionID string) (Issue, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if conversationID != "" {
		var raw string
		err := b.db.QueryRowContext(ctx, `SELECT state_json FROM issue WHERE conversation_id = ? LIMIT 1`, conversationID).Scan(&raw)
		if err == nil {
			var iss Issue
			if uErr := json.Unmarshal([]byte(raw), &iss); uErr != nil {
				return Issue{}, false, uErr
			}
			return cloneIssue(iss), true, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return Issue{}, false, err
		}
	}
	if sessionID != "" {
		var raw string
		err := b.db.QueryRowContext(ctx, `SELECT state_json FROM issue WHERE session_id = ? LIMIT 1`, sessionID).Scan(&raw)
		if err == nil {
			var iss Issue
			if uErr := json.Unmarshal([]byte(raw), &iss); uErr != nil {
				return Issue{}, false, uErr
			}
			return cloneIssue(iss), true, nil
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
	rows, err := b.db.QueryContext(ctx, `SELECT state_json FROM issue ORDER BY created_at_ms ASC, id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Issue
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var iss Issue
		if err := json.Unmarshal([]byte(raw), &iss); err != nil {
			return nil, err
		}
		if len(statuses) > 0 && !slices.Contains(statuses, iss.Status) {
			continue
		}
		out = append(out, cloneIssue(iss))
	}
	return out, rows.Err()
}

func (b *sqliteIssueBackend) createCron(ctx context.Context, c CronSchedule) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok, err := b.getCronLocked(ctx, c.ID); err != nil {
		return err
	} else if ok {
		return fmt.Errorf("%w: cron %q", ErrDuplicate, c.ID)
	}
	return b.saveCronLocked(ctx, c)
}

func (b *sqliteIssueBackend) updateCron(ctx context.Context, c CronSchedule) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok, err := b.getCronLocked(ctx, c.ID); err != nil {
		return err
	} else if !ok {
		return fmt.Errorf("%w: cron %q", ErrNotFound, c.ID)
	}
	return b.saveCronLocked(ctx, c)
}

func (b *sqliteIssueBackend) saveCronLocked(ctx context.Context, c CronSchedule) error {
	raw, err := json.Marshal(c)
	if err != nil {
		return err
	}
	enabled := 0
	if c.Enabled {
		enabled = 1
	}
	pending := 0
	if c.PendingApproval {
		pending = 1
	}
	_, err = b.db.ExecContext(ctx, `INSERT INTO issue_cron (
		id, enabled, pending_approval, next_run_at_ms, last_run_at_ms, state_json, created_at_ms, updated_at_ms
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT (id) DO UPDATE SET
		enabled = excluded.enabled,
		pending_approval = excluded.pending_approval,
		next_run_at_ms = excluded.next_run_at_ms,
		last_run_at_ms = excluded.last_run_at_ms,
		state_json = excluded.state_json,
		updated_at_ms = excluded.updated_at_ms`,
		c.ID, enabled, pending, c.NextRunAtMs, c.LastRunAtMs, string(raw), c.CreatedAtMs, c.UpdatedAtMs,
	)
	return err
}

func (b *sqliteIssueBackend) getCron(ctx context.Context, id string) (CronSchedule, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.getCronLocked(ctx, id)
}

func (b *sqliteIssueBackend) getCronLocked(ctx context.Context, id string) (CronSchedule, bool, error) {
	var raw string
	err := b.db.QueryRowContext(ctx, `SELECT state_json FROM issue_cron WHERE id = ?`, id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return CronSchedule{}, false, nil
	}
	if err != nil {
		return CronSchedule{}, false, err
	}
	var c CronSchedule
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		return CronSchedule{}, false, err
	}
	return cloneCron(c), true, nil
}

func (b *sqliteIssueBackend) listCrons(ctx context.Context) ([]CronSchedule, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	rows, err := b.db.QueryContext(ctx, `SELECT state_json FROM issue_cron ORDER BY created_at_ms ASC, id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CronSchedule
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var c CronSchedule
		if err := json.Unmarshal([]byte(raw), &c); err != nil {
			return nil, err
		}
		out = append(out, cloneCron(c))
	}
	return out, rows.Err()
}

func (b *sqliteIssueBackend) dueCrons(ctx context.Context, nowMs int64) ([]CronSchedule, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	rows, err := b.db.QueryContext(ctx, `SELECT state_json FROM issue_cron
		WHERE enabled = 1 AND pending_approval = 0 AND next_run_at_ms > 0 AND next_run_at_ms <= ?
		ORDER BY next_run_at_ms ASC, id ASC`, nowMs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CronSchedule
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var c CronSchedule
		if err := json.Unmarshal([]byte(raw), &c); err != nil {
			return nil, err
		}
		out = append(out, cloneCron(c))
	}
	return out, rows.Err()
}

func (b *sqliteIssueBackend) close() error {
	if b.ownsDB && b.db != nil {
		return b.db.Close()
	}
	return nil
}
