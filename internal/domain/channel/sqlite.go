package channel

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

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
	_ "modernc.org/sqlite"
)

var channelSchemaDDL = []string{
	`CREATE TABLE IF NOT EXISTS channel (
		id TEXT PRIMARY KEY,
		type TEXT NOT NULL,
		name TEXT NOT NULL DEFAULT '',
		topic TEXT NOT NULL DEFAULT '',
		repo_id TEXT NOT NULL DEFAULT '',
		default_agent_id TEXT NOT NULL DEFAULT '',
		peer_id TEXT NOT NULL DEFAULT '',
		parent_channel_id TEXT NOT NULL DEFAULT '',
		parent_event_seq INTEGER NOT NULL DEFAULT 0,
		issue_id TEXT NOT NULL DEFAULT '',
		is_default INTEGER NOT NULL DEFAULT 0,
		notify_mode TEXT NOT NULL DEFAULT 'all',
		created_at_ms INTEGER NOT NULL,
		updated_at_ms INTEGER NOT NULL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS channel_issue_thread_idx ON channel(issue_id) WHERE type = 'thread' AND issue_id <> ''`,

	`CREATE TABLE IF NOT EXISTS channel_member (
		channel_id TEXT NOT NULL,
		member_id TEXT NOT NULL,
		added_at_ms INTEGER NOT NULL,
		PRIMARY KEY (channel_id, member_id)
	)`,

	`CREATE TABLE IF NOT EXISTS channel_event (
		global_seq INTEGER PRIMARY KEY,
		channel_id TEXT NOT NULL,
		seq INTEGER NOT NULL,
		kind TEXT NOT NULL,
		author_id TEXT NOT NULL,
		actor_kind TEXT NOT NULL,
		actor_role TEXT NOT NULL DEFAULT '',
		text TEXT NOT NULL DEFAULT '',
		session_id TEXT NOT NULL DEFAULT '',
		issue_id TEXT NOT NULL DEFAULT '',
		mentions_json TEXT NOT NULL DEFAULT '[]',
		target_agent_id TEXT NOT NULL DEFAULT '',
		send_key TEXT NOT NULL DEFAULT '',
		question_json TEXT NOT NULL DEFAULT '',
		report_json TEXT NOT NULL DEFAULT '',
		reaction_json TEXT NOT NULL DEFAULT '',
		created_at_ms INTEGER NOT NULL,
		UNIQUE (channel_id, seq)
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS channel_event_send_key_idx ON channel_event(channel_id, author_id, send_key) WHERE send_key <> ''`,
	`CREATE INDEX IF NOT EXISTS channel_event_chan_seq_idx ON channel_event(channel_id, seq)`,

	`CREATE TRIGGER IF NOT EXISTS channel_event_no_update
	 BEFORE UPDATE ON channel_event
	 BEGIN
	     SELECT RAISE(ABORT, 'channel_event is append-only');
	 END`,

	`CREATE TRIGGER IF NOT EXISTS channel_event_no_delete
	 BEFORE DELETE ON channel_event
	 BEGIN
	     SELECT RAISE(ABORT, 'channel_event is append-only');
	 END`,

	`CREATE TABLE IF NOT EXISTS channel_read_cursor (
		channel_id TEXT NOT NULL,
		actor_id TEXT NOT NULL,
		read_seq INTEGER NOT NULL,
		updated_at_ms INTEGER NOT NULL,
		PRIMARY KEY (channel_id, actor_id)
	)`,
}

type sqliteBackend struct {
	mu      sync.Mutex
	db      *sql.DB
	ownsDB  bool
	nextSeq int64
}

func openSQLiteBackend(ctx context.Context, path string) (*sqliteBackend, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmtInvalid("empty sqlite path")
	}
	isMem := path == ":memory:" || strings.Contains(path, "mode=memory") || strings.Contains(path, ":memory:")
	if !isMem && !strings.HasPrefix(path, "file:") {
		if dir := filepath.Dir(path); dir != "" && dir != "." {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return nil, fmt.Errorf("channel: mkdir %s: %w", dir, err)
			}
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("channel: open sqlite: %w", err)
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
			return nil, fmt.Errorf("channel: %s: %w", p, err)
		}
	}
	return openSQLiteFromDB(ctx, db, true)
}

func openSQLiteFromDB(ctx context.Context, db *sql.DB, ownsDB bool) (*sqliteBackend, error) {
	if db == nil {
		return nil, fmtInvalid("sql.DB is required")
	}
	for _, ddl := range channelSchemaDDL {
		if _, err := db.ExecContext(ctx, ddl); err != nil {
			if ownsDB {
				_ = db.Close()
			}
			return nil, fmt.Errorf("channel: apply schema: %w", err)
		}
	}
	var maxGlobal int64
	if err := db.QueryRowContext(ctx, `SELECT COALESCE(MAX(global_seq), 0) FROM channel_event`).Scan(&maxGlobal); err != nil {
		if ownsDB {
			_ = db.Close()
		}
		return nil, fmt.Errorf("channel: read max global_seq: %w", err)
	}
	return &sqliteBackend{
		db:      db,
		ownsDB:  ownsDB,
		nextSeq: maxGlobal,
	}, nil
}

func (b *sqliteBackend) createChannel(ctx context.Context, ch Channel) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok, err := b.getChannelLocked(ctx, ch.ID); err != nil {
		return err
	} else if ok {
		return fmt.Errorf("%w: %q", ErrDuplicateChannel, ch.ID)
	}
	if ch.Type == TypeThread && ch.IssueID != "" {
		if existing, ok, err := b.getThreadByIssueLocked(ctx, ch.IssueID); err != nil {
			return err
		} else if ok {
			return fmt.Errorf("%w: thread for issue %q already exists (%s)", ErrDuplicateChannel, ch.IssueID, existing.ID)
		}
	}
	return b.insertChannelLocked(ctx, ch)
}

func (b *sqliteBackend) ensureChannel(ctx context.Context, ch Channel) (Channel, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if existing, ok, err := b.getChannelLocked(ctx, ch.ID); err != nil {
		return Channel{}, false, err
	} else if ok {
		return existing, false, nil
	}
	if ch.Type == TypeThread && ch.IssueID != "" {
		if existing, ok, err := b.getThreadByIssueLocked(ctx, ch.IssueID); err != nil {
			return Channel{}, false, err
		} else if ok {
			return existing, false, nil
		}
	}
	if err := b.insertChannelLocked(ctx, ch); err != nil {
		return Channel{}, false, err
	}
	return ch, true, nil
}

func (b *sqliteBackend) insertChannelLocked(ctx context.Context, ch Channel) error {
	isDefault := 0
	if ch.IsDefault {
		isDefault = 1
	}
	_, err := b.db.ExecContext(ctx, `INSERT INTO channel (
		id, type, name, topic, repo_id, default_agent_id, peer_id,
		parent_channel_id, parent_event_seq, issue_id, is_default, notify_mode,
		created_at_ms, updated_at_ms
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		ch.ID, string(ch.Type), ch.Name, ch.Topic, ch.RepoID, ch.DefaultAgentID, ch.PeerID,
		ch.ParentChannelID, ch.ParentEventSeq, ch.IssueID, isDefault, ch.NotifyMode,
		ch.CreatedAtMs, ch.UpdatedAtMs,
	)
	return err
}

func (b *sqliteBackend) getChannel(ctx context.Context, id string) (Channel, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.getChannelLocked(ctx, id)
}

func (b *sqliteBackend) getChannelLocked(ctx context.Context, id string) (Channel, bool, error) {
	row := b.db.QueryRowContext(ctx, `SELECT
		id, type, name, topic, repo_id, default_agent_id, peer_id,
		parent_channel_id, parent_event_seq, issue_id, is_default, notify_mode,
		created_at_ms, updated_at_ms
	FROM channel WHERE id = ?`, id)
	return scanChannel(row)
}

func (b *sqliteBackend) getThreadByIssue(ctx context.Context, issueID string) (Channel, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.getThreadByIssueLocked(ctx, issueID)
}

func (b *sqliteBackend) getThreadByIssueLocked(ctx context.Context, issueID string) (Channel, bool, error) {
	row := b.db.QueryRowContext(ctx, `SELECT
		id, type, name, topic, repo_id, default_agent_id, peer_id,
		parent_channel_id, parent_event_seq, issue_id, is_default, notify_mode,
		created_at_ms, updated_at_ms
	FROM channel WHERE type = 'thread' AND issue_id = ?`, issueID)
	return scanChannel(row)
}

func (b *sqliteBackend) listChannels(ctx context.Context) ([]Channel, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	rows, err := b.db.QueryContext(ctx, `SELECT
		id, type, name, topic, repo_id, default_agent_id, peer_id,
		parent_channel_id, parent_event_seq, issue_id, is_default, notify_mode,
		created_at_ms, updated_at_ms
	FROM channel ORDER BY created_at_ms ASC, id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Channel
	for rows.Next() {
		ch, _, err := scanChannel(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, ch)
	}
	return out, rows.Err()
}

func (b *sqliteBackend) addMember(ctx context.Context, channelID, memberID string, nowMs int64) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok, err := b.getChannelLocked(ctx, channelID); err != nil {
		return err
	} else if !ok {
		return fmt.Errorf("%w: channel %q", ErrNotFound, channelID)
	}
	_, err := b.db.ExecContext(ctx, `INSERT INTO channel_member (channel_id, member_id, added_at_ms)
		VALUES (?, ?, ?) ON CONFLICT (channel_id, member_id) DO NOTHING`,
		channelID, memberID, nowMs,
	)
	return err
}

func (b *sqliteBackend) removeMember(ctx context.Context, channelID, memberID string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, err := b.db.ExecContext(ctx, `DELETE FROM channel_member WHERE channel_id = ? AND member_id = ?`, channelID, memberID)
	return err
}

func (b *sqliteBackend) listMembers(ctx context.Context, channelID string) ([]string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok, err := b.getChannelLocked(ctx, channelID); err != nil {
		return nil, err
	} else if !ok {
		return nil, fmt.Errorf("%w: channel %q", ErrNotFound, channelID)
	}
	rows, err := b.db.QueryContext(ctx, `SELECT member_id FROM channel_member WHERE channel_id = ? ORDER BY member_id ASC`, channelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (b *sqliteBackend) appendEvent(ctx context.Context, req AppendRequest, nowMs int64) (AppendResult, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return AppendResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	var exists int
	if err := tx.QueryRowContext(ctx, `SELECT 1 FROM channel WHERE id = ?`, req.ChannelID).Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return AppendResult{}, fmt.Errorf("%w: channel %q", ErrNotFound, req.ChannelID)
		}
		return AppendResult{}, err
	}

	if req.SendKey != "" {
		row := tx.QueryRowContext(ctx, `SELECT `+eventColumns+` FROM channel_event WHERE channel_id = ? AND author_id = ? AND send_key = ?`,
			req.ChannelID, req.AuthorID, req.SendKey)
		existing, ok, err := scanEvent(row)
		if err != nil {
			return AppendResult{}, err
		}
		if ok {
			return AppendResult{Event: existing, Deduplicated: true}, nil
		}
	}

	var curChanSeq int64
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(seq), 0) FROM channel_event WHERE channel_id = ?`, req.ChannelID).Scan(&curChanSeq); err != nil {
		return AppendResult{}, err
	}
	if req.Kind == contract.ChannelEventReaction && req.Reaction != nil {
		if req.Reaction.TargetSeq > curChanSeq {
			return AppendResult{}, fmt.Errorf("%w: targetSeq %d not found in channel %q", ErrNotFound, req.Reaction.TargetSeq, req.ChannelID)
		}
	}

	nextGlobal := b.nextSeq + 1
	nextChanSeq := curChanSeq + 1

	mentionsJSON, err := json.Marshal(req.Mentions)
	if err != nil {
		return AppendResult{}, err
	}
	if req.Mentions == nil {
		mentionsJSON = []byte("[]")
	}
	var questionJSON, reportJSON, reactionJSON string
	if req.Question != nil {
		raw, err := json.Marshal(req.Question)
		if err != nil {
			return AppendResult{}, err
		}
		questionJSON = string(raw)
	}
	if req.Report != nil {
		raw, err := json.Marshal(req.Report)
		if err != nil {
			return AppendResult{}, err
		}
		reportJSON = string(raw)
	}
	if req.Reaction != nil {
		raw, err := json.Marshal(req.Reaction)
		if err != nil {
			return AppendResult{}, err
		}
		reactionJSON = string(raw)
	}

	if _, err := tx.ExecContext(ctx, `INSERT INTO channel_event (
		global_seq, channel_id, seq, kind, author_id, actor_kind, actor_role,
		text, session_id, issue_id, mentions_json, target_agent_id, send_key,
		question_json, report_json, reaction_json, created_at_ms
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		nextGlobal, req.ChannelID, nextChanSeq, string(req.Kind), req.AuthorID, string(req.ActorKind), string(req.ActorRole),
		req.Text, req.SessionID, req.IssueID, string(mentionsJSON), req.TargetAgentID, req.SendKey,
		questionJSON, reportJSON, reactionJSON, nowMs,
	); err != nil {
		return AppendResult{}, err
	}

	if _, err := tx.ExecContext(ctx, `UPDATE channel SET updated_at_ms = ? WHERE id = ?`, nowMs, req.ChannelID); err != nil {
		return AppendResult{}, err
	}

	if _, err := tx.ExecContext(ctx, `INSERT INTO channel_read_cursor (channel_id, actor_id, read_seq, updated_at_ms)
		VALUES (?, ?, ?, ?)
		ON CONFLICT (channel_id, actor_id) DO UPDATE SET
			read_seq = CASE WHEN excluded.read_seq > channel_read_cursor.read_seq THEN excluded.read_seq ELSE channel_read_cursor.read_seq END,
			updated_at_ms = CASE WHEN excluded.read_seq > channel_read_cursor.read_seq THEN excluded.updated_at_ms ELSE channel_read_cursor.updated_at_ms END`,
		req.ChannelID, req.AuthorID, nextChanSeq, nowMs,
	); err != nil {
		return AppendResult{}, err
	}

	if err := tx.Commit(); err != nil {
		return AppendResult{}, err
	}
	b.nextSeq = nextGlobal

	ev := Event{
		GlobalSeq:     nextGlobal,
		ChannelID:     req.ChannelID,
		Seq:           nextChanSeq,
		Kind:          req.Kind,
		AuthorID:      req.AuthorID,
		ActorKind:     req.ActorKind,
		ActorRole:     req.ActorRole,
		Text:          req.Text,
		SessionID:     req.SessionID,
		IssueID:       req.IssueID,
		Mentions:      req.Mentions,
		TargetAgentID: req.TargetAgentID,
		SendKey:       req.SendKey,
		Question:      req.Question,
		Report:        req.Report,
		Reaction:      req.Reaction,
		CreatedAtMs:   nowMs,
	}
	return AppendResult{Event: cloneEvent(ev), Deduplicated: false}, nil
}

func (b *sqliteBackend) getEvent(ctx context.Context, channelID string, seq int64) (Event, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	row := b.db.QueryRowContext(ctx, `SELECT `+eventColumns+` FROM channel_event WHERE channel_id = ? AND seq = ?`, channelID, seq)
	return scanEvent(row)
}

func (b *sqliteBackend) listEvents(ctx context.Context, channelID string, afterSeq int64, limit int) ([]Event, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok, err := b.getChannelLocked(ctx, channelID); err != nil {
		return nil, err
	} else if !ok {
		return nil, fmt.Errorf("%w: channel %q", ErrNotFound, channelID)
	}
	query := `SELECT ` + eventColumns + ` FROM channel_event WHERE channel_id = ? AND seq > ? ORDER BY seq ASC`
	var rows *sql.Rows
	var err error
	if limit > 0 {
		query += ` LIMIT ?`
		rows, err = b.db.QueryContext(ctx, query, channelID, afterSeq, limit)
	} else {
		rows, err = b.db.QueryContext(ctx, query, channelID, afterSeq)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Event
	for rows.Next() {
		ev, _, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, ev)
	}
	return out, rows.Err()
}

func (b *sqliteBackend) eventsAfterGlobal(ctx context.Context, afterGlobalSeq int64, limit int) ([]Event, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	query := `SELECT ` + eventColumns + ` FROM channel_event WHERE global_seq > ? ORDER BY global_seq ASC`
	var rows *sql.Rows
	var err error
	if limit > 0 {
		query += ` LIMIT ?`
		rows, err = b.db.QueryContext(ctx, query, afterGlobalSeq, limit)
	} else {
		rows, err = b.db.QueryContext(ctx, query, afterGlobalSeq)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Event
	for rows.Next() {
		ev, _, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, ev)
	}
	return out, rows.Err()
}

func (b *sqliteBackend) advanceReadCursor(ctx context.Context, channelID, actorID string, seq, nowMs int64) (ReadCursor, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok, err := b.getChannelLocked(ctx, channelID); err != nil {
		return ReadCursor{}, err
	} else if !ok {
		return ReadCursor{}, fmt.Errorf("%w: channel %q", ErrNotFound, channelID)
	}
	if _, err := b.db.ExecContext(ctx, `INSERT INTO channel_read_cursor (channel_id, actor_id, read_seq, updated_at_ms)
		VALUES (?, ?, ?, ?)
		ON CONFLICT (channel_id, actor_id) DO UPDATE SET
			read_seq = CASE WHEN excluded.read_seq > channel_read_cursor.read_seq THEN excluded.read_seq ELSE channel_read_cursor.read_seq END,
			updated_at_ms = CASE WHEN excluded.read_seq > channel_read_cursor.read_seq THEN excluded.updated_at_ms ELSE channel_read_cursor.updated_at_ms END`,
		channelID, actorID, seq, nowMs,
	); err != nil {
		return ReadCursor{}, err
	}
	rc, _, err := b.getReadCursorLocked(ctx, channelID, actorID)
	return rc, err
}

func (b *sqliteBackend) getReadCursor(ctx context.Context, channelID, actorID string) (ReadCursor, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok, err := b.getChannelLocked(ctx, channelID); err != nil {
		return ReadCursor{}, false, err
	} else if !ok {
		return ReadCursor{}, false, fmt.Errorf("%w: channel %q", ErrNotFound, channelID)
	}
	return b.getReadCursorLocked(ctx, channelID, actorID)
}

func (b *sqliteBackend) getReadCursorLocked(ctx context.Context, channelID, actorID string) (ReadCursor, bool, error) {
	var rc ReadCursor
	err := b.db.QueryRowContext(ctx, `SELECT channel_id, actor_id, read_seq, updated_at_ms
		FROM channel_read_cursor WHERE channel_id = ? AND actor_id = ?`, channelID, actorID).
		Scan(&rc.ChannelID, &rc.ActorID, &rc.ReadSeq, &rc.UpdatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return ReadCursor{}, false, nil
	}
	if err != nil {
		return ReadCursor{}, false, err
	}
	return rc, true, nil
}

func (b *sqliteBackend) listReadCursors(ctx context.Context, channelID string) ([]ReadCursor, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok, err := b.getChannelLocked(ctx, channelID); err != nil {
		return nil, err
	} else if !ok {
		return nil, fmt.Errorf("%w: channel %q", ErrNotFound, channelID)
	}
	rows, err := b.db.QueryContext(ctx, `SELECT channel_id, actor_id, read_seq, updated_at_ms
		FROM channel_read_cursor WHERE channel_id = ? ORDER BY actor_id ASC`, channelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ReadCursor
	for rows.Next() {
		var rc ReadCursor
		if err := rows.Scan(&rc.ChannelID, &rc.ActorID, &rc.ReadSeq, &rc.UpdatedAtMs); err != nil {
			return nil, err
		}
		out = append(out, rc)
	}
	return out, rows.Err()
}

func (b *sqliteBackend) unreadCount(ctx context.Context, channelID, actorID string) (int64, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok, err := b.getChannelLocked(ctx, channelID); err != nil {
		return 0, err
	} else if !ok {
		return 0, fmt.Errorf("%w: channel %q", ErrNotFound, channelID)
	}
	rc, _, err := b.getReadCursorLocked(ctx, channelID, actorID)
	if err != nil {
		return 0, err
	}
	var count int64
	if err := b.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM channel_event WHERE channel_id = ? AND seq > ? AND kind <> 'reaction'`,
		channelID, rc.ReadSeq).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

func (b *sqliteBackend) close() error {
	if b.ownsDB && b.db != nil {
		return b.db.Close()
	}
	return nil
}

const eventColumns = `global_seq, channel_id, seq, kind, author_id, actor_kind, actor_role,
	text, session_id, issue_id, mentions_json, target_agent_id, send_key,
	question_json, report_json, reaction_json, created_at_ms`

type rowScanner interface {
	Scan(dest ...any) error
}

func scanChannel(r rowScanner) (Channel, bool, error) {
	var ch Channel
	var typ string
	var isDef int
	err := r.Scan(
		&ch.ID, &typ, &ch.Name, &ch.Topic, &ch.RepoID, &ch.DefaultAgentID, &ch.PeerID,
		&ch.ParentChannelID, &ch.ParentEventSeq, &ch.IssueID, &isDef, &ch.NotifyMode,
		&ch.CreatedAtMs, &ch.UpdatedAtMs,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Channel{}, false, nil
	}
	if err != nil {
		return Channel{}, false, err
	}
	ch.Type = ChannelType(typ)
	ch.IsDefault = isDef != 0
	return ch, true, nil
}

func scanEvent(r rowScanner) (Event, bool, error) {
	var ev Event
	var kind, actorKind, actorRole string
	var mentionsJSON, questionJSON, reportJSON, reactionJSON string
	err := r.Scan(
		&ev.GlobalSeq, &ev.ChannelID, &ev.Seq, &kind, &ev.AuthorID, &actorKind, &actorRole,
		&ev.Text, &ev.SessionID, &ev.IssueID, &mentionsJSON, &ev.TargetAgentID, &ev.SendKey,
		&questionJSON, &reportJSON, &reactionJSON, &ev.CreatedAtMs,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Event{}, false, nil
	}
	if err != nil {
		return Event{}, false, err
	}
	ev.Kind = contract.ChannelEventKind(kind)
	ev.ActorKind = ActorKind(actorKind)
	ev.ActorRole = ActorRole(actorRole)
	if mentionsJSON != "" {
		_ = json.Unmarshal([]byte(mentionsJSON), &ev.Mentions)
	}
	if questionJSON != "" {
		var q QuestionCard
		if err := json.Unmarshal([]byte(questionJSON), &q); err != nil {
			return Event{}, false, err
		}
		ev.Question = &q
	}
	if reportJSON != "" {
		var rep ReportSummary
		if err := json.Unmarshal([]byte(reportJSON), &rep); err != nil {
			return Event{}, false, err
		}
		ev.Report = &rep
	}
	if reactionJSON != "" {
		var rc ReactionMeta
		if err := json.Unmarshal([]byte(reactionJSON), &rc); err != nil {
			return Event{}, false, err
		}
		ev.Reaction = &rc
	}
	return ev, true, nil
}
