package watch

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/vibevalleyhq/vibevalley/internal/domain/channel"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

// Service implements VibeValley's business attention watch over a channel.Store:
// cursor-based channel event reading, three wakeup brakes, seat scheduling,
// owner Inbox creation, and crash-safe idempotent dispatch.
type Service struct {
	channels *channel.Store
	backend  watchBackend
	clock    channel.Clock
	cfg      serviceConfig

	mu sync.Mutex // serializes event processing, cursor advances, and brake state updates

	loopMu   sync.Mutex
	running  bool
	stopCh   chan struct{}
	notifyCh chan struct{}
	unsub    func()
	wg       sync.WaitGroup

	closed    atomic.Bool
	closeOnce sync.Once
	closeErr  error
}

// NewMemoryService creates an in-memory attention watch Service over channels.
func NewMemoryService(channels *channel.Store, opts ...Option) *Service {
	return newService(channels, newMemoryWatchBackend(), opts...)
}

// OpenSQLiteService creates or reopens a SQLite WAL attention watch Service at path.
func OpenSQLiteService(ctx context.Context, channels *channel.Store, path string, opts ...Option) (*Service, error) {
	b, err := openSQLiteWatchBackend(ctx, path)
	if err != nil {
		return nil, err
	}
	return newService(channels, b, opts...), nil
}

// OpenSQLiteServiceFromDB attaches an attention watch Service to an already-migrated *sql.DB
// without running migrations or closing sqlDB on Close.
func OpenSQLiteServiceFromDB(ctx context.Context, channels *channel.Store, sqlDB *sql.DB, opts ...Option) (*Service, error) {
	b, err := openSQLiteWatchFromDB(ctx, sqlDB)
	if err != nil {
		return nil, err
	}
	return newService(channels, b, opts...), nil
}

func newService(channels *channel.Store, b watchBackend, opts ...Option) *Service {
	cfg := serviceConfig{
		clock:  channel.RealClock{},
		brakes: DefaultBrakeConfig(),
	}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}
	cfg.brakes = cfg.brakes.withDefaults()
	return &Service{
		channels: channels,
		backend:  b,
		clock:    cfg.clock,
		cfg:      cfg,
	}
}

// Close stops any active watcher loop and closes the underlying watch backend.
func (s *Service) Close() error {
	s.Stop()
	s.closeOnce.Do(func() {
		s.closed.Store(true)
		s.closeErr = s.backend.close()
	})
	return s.closeErr
}

// Cursor returns the persisted global channel_event cursor.
func (s *Service) Cursor(ctx context.Context) (int64, error) {
	if s.closed.Load() {
		return 0, ErrStoreClosed
	}
	return s.backend.getCursor(ctx)
}

// SeatAgent assigns or updates an agent seat in a channel or thread.
func (s *Service) SeatAgent(ctx context.Context, seat Seat) error {
	if s.closed.Load() {
		return ErrStoreClosed
	}
	if strings.TrimSpace(seat.ChannelID) == "" || strings.TrimSpace(seat.AgentID) == "" {
		return fmt.Errorf("%w: channelId and agentId required", ErrInvalidArgument)
	}
	if seat.ConversationID == "" {
		seat.ConversationID = seat.AgentID
	}
	if seat.SeatedAtMs == 0 {
		seat.SeatedAtMs = s.clock.NowMs()
	}
	if !seat.Active {
		seat.Active = true
	}
	return s.backend.upsertSeat(ctx, seat, s.cfg.maxConcurrentSeatsPerChan, s.cfg.maxActiveSeats)
}

// VacateSeat marks a seat inactive and clears wake-breaker state for that agent if no longer seated elsewhere.
func (s *Service) VacateSeat(ctx context.Context, channelID, agentID string) error {
	if s.closed.Load() {
		return ErrStoreClosed
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.backend.vacateSeat(ctx, channelID, agentID); err != nil {
		return err
	}
	st, err := s.backend.loadBrakes(ctx)
	if err != nil {
		return err
	}
	delete(st.EmptyWakes, agentID)
	delete(st.BrokenAgents, agentID)
	delete(st.LastAgentWakeAtMs, agentID)
	return s.backend.saveBrakes(ctx, st)
}

// GetSeat returns the seat for (channelID, agentID).
func (s *Service) GetSeat(ctx context.Context, channelID, agentID string) (Seat, error) {
	if s.closed.Load() {
		return Seat{}, ErrStoreClosed
	}
	seat, ok, err := s.backend.getSeat(ctx, channelID, agentID)
	if err != nil {
		return Seat{}, err
	}
	if !ok {
		return Seat{}, fmt.Errorf("%w: seat (%s,%s)", ErrNotFound, channelID, agentID)
	}
	return seat, nil
}

// ListSeats returns active seats in channelID (or all active seats when channelID == "").
func (s *Service) ListSeats(ctx context.Context, channelID string) ([]Seat, error) {
	if s.closed.Load() {
		return nil, ErrStoreClosed
	}
	return s.backend.listSeats(ctx, channelID)
}

// HomeOf returns the agent's home channel/thread ID.
func (s *Service) HomeOf(ctx context.Context, agentID string) (string, error) {
	if s.closed.Load() {
		return "", ErrStoreClosed
	}
	ch, ok, err := s.backend.homeOf(ctx, agentID)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fmt.Errorf("%w: home for %q", ErrNotFound, agentID)
	}
	return ch, nil
}

// RecordEmptyWake increments empty-wake counter for agentID and trips the wake breaker at WakeBreakerLimit.
func (s *Service) RecordEmptyWake(ctx context.Context, agentID string) (count int, tripped bool, err error) {
	if s.closed.Load() {
		return 0, false, ErrStoreClosed
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.backend.loadBrakes(ctx)
	if err != nil {
		return 0, false, err
	}
	st.EmptyWakes[agentID]++
	count = st.EmptyWakes[agentID]
	if count >= s.cfg.brakes.withDefaults().WakeBreakerLimit && !st.BrokenAgents[agentID] {
		st.BrokenAgents[agentID] = true
		tripped = true
	}
	if err := s.backend.saveBrakes(ctx, st); err != nil {
		return 0, false, err
	}
	return count, tripped, nil
}

// RecordSpoke clears empty-wake failures when agentID produces output.
func (s *Service) RecordSpoke(ctx context.Context, agentID string) error {
	if s.closed.Load() {
		return ErrStoreClosed
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.backend.loadBrakes(ctx)
	if err != nil {
		return err
	}
	delete(st.EmptyWakes, agentID)
	delete(st.BrokenAgents, agentID)
	return s.backend.saveBrakes(ctx, st)
}

// BrakeStateSnapshot returns a copy of the current brake counters.
func (s *Service) BrakeStateSnapshot(ctx context.Context) (BrakeState, error) {
	if s.closed.Load() {
		return BrakeState{}, ErrStoreClosed
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.backend.loadBrakes(ctx)
}

// UpsertInboxItem persists an external owner Inbox item (e.g. approval, budget_reached, dream_proposal, mount_conflict).
func (s *Service) UpsertInboxItem(ctx context.Context, item contract.InboxItemView) error {
	if s.closed.Load() {
		return ErrStoreClosed
	}
	if strings.TrimSpace(item.ID) == "" {
		return fmt.Errorf("%w: inbox item id required", ErrInvalidArgument)
	}
	if item.CreatedAtMs == 0 {
		item.CreatedAtMs = s.clock.NowMs()
	}
	return s.backend.upsertInbox(ctx, item)
}

// ResolveInboxItem marks an inbox item resolved.
func (s *Service) ResolveInboxItem(ctx context.Context, id string) (bool, error) {
	if s.closed.Load() {
		return false, ErrStoreClosed
	}
	return s.backend.resolveInbox(ctx, id)
}

// SyncReadCursor resolves channel mention/question inbox items up to readSeq.
func (s *Service) SyncReadCursor(ctx context.Context, channelID string, readSeq int64) error {
	if s.closed.Load() {
		return ErrStoreClosed
	}
	return s.backend.resolveChannelInboxUpTo(ctx, channelID, readSeq)
}

// ListInboxItems lists active (or all, when includeResolved is true) owner Inbox items.
func (s *Service) ListInboxItems(ctx context.Context, includeResolved bool) ([]contract.InboxItemView, error) {
	if s.closed.Load() {
		return nil, ErrStoreClosed
	}
	return s.backend.listInbox(ctx, includeResolved)
}

// Pump drains all committed channel_event entries strictly after the persisted watch_cursor,
// evaluates the three wakeup brakes, creates owner Inbox items, dispatches allowed wakes
// idempotently with requestId = "chan_evt:<channelId>:<seq>", and advances watch_cursor.
func (s *Service) Pump(ctx context.Context) ([]EventOutcome, error) {
	if s.closed.Load() {
		return nil, ErrStoreClosed
	}
	if s.channels == nil {
		return nil, fmt.Errorf("%w: channel store required", ErrInvalidArgument)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	cursor, err := s.backend.getCursor(ctx)
	if err != nil {
		return nil, err
	}

	events, err := s.channels.EventsAfterGlobal(ctx, cursor, 0)
	if err != nil {
		return nil, err
	}
	var outcomes []EventOutcome
	for _, ev := range events {
		out, err := s.processEventLocked(ctx, ev)
		if err != nil {
			return outcomes, err
		}
		outcomes = append(outcomes, out)
	}
	return outcomes, nil
}

func (s *Service) processEventLocked(ctx context.Context, ev channel.Event) (EventOutcome, error) {
	ch, err := s.channels.GetChannel(ctx, ev.ChannelID)
	if err != nil {
		return EventOutcome{}, err
	}
	members, err := s.channels.ListMembers(ctx, ev.ChannelID)
	if err != nil {
		return EventOutcome{}, err
	}
	seats, err := s.backend.listSeats(ctx, ev.ChannelID)
	if err != nil {
		return EventOutcome{}, err
	}
	brakeState, err := s.backend.loadBrakes(ctx)
	if err != nil {
		return EventOutcome{}, err
	}

	nowMs := s.clock.NowMs()
	eval := EvaluateBrakes(BrakeInput{
		Event:          ev,
		Channel:        ch,
		ChannelMembers: members,
		Seats:          seats,
		NowMs:          nowMs,
		Config:         s.cfg.brakes,
		State:          brakeState,
	})

	var inboxCreated []contract.InboxItemView
	if ev.ActorKind == channel.ActorUser {
		if err := s.backend.resolveChannelInboxUpTo(ctx, ev.ChannelID, ev.Seq); err != nil {
			return EventOutcome{}, err
		}
	} else if s.shouldCreateOwnerInbox(ev) {
		chLabel := ch.Name
		if chLabel == "" {
			chLabel = ch.ID
		}
		title := fmt.Sprintf("Mention from %s in #%s", ev.AuthorID, chLabel)
		if ev.Kind == contract.ChannelEventQuestion {
			title = fmt.Sprintf("Question from %s in #%s", ev.AuthorID, chLabel)
		}
		item := contract.InboxItemView{
			ID:          "inbox:" + RequestIDForEvent(ev.ChannelID, ev.Seq),
			Kind:        contract.InboxMention,
			Title:       title,
			Summary:     ev.Text,
			SessionID:   ev.SessionID,
			IssueID:     ev.IssueID,
			Resolved:    false,
			CreatedAtMs: ev.CreatedAtMs,
		}
		if err := s.backend.upsertInboxWithChannel(ctx, item, ev.ChannelID, ev.Seq); err != nil {
			return EventOutcome{}, err
		}
		inboxCreated = append(inboxCreated, item)
	}

	var dispatched []DispatchResult
	for _, dec := range eval.Decisions {
		if !dec.Allowed || s.cfg.dispatcher == nil {
			continue
		}
		convID := dec.ConversationID
		if convID == "" {
			convID = dec.RecipientID
		}
		res, err := s.cfg.dispatcher.Dispatch(ctx, DispatchRequest{
			ConversationID: convID,
			RequestID:      dec.RequestID,
			ChannelID:      ev.ChannelID,
			EventSeq:       ev.Seq,
			RecipientID:    dec.RecipientID,
			SessionID:      dec.SessionID,
			IssueID:        ev.IssueID,
			AuthorID:       ev.AuthorID,
			Text:           ev.Text,
			CreatedAtMs:    ev.CreatedAtMs,
		})
		if err != nil {
			return EventOutcome{}, err
		}
		dispatched = append(dispatched, res)
	}

	if s.cfg.beforeCursorAdvanceFailure != nil {
		if err := s.cfg.beforeCursorAdvanceFailure(ev); err != nil {
			return EventOutcome{}, err
		}
	}

	if err := s.backend.saveBrakes(ctx, eval.NextState); err != nil {
		return EventOutcome{}, err
	}
	if err := s.backend.setCursor(ctx, ev.GlobalSeq, nowMs); err != nil {
		return EventOutcome{}, err
	}

	return EventOutcome{
		GlobalSeq:    ev.GlobalSeq,
		ChannelID:    ev.ChannelID,
		Seq:          ev.Seq,
		Decisions:    eval.Decisions,
		Dispatched:   dispatched,
		InboxCreated: inboxCreated,
	}, nil
}

func (s *Service) shouldCreateOwnerInbox(ev channel.Event) bool {
	if ev.Kind == contract.ChannelEventReaction {
		return false
	}
	if ev.Kind == contract.ChannelEventQuestion {
		return true
	}
	ownerIDs := s.cfg.brakes.withDefaults().OwnerActorIDs
	for _, m := range ev.Mentions {
		if m == "everyone" || m == "all" || containsFold(ownerIDs, m) {
			return true
		}
	}
	return false
}

// Start runs a reactive catchup & subscriber loop that wakes on new committed channel events
// until Stop or ctx cancellation.
func (s *Service) Start(ctx context.Context) error {
	if s.closed.Load() {
		return ErrStoreClosed
	}
	s.loopMu.Lock()
	if s.running {
		s.loopMu.Unlock()
		return nil
	}
	s.running = true
	s.stopCh = make(chan struct{})
	s.notifyCh = make(chan struct{}, 1)
	s.unsub = s.channels.Subscribe(func(_ channel.Event) {
		select {
		case s.notifyCh <- struct{}{}:
		default:
		}
	})
	stopCh := s.stopCh
	notifyCh := s.notifyCh
	s.wg.Add(1)
	s.loopMu.Unlock()

	go func() {
		defer s.wg.Done()
		_, _ = s.Pump(ctx)
		for {
			select {
			case <-ctx.Done():
				return
			case <-stopCh:
				return
			case <-notifyCh:
				_, _ = s.Pump(ctx)
			}
		}
	}()
	return nil
}

// Stop stops the reactive watcher loop and waits for its goroutine to exit.
func (s *Service) Stop() {
	s.loopMu.Lock()
	if !s.running {
		s.loopMu.Unlock()
		return
	}
	s.running = false
	if s.unsub != nil {
		s.unsub()
		s.unsub = nil
	}
	close(s.stopCh)
	s.loopMu.Unlock()
	s.wg.Wait()
}
