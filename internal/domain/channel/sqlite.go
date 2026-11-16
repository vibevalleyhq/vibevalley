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

	"github.com/vibevalleyhq/vibevalley/internal/domain/channel/sqlcgen"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
	"github.com/vibevalleyhq/vibevalley/pkg/migrate"
	_ "modernc.org/sqlite"
)

type sqliteBackend struct {
	mu      sync.Mutex
	db      *sql.DB
	queries *sqlcgen.Queries
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
	runner, err := migrate.New(db, "channel", MigrationsFS)
	if err != nil {
		if ownsDB {
			_ = db.Close()
		}
		return nil, fmt.Errorf("channel: init migrations: %w", err)
	}
	if _, err := runner.Up(ctx); err != nil {
		if ownsDB {
			_ = db.Close()
		}
		return nil, fmt.Errorf("channel: apply migrations: %w", err)
	}
	queries := sqlcgen.New(db)
	maxGlobal, err := queries.MaxGlobalSeq(ctx)
	if err != nil {
		if ownsDB {
			_ = db.Close()
		}
		return nil, fmt.Errorf("channel: read max global_seq: %w", err)
	}
	return &sqliteBackend{
		db:      db,
		queries: queries,
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
	var isDefault int64
	if ch.IsDefault {
		isDefault = 1
	}
	return b.queries.InsertChannel(ctx, sqlcgen.InsertChannelParams{
		ID:              ch.ID,
		Type:            string(ch.Type),
		Name:            ch.Name,
		Topic:           ch.Topic,
		RepoID:          ch.RepoID,
		DefaultAgentID:  ch.DefaultAgentID,
		PeerID:          ch.PeerID,
		ParentChannelID: ch.ParentChannelID,
		ParentEventSeq:  ch.ParentEventSeq,
		IssueID:         ch.IssueID,
		IsDefault:       isDefault,
		NotifyMode:      ch.NotifyMode,
		CreatedAtMs:     ch.CreatedAtMs,
		UpdatedAtMs:     ch.UpdatedAtMs,
	})
}

func (b *sqliteBackend) getChannel(ctx context.Context, id string) (Channel, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.getChannelLocked(ctx, id)
}

func (b *sqliteBackend) getChannelLocked(ctx context.Context, id string) (Channel, bool, error) {
	row, err := b.queries.GetChannel(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Channel{}, false, nil
	}
	if err != nil {
		return Channel{}, false, err
	}
	return channelFromRow(row), true, nil
}

func (b *sqliteBackend) getThreadByIssue(ctx context.Context, issueID string) (Channel, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.getThreadByIssueLocked(ctx, issueID)
}

func (b *sqliteBackend) getThreadByIssueLocked(ctx context.Context, issueID string) (Channel, bool, error) {
	row, err := b.queries.GetThreadByIssue(ctx, issueID)
	if errors.Is(err, sql.ErrNoRows) {
		return Channel{}, false, nil
	}
	if err != nil {
		return Channel{}, false, err
	}
	return channelFromRow(row), true, nil
}

func (b *sqliteBackend) listChannels(ctx context.Context) ([]Channel, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	rows, err := b.queries.ListChannels(ctx)
	if err != nil {
		return nil, err
	}
	var out []Channel
	for _, row := range rows {
		out = append(out, channelFromRow(row))
	}
	return out, nil
}

func (b *sqliteBackend) addMember(ctx context.Context, channelID, memberID string, nowMs int64) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok, err := b.getChannelLocked(ctx, channelID); err != nil {
		return err
	} else if !ok {
		return fmt.Errorf("%w: channel %q", ErrNotFound, channelID)
	}
	return b.queries.AddChannelMember(ctx, sqlcgen.AddChannelMemberParams{
		ChannelID: channelID,
		MemberID:  memberID,
		AddedAtMs: nowMs,
	})
}

func (b *sqliteBackend) removeMember(ctx context.Context, channelID, memberID string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.queries.RemoveChannelMember(ctx, sqlcgen.RemoveChannelMemberParams{
		ChannelID: channelID,
		MemberID:  memberID,
	})
}

func (b *sqliteBackend) listMembers(ctx context.Context, channelID string) ([]string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok, err := b.getChannelLocked(ctx, channelID); err != nil {
		return nil, err
	} else if !ok {
		return nil, fmt.Errorf("%w: channel %q", ErrNotFound, channelID)
	}
	return b.queries.ListChannelMembers(ctx, channelID)
}

func (b *sqliteBackend) appendEvent(ctx context.Context, req AppendRequest, nowMs int64) (AppendResult, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return AppendResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	qtx := b.queries.WithTx(tx)

	if _, err := qtx.ChannelExists(ctx, req.ChannelID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return AppendResult{}, fmt.Errorf("%w: channel %q", ErrNotFound, req.ChannelID)
		}
		return AppendResult{}, err
	}

	if req.SendKey != "" {
		row, err := qtx.GetChannelEventBySendKey(ctx, sqlcgen.GetChannelEventBySendKeyParams{
			ChannelID: req.ChannelID,
			AuthorID:  req.AuthorID,
			SendKey:   req.SendKey,
		})
		if err == nil {
			existing, convErr := eventFromRow(row)
			if convErr != nil {
				return AppendResult{}, convErr
			}
			return AppendResult{Event: existing, Deduplicated: true}, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return AppendResult{}, err
		}
	}

	curChanSeq, err := qtx.MaxChannelSeq(ctx, req.ChannelID)
	if err != nil {
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

	if err := qtx.InsertChannelEvent(ctx, sqlcgen.InsertChannelEventParams{
		GlobalSeq:     nextGlobal,
		ChannelID:     req.ChannelID,
		Seq:           nextChanSeq,
		Kind:          string(req.Kind),
		AuthorID:      req.AuthorID,
		ActorKind:     string(req.ActorKind),
		ActorRole:     string(req.ActorRole),
		Text:          req.Text,
		SessionID:     req.SessionID,
		IssueID:       req.IssueID,
		MentionsJson:  string(mentionsJSON),
		TargetAgentID: req.TargetAgentID,
		SendKey:       req.SendKey,
		QuestionJson:  questionJSON,
		ReportJson:    reportJSON,
		ReactionJson:  reactionJSON,
		CreatedAtMs:   nowMs,
	}); err != nil {
		return AppendResult{}, err
	}

	if err := qtx.TouchChannelUpdatedAt(ctx, sqlcgen.TouchChannelUpdatedAtParams{
		UpdatedAtMs: nowMs,
		ID:          req.ChannelID,
	}); err != nil {
		return AppendResult{}, err
	}

	if err := qtx.UpsertReadCursor(ctx, sqlcgen.UpsertReadCursorParams{
		ChannelID:   req.ChannelID,
		ActorID:     req.AuthorID,
		ReadSeq:     nextChanSeq,
		UpdatedAtMs: nowMs,
	}); err != nil {
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
	row, err := b.queries.GetChannelEvent(ctx, sqlcgen.GetChannelEventParams{
		ChannelID: channelID,
		Seq:       seq,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return Event{}, false, nil
	}
	if err != nil {
		return Event{}, false, err
	}
	ev, err := eventFromRow(row)
	if err != nil {
		return Event{}, false, err
	}
	return ev, true, nil
}

func (b *sqliteBackend) listEvents(ctx context.Context, channelID string, afterSeq int64, limit int) ([]Event, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok, err := b.getChannelLocked(ctx, channelID); err != nil {
		return nil, err
	} else if !ok {
		return nil, fmt.Errorf("%w: channel %q", ErrNotFound, channelID)
	}
	var rows []sqlcgen.ChannelEvent
	var err error
	if limit > 0 {
		rows, err = b.queries.ListChannelEventsLimit(ctx, sqlcgen.ListChannelEventsLimitParams{
			ChannelID: channelID,
			Seq:       afterSeq,
			Limit:     int64(limit),
		})
	} else {
		rows, err = b.queries.ListChannelEvents(ctx, sqlcgen.ListChannelEventsParams{
			ChannelID: channelID,
			Seq:       afterSeq,
		})
	}
	if err != nil {
		return nil, err
	}
	return eventsFromRows(rows)
}

func (b *sqliteBackend) eventsAfterGlobal(ctx context.Context, afterGlobalSeq int64, limit int) ([]Event, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	var rows []sqlcgen.ChannelEvent
	var err error
	if limit > 0 {
		rows, err = b.queries.ListEventsAfterGlobalLimit(ctx, sqlcgen.ListEventsAfterGlobalLimitParams{
			GlobalSeq: afterGlobalSeq,
			Limit:     int64(limit),
		})
	} else {
		rows, err = b.queries.ListEventsAfterGlobal(ctx, afterGlobalSeq)
	}
	if err != nil {
		return nil, err
	}
	return eventsFromRows(rows)
}

func (b *sqliteBackend) advanceReadCursor(ctx context.Context, channelID, actorID string, seq, nowMs int64) (ReadCursor, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok, err := b.getChannelLocked(ctx, channelID); err != nil {
		return ReadCursor{}, err
	} else if !ok {
		return ReadCursor{}, fmt.Errorf("%w: channel %q", ErrNotFound, channelID)
	}
	if err := b.queries.UpsertReadCursor(ctx, sqlcgen.UpsertReadCursorParams{
		ChannelID:   channelID,
		ActorID:     actorID,
		ReadSeq:     seq,
		UpdatedAtMs: nowMs,
	}); err != nil {
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
	row, err := b.queries.GetReadCursor(ctx, sqlcgen.GetReadCursorParams{
		ChannelID: channelID,
		ActorID:   actorID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return ReadCursor{}, false, nil
	}
	if err != nil {
		return ReadCursor{}, false, err
	}
	return ReadCursor{
		ChannelID:   row.ChannelID,
		ActorID:     row.ActorID,
		ReadSeq:     row.ReadSeq,
		UpdatedAtMs: row.UpdatedAtMs,
	}, true, nil
}

func (b *sqliteBackend) listReadCursors(ctx context.Context, channelID string) ([]ReadCursor, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok, err := b.getChannelLocked(ctx, channelID); err != nil {
		return nil, err
	} else if !ok {
		return nil, fmt.Errorf("%w: channel %q", ErrNotFound, channelID)
	}
	rows, err := b.queries.ListReadCursors(ctx, channelID)
	if err != nil {
		return nil, err
	}
	var out []ReadCursor
	for _, row := range rows {
		out = append(out, ReadCursor{
			ChannelID:   row.ChannelID,
			ActorID:     row.ActorID,
			ReadSeq:     row.ReadSeq,
			UpdatedAtMs: row.UpdatedAtMs,
		})
	}
	return out, nil
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
	return b.queries.CountUnreadEvents(ctx, sqlcgen.CountUnreadEventsParams{
		ChannelID: channelID,
		Seq:       rc.ReadSeq,
	})
}

func (b *sqliteBackend) close() error {
	if b.ownsDB && b.db != nil {
		return b.db.Close()
	}
	return nil
}

func channelFromRow(r sqlcgen.Channel) Channel {
	return Channel{
		ID:              r.ID,
		Type:            ChannelType(r.Type),
		Name:            r.Name,
		Topic:           r.Topic,
		RepoID:          r.RepoID,
		DefaultAgentID:  r.DefaultAgentID,
		PeerID:          r.PeerID,
		ParentChannelID: r.ParentChannelID,
		ParentEventSeq:  r.ParentEventSeq,
		IssueID:         r.IssueID,
		IsDefault:       r.IsDefault != 0,
		NotifyMode:      r.NotifyMode,
		CreatedAtMs:     r.CreatedAtMs,
		UpdatedAtMs:     r.UpdatedAtMs,
	}
}

func eventsFromRows(rows []sqlcgen.ChannelEvent) ([]Event, error) {
	var out []Event
	for _, row := range rows {
		ev, err := eventFromRow(row)
		if err != nil {
			return nil, err
		}
		out = append(out, ev)
	}
	return out, nil
}

func eventFromRow(r sqlcgen.ChannelEvent) (Event, error) {
	ev := Event{
		GlobalSeq:     r.GlobalSeq,
		ChannelID:     r.ChannelID,
		Seq:           r.Seq,
		Kind:          contract.ChannelEventKind(r.Kind),
		AuthorID:      r.AuthorID,
		ActorKind:     ActorKind(r.ActorKind),
		ActorRole:     ActorRole(r.ActorRole),
		Text:          r.Text,
		SessionID:     r.SessionID,
		IssueID:       r.IssueID,
		TargetAgentID: r.TargetAgentID,
		SendKey:       r.SendKey,
		CreatedAtMs:   r.CreatedAtMs,
	}
	if r.MentionsJson != "" {
		_ = json.Unmarshal([]byte(r.MentionsJson), &ev.Mentions)
	}
	if r.QuestionJson != "" {
		var q QuestionCard
		if err := json.Unmarshal([]byte(r.QuestionJson), &q); err != nil {
			return Event{}, err
		}
		ev.Question = &q
	}
	if r.ReportJson != "" {
		var rep ReportSummary
		if err := json.Unmarshal([]byte(r.ReportJson), &rep); err != nil {
			return Event{}, err
		}
		ev.Report = &rep
	}
	if r.ReactionJson != "" {
		var rc ReactionMeta
		if err := json.Unmarshal([]byte(r.ReactionJson), &rc); err != nil {
			return Event{}, err
		}
		ev.Reaction = &rc
	}
	return ev, nil
}
