package game

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"sync"

	"github.com/vibevalleyhq/vibevalley/pkg/db"
	dbgen "github.com/vibevalleyhq/vibevalley/pkg/db/generated"
	"github.com/vibevalleyhq/vibevalley/pkg/migrate"
)

// LedgerKind identifies append-only farm progression events.
type LedgerKind string

const (
	LedgerIssueMerged    LedgerKind = "issue_merged"
	LedgerFamilyComplete LedgerKind = "family_complete"
	LedgerWorkerFailed   LedgerKind = "worker_failed"
	LedgerTitleSet       LedgerKind = "title_set"
)

// LedgerEntry is an immutable progression event recorded in game_ledger.
type LedgerEntry struct {
	Seq           int64      `json:"seq"`
	Kind          LedgerKind `json:"kind"`
	IssueID       string     `json:"issueId,omitempty"`
	SessionID     string     `json:"sessionId,omitempty"`
	Commits       int        `json:"commits,omitempty"`
	MergedSubtask int        `json:"mergedSubtasks,omitempty"`
	Title         string     `json:"title,omitempty"`
	CreatedAtMs   int64      `json:"createdAtMs"`
}

// Progress is the folded farm progression state derived strictly from game_ledger.
type Progress struct {
	Coins       int64  `json:"coins"`
	Streak      int    `json:"streak"`
	MergedCount int    `json:"mergedCount"`
	ActiveTitle string `json:"activeTitle,omitempty"`
}

// LevelInfo reports current level and XP progress toward the next level.
type LevelInfo struct {
	Level int `json:"level"`
	XP    int `json:"xp"`
	Need  int `json:"need"`
}

// LevelForCommits computes the farm level using `10 * level` XP per level.
func LevelForCommits(total int) LevelInfo {
	level := 1
	rest := max(0, total)
	for rest >= 10*level {
		rest -= 10 * level
		level++
	}
	return LevelInfo{
		Level: level,
		XP:    rest,
		Need:  10 * level,
	}
}

// FoldProgress computes Progress deterministically by replaying ledger entries in commit order.
func FoldProgress(entries []LedgerEntry) Progress {
	var p Progress
	for _, e := range entries {
		switch e.Kind {
		case LedgerIssueMerged:
			p.Streak++
			p.MergedCount++
			base := 30.0 + float64(min(max(e.Commits, 0)*5, 30))
			mult := min(2.0, 1.0+0.1*float64(p.Streak-1))
			p.Coins += int64(math.Round(base * mult))
		case LedgerFamilyComplete:
			p.Streak++
			p.MergedCount++
			p.Coins += int64(30 + 10*max(e.MergedSubtask, 0))
		case LedgerWorkerFailed:
			p.Streak = 0
		case LedgerTitleSet:
			p.ActiveTitle = e.Title
		}
	}
	return p
}

// Ledger persists append-only game progression events across memory or SQLite.
type Ledger struct {
	mu      sync.Mutex
	entries []LedgerEntry
	nextSeq int64
	pool    *db.Pool
	db      *sql.DB
	q       *dbgen.Queries
	ownsDB  bool
}

// NewMemoryLedger creates an in-memory progression Ledger.
func NewMemoryLedger() *Ledger {
	return &Ledger{}
}

// OpenSQLiteLedger opens or creates a SQLite WAL progression Ledger at path.
func OpenSQLiteLedger(ctx context.Context, path string) (*Ledger, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("game: empty sqlite path")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	pool, err := db.OpenPool(ctx, path)
	if err != nil {
		return nil, fmt.Errorf("game: open sqlite pool: %w", err)
	}
	runner, err := migrate.New(pool.WriteDB, db.PlatformScope, db.MigrationsFS)
	if err != nil {
		_ = pool.Close()
		return nil, fmt.Errorf("game: init migrator: %w", err)
	}
	if _, err := runner.Up(ctx); err != nil {
		_ = pool.Close()
		return nil, fmt.Errorf("game: apply migrations: %w", err)
	}
	ledger, err := openLedgerFromDB(ctx, pool.WriteDB, pool, true)
	if err != nil {
		_ = pool.Close()
		return nil, err
	}
	return ledger, nil
}

// OpenSQLiteLedgerFromDB attaches a progression Ledger to an already-migrated *sql.DB
// without running migrations or taking ownership of closing sqlDB.
func OpenSQLiteLedgerFromDB(ctx context.Context, sqlDB *sql.DB) (*Ledger, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if sqlDB == nil {
		return nil, fmt.Errorf("game: sql.DB is required")
	}
	return openLedgerFromDB(ctx, sqlDB, nil, false)
}

func openLedgerFromDB(ctx context.Context, sqlDB *sql.DB, pool *db.Pool, ownsDB bool) (*Ledger, error) {
	q := dbgen.New(sqlDB)
	payloads, err := q.ListLedgerPayloads(ctx)
	if err != nil {
		return nil, err
	}

	var entries []LedgerEntry
	var maxSeq int64
	for _, raw := range payloads {
		var e LedgerEntry
		if err := json.Unmarshal([]byte(raw), &e); err != nil {
			return nil, err
		}
		entries = append(entries, e)
		if e.Seq > maxSeq {
			maxSeq = e.Seq
		}
	}
	return &Ledger{
		entries: entries,
		nextSeq: maxSeq,
		pool:    pool,
		db:      sqlDB,
		q:       q,
		ownsDB:  ownsDB,
	}, nil
}

// Append persists a new immutable ledger entry and returns the folded Progress.
func (l *Ledger) Append(ctx context.Context, entry LedgerEntry) (Progress, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.nextSeq++
	entry.Seq = l.nextSeq
	if l.q != nil {
		raw, err := json.Marshal(entry)
		if err != nil {
			l.nextSeq--
			return Progress{}, err
		}
		if err := l.q.InsertLedgerEntry(ctx, dbgen.InsertLedgerEntryParams{
			Seq:         entry.Seq,
			Kind:        string(entry.Kind),
			PayloadJson: string(raw),
			CreatedAtMs: entry.CreatedAtMs,
		}); err != nil {
			l.nextSeq--
			return Progress{}, err
		}
	}
	l.entries = append(l.entries, entry)
	return FoldProgress(l.entries), nil
}

// Progress returns the folded progression state from the full ledger.
func (l *Ledger) Progress() Progress {
	l.mu.Lock()
	defer l.mu.Unlock()
	return FoldProgress(l.entries)
}

// Close closes the backing SQLite connection when owned by this Ledger.
func (l *Ledger) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.ownsDB {
		return nil
	}
	var err error
	if l.pool != nil {
		err = l.pool.Close()
		l.pool = nil
		l.db = nil
		return err
	}
	if l.db != nil {
		err = l.db.Close()
		l.db = nil
		return err
	}
	return nil
}
