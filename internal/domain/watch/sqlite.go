package watch

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

	"github.com/vibevalleyhq/vibevalley/internal/domain/channel"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
	_ "modernc.org/sqlite"
)

var watchSchemaDDL = []string{
	`CREATE TABLE IF NOT EXISTS watch_cursor (
		id TEXT PRIMARY KEY,
		last_global_seq INTEGER NOT NULL,
		updated_at_ms INTEGER NOT NULL
	)`,

	`CREATE TABLE IF NOT EXISTS watch_seat (
		channel_id TEXT NOT NULL,
		agent_id TEXT NOT NULL,
		role TEXT NOT NULL DEFAULT '',
		conversation_id TEXT NOT NULL DEFAULT '',
		session_id TEXT NOT NULL DEFAULT '',
		thread_owner INTEGER NOT NULL DEFAULT 0,
		home_channel_id TEXT NOT NULL DEFAULT '',
		active INTEGER NOT NULL DEFAULT 1,
		seated_at_ms INTEGER NOT NULL,
		PRIMARY KEY (channel_id, agent_id)
	)`,

	`CREATE TABLE IF NOT EXISTS watch_agent_home (
		agent_id TEXT PRIMARY KEY,
		channel_id TEXT NOT NULL
	)`,

	`CREATE TABLE IF NOT EXISTS watch_brake_state (
		id TEXT PRIMARY KEY,
		state_json TEXT NOT NULL
	)`,

	`CREATE TABLE IF NOT EXISTS watch_inbox (
		id TEXT PRIMARY KEY,
		kind TEXT NOT NULL,
		title TEXT NOT NULL,
		summary TEXT NOT NULL,
		session_id TEXT NOT NULL DEFAULT '',
		issue_id TEXT NOT NULL DEFAULT '',
		resolved INTEGER NOT NULL DEFAULT 0,
		channel_id TEXT NOT NULL DEFAULT '',
		event_seq INTEGER NOT NULL DEFAULT 0,
		created_at_ms INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS watch_inbox_chan_seq_idx ON watch_inbox(channel_id, event_seq)`,
}

type sqliteWatchBackend struct {
	mu     sync.Mutex
	db     *sql.DB
	ownsDB bool
}

func openSQLiteWatchBackend(ctx context.Context, path string) (*sqliteWatchBackend, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("%w: empty sqlite path", ErrInvalidArgument)
	}
	isMem := path == ":memory:" || strings.Contains(path, "mode=memory") || strings.Contains(path, ":memory:")
	if !isMem && !strings.HasPrefix(path, "file:") {
		if dir := filepath.Dir(path); dir != "" && dir != "." {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return nil, fmt.Errorf("watch: mkdir %s: %w", dir, err)
			}
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("watch: open sqlite: %w", err)
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
			return nil, fmt.Errorf("watch: %s: %w", p, err)
		}
	}
	return openSQLiteWatchFromDB(ctx, db, true)
}

func openSQLiteWatchFromDB(ctx context.Context, db *sql.DB, ownsDB bool) (*sqliteWatchBackend, error) {
	if db == nil {
		return nil, fmt.Errorf("%w: sql.DB is required", ErrInvalidArgument)
	}
	for _, ddl := range watchSchemaDDL {
		if _, err := db.ExecContext(ctx, ddl); err != nil {
			if ownsDB {
				_ = db.Close()
			}
			return nil, fmt.Errorf("watch: apply schema: %w", err)
		}
	}
	return &sqliteWatchBackend{db: db, ownsDB: ownsDB}, nil
}

func (b *sqliteWatchBackend) getCursor(ctx context.Context) (int64, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	var seq int64
	err := b.db.QueryRowContext(ctx, `SELECT last_global_seq FROM watch_cursor WHERE id = 'default'`).Scan(&seq)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return seq, err
}

func (b *sqliteWatchBackend) setCursor(ctx context.Context, globalSeq, nowMs int64) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, err := b.db.ExecContext(ctx, `INSERT INTO watch_cursor (id, last_global_seq, updated_at_ms)
		VALUES ('default', ?, ?)
		ON CONFLICT (id) DO UPDATE SET
			last_global_seq = CASE WHEN excluded.last_global_seq > watch_cursor.last_global_seq THEN excluded.last_global_seq ELSE watch_cursor.last_global_seq END,
			updated_at_ms = excluded.updated_at_ms`,
		globalSeq, nowMs,
	)
	return err
}

func (b *sqliteWatchBackend) upsertSeat(ctx context.Context, seat Seat, maxPerChan, maxActive int) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	var prevActive int
	err = tx.QueryRowContext(ctx, `SELECT active FROM watch_seat WHERE channel_id = ? AND agent_id = ?`,
		seat.ChannelID, seat.AgentID).Scan(&prevActive)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	wasActive := err == nil && prevActive != 0

	if seat.Active && !wasActive && seat.Role == channel.RoleWorker {
		if maxPerChan > 0 {
			var cnt int
			if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM watch_seat WHERE channel_id = ? AND active = 1 AND role = 'worker'`,
				seat.ChannelID).Scan(&cnt); err != nil {
				return err
			}
			if cnt >= maxPerChan {
				return fmt.Errorf("%w: channel %q reached limit %d", ErrSeatCapacityReached, seat.ChannelID, maxPerChan)
			}
		}
		if maxActive > 0 {
			var cnt int
			if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM watch_seat WHERE active = 1 AND role = 'worker'`).Scan(&cnt); err != nil {
				return err
			}
			if cnt >= maxActive {
				return fmt.Errorf("%w: global active limit %d", ErrSeatCapacityReached, maxActive)
			}
		}
	}

	threadOwner := 0
	if seat.ThreadOwner {
		threadOwner = 1
	}
	active := 0
	if seat.Active {
		active = 1
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO watch_seat (
		channel_id, agent_id, role, conversation_id, session_id, thread_owner, home_channel_id, active, seated_at_ms
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT (channel_id, agent_id) DO UPDATE SET
		role = excluded.role,
		conversation_id = excluded.conversation_id,
		session_id = excluded.session_id,
		thread_owner = excluded.thread_owner,
		home_channel_id = excluded.home_channel_id,
		active = excluded.active,
		seated_at_ms = excluded.seated_at_ms`,
		seat.ChannelID, seat.AgentID, string(seat.Role), seat.ConversationID, seat.SessionID,
		threadOwner, seat.HomeChannelID, active, seat.SeatedAtMs,
	); err != nil {
		return err
	}

	homeChan := seat.HomeChannelID
	if homeChan == "" && seat.Active {
		homeChan = seat.ChannelID
	}
	if homeChan != "" {
		if _, err := tx.ExecContext(ctx, `INSERT INTO watch_agent_home (agent_id, channel_id) VALUES (?, ?)
			ON CONFLICT (agent_id) DO UPDATE SET channel_id = excluded.channel_id`,
			seat.AgentID, homeChan,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (b *sqliteWatchBackend) vacateSeat(ctx context.Context, channelID, agentID string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, err := b.db.ExecContext(ctx, `UPDATE watch_seat SET active = 0 WHERE channel_id = ? AND agent_id = ?`, channelID, agentID)
	return err
}

func (b *sqliteWatchBackend) getSeat(ctx context.Context, channelID, agentID string) (Seat, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	row := b.db.QueryRowContext(ctx, `SELECT
		channel_id, agent_id, role, conversation_id, session_id, thread_owner, home_channel_id, active, seated_at_ms
	FROM watch_seat WHERE channel_id = ? AND agent_id = ?`, channelID, agentID)
	return scanSeat(row)
}

func (b *sqliteWatchBackend) listSeats(ctx context.Context, channelID string) ([]Seat, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	var rows *sql.Rows
	var err error
	if channelID != "" {
		rows, err = b.db.QueryContext(ctx, `SELECT
			channel_id, agent_id, role, conversation_id, session_id, thread_owner, home_channel_id, active, seated_at_ms
		FROM watch_seat WHERE channel_id = ? AND active = 1 ORDER BY channel_id ASC, agent_id ASC`, channelID)
	} else {
		rows, err = b.db.QueryContext(ctx, `SELECT
			channel_id, agent_id, role, conversation_id, session_id, thread_owner, home_channel_id, active, seated_at_ms
		FROM watch_seat WHERE active = 1 ORDER BY channel_id ASC, agent_id ASC`)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Seat
	for rows.Next() {
		s, _, err := scanSeat(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (b *sqliteWatchBackend) homeOf(ctx context.Context, agentID string) (string, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	var chID string
	err := b.db.QueryRowContext(ctx, `SELECT channel_id FROM watch_agent_home WHERE agent_id = ?`, agentID).Scan(&chID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return chID, true, nil
}

func (b *sqliteWatchBackend) loadBrakes(ctx context.Context) (BrakeState, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	var raw string
	err := b.db.QueryRowContext(ctx, `SELECT state_json FROM watch_brake_state WHERE id = 'default'`).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return newBrakeState(), nil
	}
	if err != nil {
		return BrakeState{}, err
	}
	st := newBrakeState()
	if err := json.Unmarshal([]byte(raw), &st); err != nil {
		return BrakeState{}, err
	}
	return cloneBrakeState(st), nil
}

func (b *sqliteWatchBackend) saveBrakes(ctx context.Context, state BrakeState) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	_, err = b.db.ExecContext(ctx, `INSERT INTO watch_brake_state (id, state_json) VALUES ('default', ?)
		ON CONFLICT (id) DO UPDATE SET state_json = excluded.state_json`, string(raw))
	return err
}

func (b *sqliteWatchBackend) upsertInbox(ctx context.Context, item contract.InboxItemView) error {
	return b.upsertInboxWithChannel(ctx, item, "", 0)
}

func (b *sqliteWatchBackend) upsertInboxWithChannel(ctx context.Context, item contract.InboxItemView, channelID string, eventSeq int64) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	resolved := 0
	if item.Resolved {
		resolved = 1
	}
	_, err := b.db.ExecContext(ctx, `INSERT INTO watch_inbox (
		id, kind, title, summary, session_id, issue_id, resolved, channel_id, event_seq, created_at_ms
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT (id) DO UPDATE SET
		kind = excluded.kind,
		title = excluded.title,
		summary = excluded.summary,
		session_id = excluded.session_id,
		issue_id = excluded.issue_id,
		resolved = CASE WHEN watch_inbox.resolved = 1 THEN 1 ELSE excluded.resolved END,
		channel_id = CASE WHEN excluded.channel_id <> '' THEN excluded.channel_id ELSE watch_inbox.channel_id END,
		event_seq = CASE WHEN excluded.event_seq > 0 THEN excluded.event_seq ELSE watch_inbox.event_seq END`,
		item.ID, string(item.Kind), item.Title, item.Summary, item.SessionID, item.IssueID,
		resolved, channelID, eventSeq, item.CreatedAtMs,
	)
	return err
}

func (b *sqliteWatchBackend) resolveInbox(ctx context.Context, id string) (bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	res, err := b.db.ExecContext(ctx, `UPDATE watch_inbox SET resolved = 1 WHERE id = ?`, id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (b *sqliteWatchBackend) resolveChannelInboxUpTo(ctx context.Context, channelID string, maxSeq int64) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, err := b.db.ExecContext(ctx, `UPDATE watch_inbox SET resolved = 1
		WHERE channel_id = ? AND event_seq > 0 AND event_seq <= ? AND resolved = 0`,
		channelID, maxSeq,
	)
	return err
}

func (b *sqliteWatchBackend) listInbox(ctx context.Context, includeResolved bool) ([]contract.InboxItemView, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	query := `SELECT id, kind, title, summary, session_id, issue_id, resolved, created_at_ms FROM watch_inbox`
	if !includeResolved {
		query += ` WHERE resolved = 0`
	}
	query += ` ORDER BY created_at_ms ASC, id ASC`
	rows, err := b.db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []contract.InboxItemView
	for rows.Next() {
		var it contract.InboxItemView
		var kind string
		var resolved int
		if err := rows.Scan(&it.ID, &kind, &it.Title, &it.Summary, &it.SessionID, &it.IssueID, &resolved, &it.CreatedAtMs); err != nil {
			return nil, err
		}
		it.Kind = contract.InboxItemKind(kind)
		it.Resolved = resolved != 0
		out = append(out, it)
	}
	return out, rows.Err()
}

func (b *sqliteWatchBackend) close() error {
	if b.ownsDB && b.db != nil {
		return b.db.Close()
	}
	return nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanSeat(r rowScanner) (Seat, bool, error) {
	var s Seat
	var role string
	var threadOwner, active int
	err := r.Scan(
		&s.ChannelID, &s.AgentID, &role, &s.ConversationID, &s.SessionID,
		&threadOwner, &s.HomeChannelID, &active, &s.SeatedAtMs,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Seat{}, false, nil
	}
	if err != nil {
		return Seat{}, false, err
	}
	s.Role = channel.ActorRole(role)
	s.ThreadOwner = threadOwner != 0
	s.Active = active != 0
	return s, true, nil
}
