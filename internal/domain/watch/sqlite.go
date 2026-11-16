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
	"github.com/vibevalleyhq/vibevalley/internal/domain/watch/sqlcgen"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
	"github.com/vibevalleyhq/vibevalley/pkg/migrate"
	_ "modernc.org/sqlite"
)

type sqliteWatchBackend struct {
	mu      sync.Mutex
	db      *sql.DB
	queries *sqlcgen.Queries
	ownsDB  bool
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
	runner, err := migrate.New(db, "watch", MigrationsFS)
	if err != nil {
		if ownsDB {
			_ = db.Close()
		}
		return nil, fmt.Errorf("watch: init migrations: %w", err)
	}
	if _, err := runner.Up(ctx); err != nil {
		if ownsDB {
			_ = db.Close()
		}
		return nil, fmt.Errorf("watch: apply migrations: %w", err)
	}
	return &sqliteWatchBackend{
		db:      db,
		queries: sqlcgen.New(db),
		ownsDB:  ownsDB,
	}, nil
}

func (b *sqliteWatchBackend) getCursor(ctx context.Context) (int64, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	seq, err := b.queries.GetCursor(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return seq, err
}

func (b *sqliteWatchBackend) setCursor(ctx context.Context, globalSeq, nowMs int64) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.queries.UpsertCursor(ctx, sqlcgen.UpsertCursorParams{
		LastGlobalSeq: globalSeq,
		UpdatedAtMs:   nowMs,
	})
}

func (b *sqliteWatchBackend) upsertSeat(ctx context.Context, seat Seat, maxPerChan, maxActive int) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	qtx := b.queries.WithTx(tx)

	prevActive, err := qtx.GetSeatActive(ctx, sqlcgen.GetSeatActiveParams{
		ChannelID: seat.ChannelID,
		AgentID:   seat.AgentID,
	})
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	wasActive := err == nil && prevActive != 0

	if seat.Active && !wasActive && seat.Role == channel.RoleWorker {
		if maxPerChan > 0 {
			cnt, err := qtx.CountActiveChannelWorkers(ctx, seat.ChannelID)
			if err != nil {
				return err
			}
			if int(cnt) >= maxPerChan {
				return fmt.Errorf("%w: channel %q reached limit %d", ErrSeatCapacityReached, seat.ChannelID, maxPerChan)
			}
		}
		if maxActive > 0 {
			cnt, err := qtx.CountActiveWorkers(ctx)
			if err != nil {
				return err
			}
			if int(cnt) >= maxActive {
				return fmt.Errorf("%w: global active limit %d", ErrSeatCapacityReached, maxActive)
			}
		}
	}

	var threadOwner, active int64
	if seat.ThreadOwner {
		threadOwner = 1
	}
	if seat.Active {
		active = 1
	}
	if err := qtx.UpsertSeat(ctx, sqlcgen.UpsertSeatParams{
		ChannelID:      seat.ChannelID,
		AgentID:        seat.AgentID,
		Role:           string(seat.Role),
		ConversationID: seat.ConversationID,
		SessionID:      seat.SessionID,
		ThreadOwner:    threadOwner,
		HomeChannelID:  seat.HomeChannelID,
		Active:         active,
		SeatedAtMs:     seat.SeatedAtMs,
	}); err != nil {
		return err
	}

	homeChan := seat.HomeChannelID
	if homeChan == "" && seat.Active {
		homeChan = seat.ChannelID
	}
	if homeChan != "" {
		if err := qtx.UpsertAgentHome(ctx, sqlcgen.UpsertAgentHomeParams{
			AgentID:   seat.AgentID,
			ChannelID: homeChan,
		}); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (b *sqliteWatchBackend) vacateSeat(ctx context.Context, channelID, agentID string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.queries.VacateSeat(ctx, sqlcgen.VacateSeatParams{
		ChannelID: channelID,
		AgentID:   agentID,
	})
}

func (b *sqliteWatchBackend) getSeat(ctx context.Context, channelID, agentID string) (Seat, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	row, err := b.queries.GetSeat(ctx, sqlcgen.GetSeatParams{
		ChannelID: channelID,
		AgentID:   agentID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return Seat{}, false, nil
	}
	if err != nil {
		return Seat{}, false, err
	}
	return seatFromRow(row), true, nil
}

func (b *sqliteWatchBackend) listSeats(ctx context.Context, channelID string) ([]Seat, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	var rows []sqlcgen.WatchSeat
	var err error
	if channelID != "" {
		rows, err = b.queries.ListWatchSeatsByChannel(ctx, channelID)
	} else {
		rows, err = b.queries.ListWatchSeats(ctx)
	}
	if err != nil {
		return nil, err
	}
	var out []Seat
	for _, row := range rows {
		out = append(out, seatFromRow(row))
	}
	return out, nil
}

func (b *sqliteWatchBackend) homeOf(ctx context.Context, agentID string) (string, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	chID, err := b.queries.GetAgentHome(ctx, agentID)
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
	raw, err := b.queries.GetBrakeState(ctx)
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
	return b.queries.UpsertBrakeState(ctx, string(raw))
}

func (b *sqliteWatchBackend) upsertInbox(ctx context.Context, item contract.InboxItemView) error {
	return b.upsertInboxWithChannel(ctx, item, "", 0)
}

func (b *sqliteWatchBackend) upsertInboxWithChannel(ctx context.Context, item contract.InboxItemView, channelID string, eventSeq int64) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	var resolved int64
	if item.Resolved {
		resolved = 1
	}
	return b.queries.UpsertInbox(ctx, sqlcgen.UpsertInboxParams{
		ID:          item.ID,
		Kind:        string(item.Kind),
		Title:       item.Title,
		Summary:     item.Summary,
		SessionID:   item.SessionID,
		IssueID:     item.IssueID,
		Resolved:    resolved,
		ChannelID:   channelID,
		EventSeq:    eventSeq,
		CreatedAtMs: item.CreatedAtMs,
	})
}

func (b *sqliteWatchBackend) resolveInbox(ctx context.Context, id string) (bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n, err := b.queries.ResolveInbox(ctx, id)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

func (b *sqliteWatchBackend) resolveChannelInboxUpTo(ctx context.Context, channelID string, maxSeq int64) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.queries.ResolveChannelInboxUpTo(ctx, sqlcgen.ResolveChannelInboxUpToParams{
		ChannelID: channelID,
		EventSeq:  maxSeq,
	})
}

func (b *sqliteWatchBackend) listInbox(ctx context.Context, includeResolved bool) ([]contract.InboxItemView, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if includeResolved {
		rows, err := b.queries.ListWatchInbox(ctx)
		if err != nil {
			return nil, err
		}
		var out []contract.InboxItemView
		for _, r := range rows {
			out = append(out, toInboxItemView(r.ID, r.Kind, r.Title, r.Summary, r.SessionID, r.IssueID, r.Resolved, r.CreatedAtMs))
		}
		return out, nil
	}
	rows, err := b.queries.ListUnresolvedWatchInbox(ctx)
	if err != nil {
		return nil, err
	}
	var out []contract.InboxItemView
	for _, r := range rows {
		out = append(out, toInboxItemView(r.ID, r.Kind, r.Title, r.Summary, r.SessionID, r.IssueID, r.Resolved, r.CreatedAtMs))
	}
	return out, nil
}

func (b *sqliteWatchBackend) close() error {
	if b.ownsDB && b.db != nil {
		return b.db.Close()
	}
	return nil
}

func seatFromRow(r sqlcgen.WatchSeat) Seat {
	return Seat{
		ChannelID:      r.ChannelID,
		AgentID:        r.AgentID,
		Role:           channel.ActorRole(r.Role),
		ConversationID: r.ConversationID,
		SessionID:      r.SessionID,
		ThreadOwner:    r.ThreadOwner != 0,
		HomeChannelID:  r.HomeChannelID,
		Active:         r.Active != 0,
		SeatedAtMs:     r.SeatedAtMs,
	}
}

func toInboxItemView(id, kind, title, summary, sessionID, issueID string, resolved, createdAtMs int64) contract.InboxItemView {
	return contract.InboxItemView{
		ID:          id,
		Kind:        contract.InboxItemKind(kind),
		Title:       title,
		Summary:     summary,
		SessionID:   sessionID,
		IssueID:     issueID,
		Resolved:    resolved != 0,
		CreatedAtMs: createdAtMs,
	}
}
