package game

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"

	_ "modernc.org/sqlite"
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
	db      *sql.DB
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
	isMem := path == ":memory:" || strings.Contains(path, "mode=memory")
	if !isMem && !strings.HasPrefix(path, "file:") {
		if dir := filepath.Dir(path); dir != "" && dir != "." {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return nil, err
			}
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if !isMem {
		_, _ = db.ExecContext(ctx, "PRAGMA journal_mode=WAL")
	}
	_, _ = db.ExecContext(ctx, "PRAGMA synchronous=NORMAL")
	_, _ = db.ExecContext(ctx, "PRAGMA busy_timeout=5000")
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS game_ledger (
		seq INTEGER PRIMARY KEY,
		kind TEXT NOT NULL,
		payload_json TEXT NOT NULL,
		created_at_ms INTEGER NOT NULL
	)`); err != nil {
		_ = db.Close()
		return nil, err
	}

	rows, err := db.QueryContext(ctx, `SELECT payload_json FROM game_ledger ORDER BY seq ASC`)
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	defer rows.Close()
	var entries []LedgerEntry
	var maxSeq int64
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			_ = db.Close()
			return nil, err
		}
		var e LedgerEntry
		if err := json.Unmarshal([]byte(raw), &e); err != nil {
			_ = db.Close()
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
		db:      db,
	}, nil
}

// Append persists a new immutable ledger entry and returns the folded Progress.
func (l *Ledger) Append(ctx context.Context, entry LedgerEntry) (Progress, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.nextSeq++
	entry.Seq = l.nextSeq
	if l.db != nil {
		raw, err := json.Marshal(entry)
		if err != nil {
			l.nextSeq--
			return Progress{}, err
		}
		if _, err := l.db.ExecContext(ctx, `INSERT INTO game_ledger (seq, kind, payload_json, created_at_ms) VALUES (?, ?, ?, ?)`,
			entry.Seq, string(entry.Kind), string(raw), entry.CreatedAtMs); err != nil {
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

// Close closes the backing SQLite connection if present.
func (l *Ledger) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.db != nil {
		return l.db.Close()
	}
	return nil
}
