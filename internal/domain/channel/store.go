package channel

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"slices"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

// Store manages channels, append-only social events, memberships, and per-actor read cursors.
// It is strictly decoupled from durable_entry execution traces.
type Store struct {
	backend backend
	clock   Clock

	closed    atomic.Bool
	closeOnce sync.Once
	closeErr  error

	obsMu   sync.RWMutex
	obsNext atomic.Uint64
	obs     map[uint64]EventObserver
}

// NewMemoryStore creates an in-memory channel Store.
func NewMemoryStore(opts ...Option) *Store {
	return newStore(newMemoryBackend(), opts...)
}

// OpenSQLite opens (or creates) a SQLite WAL-backed channel Store at path.
func OpenSQLite(ctx context.Context, path string, opts ...Option) (*Store, error) {
	b, err := openSQLiteBackend(ctx, path)
	if err != nil {
		return nil, err
	}
	return newStore(b, opts...), nil
}

// OpenDB attaches a channel Store to an existing *sql.DB (creating tables if missing).
func OpenDB(ctx context.Context, db *sql.DB, opts ...Option) (*Store, error) {
	b, err := openSQLiteFromDB(ctx, db, false)
	if err != nil {
		return nil, err
	}
	return newStore(b, opts...), nil
}

func newStore(b backend, opts ...Option) *Store {
	cfg := storeConfig{clock: RealClock{}}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}
	return &Store{
		backend: b,
		clock:   cfg.clock,
		obs:     make(map[uint64]EventObserver),
	}
}

// Clock returns the Store's configured Clock.
func (s *Store) Clock() Clock { return s.clock }

// Close closes the underlying storage backend.
func (s *Store) Close() error {
	s.closeOnce.Do(func() {
		s.closed.Store(true)
		s.closeErr = s.backend.close()
	})
	return s.closeErr
}

// Subscribe registers an observer invoked after an event commits to storage.
func (s *Store) Subscribe(fn EventObserver) func() {
	if fn == nil {
		return func() {}
	}
	id := s.obsNext.Add(1)
	s.obsMu.Lock()
	s.obs[id] = fn
	s.obsMu.Unlock()
	return func() {
		s.obsMu.Lock()
		delete(s.obs, id)
		s.obsMu.Unlock()
	}
}

func (s *Store) notify(ev Event) {
	s.obsMu.RLock()
	if len(s.obs) == 0 {
		s.obsMu.RUnlock()
		return
	}
	list := make([]EventObserver, 0, len(s.obs))
	for _, fn := range s.obs {
		list = append(list, fn)
	}
	s.obsMu.RUnlock()

	for _, fn := range list {
		fn(cloneEvent(ev))
	}
}

// CreateChannel creates a new channel or rejects duplicates.
func (s *Store) CreateChannel(ctx context.Context, ch Channel) (Channel, error) {
	if s.closed.Load() {
		return Channel{}, ErrStoreClosed
	}
	norm, err := s.prepareChannel(ch)
	if err != nil {
		return Channel{}, err
	}
	if err := s.backend.createChannel(ctx, norm); err != nil {
		return Channel{}, err
	}
	return norm, nil
}

// EnsureChannel creates ch if missing or returns the existing channel.
func (s *Store) EnsureChannel(ctx context.Context, ch Channel) (Channel, bool, error) {
	if s.closed.Load() {
		return Channel{}, false, ErrStoreClosed
	}
	norm, err := s.prepareChannel(ch)
	if err != nil {
		return Channel{}, false, err
	}
	return s.backend.ensureChannel(ctx, norm)
}

func (s *Store) prepareChannel(ch Channel) (Channel, error) {
	if strings.TrimSpace(ch.ID) == "" {
		ch.ID = newUUIDv7(s.clock.NowMs())
	}
	if ch.Type == "" {
		ch.Type = TypePublic
	}
	switch ch.Type {
	case TypePublic, TypeDirect, TypeThread:
	default:
		return Channel{}, fmtInvalid("unknown channel type %q", ch.Type)
	}
	if ch.NotifyMode == "" {
		ch.NotifyMode = "all"
	}
	now := s.clock.NowMs()
	if ch.CreatedAtMs == 0 {
		ch.CreatedAtMs = now
	}
	if ch.UpdatedAtMs == 0 {
		ch.UpdatedAtMs = ch.CreatedAtMs
	}
	return ch, nil
}

// OpenThreadForIssue returns the existing thread channel bound to issueID, or creates one atomically.
func (s *Store) OpenThreadForIssue(ctx context.Context, issueID, parentChannelID, title, repoID string) (Channel, bool, error) {
	if s.closed.Load() {
		return Channel{}, false, ErrStoreClosed
	}
	if strings.TrimSpace(issueID) == "" {
		return Channel{}, false, fmtInvalid("issueId is required")
	}
	if existing, ok, err := s.backend.getThreadByIssue(ctx, issueID); err != nil {
		return Channel{}, false, err
	} else if ok {
		return existing, false, nil
	}
	ch := Channel{
		ID:              "thread:" + issueID,
		Type:            TypeThread,
		Name:            title,
		RepoID:          repoID,
		ParentChannelID: parentChannelID,
		IssueID:         issueID,
	}
	return s.EnsureChannel(ctx, ch)
}

// GetChannel retrieves a channel by ID.
func (s *Store) GetChannel(ctx context.Context, id string) (Channel, error) {
	if s.closed.Load() {
		return Channel{}, ErrStoreClosed
	}
	ch, ok, err := s.backend.getChannel(ctx, id)
	if err != nil {
		return Channel{}, err
	}
	if !ok {
		return Channel{}, fmt.Errorf("%w: channel %q", ErrNotFound, id)
	}
	return ch, nil
}

// ListChannels lists all channels sorted deterministically by creation time and ID.
func (s *Store) ListChannels(ctx context.Context) ([]Channel, error) {
	if s.closed.Load() {
		return nil, ErrStoreClosed
	}
	return s.backend.listChannels(ctx)
}

// AddMember adds a participant ID to a channel or thread membership list.
func (s *Store) AddMember(ctx context.Context, channelID, memberID string) error {
	if s.closed.Load() {
		return ErrStoreClosed
	}
	if strings.TrimSpace(channelID) == "" || strings.TrimSpace(memberID) == "" {
		return fmtInvalid("channelId and memberId are required")
	}
	return s.backend.addMember(ctx, channelID, memberID, s.clock.NowMs())
}

// RemoveMember removes a participant ID from a channel membership list.
func (s *Store) RemoveMember(ctx context.Context, channelID, memberID string) error {
	if s.closed.Load() {
		return ErrStoreClosed
	}
	return s.backend.removeMember(ctx, channelID, memberID)
}

// ListMembers returns sorted member IDs of channelID.
func (s *Store) ListMembers(ctx context.Context, channelID string) ([]string, error) {
	if s.closed.Load() {
		return nil, ErrStoreClosed
	}
	return s.backend.listMembers(ctx, channelID)
}

// Append validates and commits an immutable social event to channel_event.
func (s *Store) Append(ctx context.Context, req AppendRequest) (AppendResult, error) {
	if s.closed.Load() {
		return AppendResult{}, ErrStoreClosed
	}
	if req.ActorKind == "" {
		req.ActorKind = ActorUser
	}
	if err := validateAppendRequest(req); err != nil {
		return AppendResult{}, err
	}
	req.Mentions = normalizeMentions(req.Mentions)
	if req.Kind == contract.ChannelEventQuestion && req.Text == "" && req.Question != nil {
		req.Text = req.Question.Prompt
	}
	if req.Kind == contract.ChannelEventReport && req.Text == "" && req.Report != nil {
		req.Text = req.Report.Summary
	}
	if req.Kind == contract.ChannelEventReaction && req.Text == "" && req.Reaction != nil {
		req.Text = req.Reaction.Emoji
	}

	res, err := s.backend.appendEvent(ctx, req, s.clock.NowMs())
	if err != nil {
		return AppendResult{}, err
	}
	if !res.Deduplicated {
		s.notify(res.Event)
	}
	return res, nil
}

// PostMessage is a convenience wrapper for appending a ChannelEventMessage.
func (s *Store) PostMessage(ctx context.Context, channelID, authorID string, kind ActorKind, text string, mentions ...string) (AppendResult, error) {
	return s.Append(ctx, AppendRequest{
		ChannelID: channelID,
		Kind:      contract.ChannelEventMessage,
		AuthorID:  authorID,
		ActorKind: kind,
		Text:      text,
		Mentions:  slices.Clone(mentions),
	})
}

// PostQuestion appends a structured ChannelEventQuestion card.
func (s *Store) PostQuestion(ctx context.Context, channelID, authorID, sessionID string, card QuestionCard, mentions ...string) (AppendResult, error) {
	return s.Append(ctx, AppendRequest{
		ChannelID: channelID,
		Kind:      contract.ChannelEventQuestion,
		AuthorID:  authorID,
		ActorKind: ActorAgent,
		Text:      card.Prompt,
		SessionID: sessionID,
		Mentions:  slices.Clone(mentions),
		Question:  &card,
	})
}

// PostReport appends a final ChannelEventReport summary referencing sessionID without internal traces.
func (s *Store) PostReport(ctx context.Context, channelID, authorID, sessionID string, summary ReportSummary) (AppendResult, error) {
	return s.Append(ctx, AppendRequest{
		ChannelID: channelID,
		Kind:      contract.ChannelEventReport,
		AuthorID:  authorID,
		ActorKind: ActorAgent,
		Text:      summary.Summary,
		SessionID: sessionID,
		IssueID:   summary.IssueID,
		Report:    &summary,
	})
}

// AddReaction appends a ChannelEventReaction targeting targetSeq in channelID.
func (s *Store) AddReaction(ctx context.Context, channelID, authorID string, actorKind ActorKind, targetSeq int64, emoji string) (AppendResult, error) {
	return s.Append(ctx, AppendRequest{
		ChannelID: channelID,
		Kind:      contract.ChannelEventReaction,
		AuthorID:  authorID,
		ActorKind: actorKind,
		Text:      emoji,
		Reaction: &ReactionMeta{
			TargetSeq: targetSeq,
			Emoji:     emoji,
		},
	})
}

// GetEvent reads a single committed social event by (channelID, seq).
func (s *Store) GetEvent(ctx context.Context, channelID string, seq int64) (Event, error) {
	if s.closed.Load() {
		return Event{}, ErrStoreClosed
	}
	ev, ok, err := s.backend.getEvent(ctx, channelID, seq)
	if err != nil {
		return Event{}, err
	}
	if !ok {
		return Event{}, fmt.Errorf("%w: event (%s,%d)", ErrNotFound, channelID, seq)
	}
	return ev, nil
}

// ListEvents returns events in channelID with seq > afterSeq in ascending order.
func (s *Store) ListEvents(ctx context.Context, channelID string, afterSeq int64, limit int) ([]Event, error) {
	if s.closed.Load() {
		return nil, ErrStoreClosed
	}
	return s.backend.listEvents(ctx, channelID, afterSeq, limit)
}

// ListEventViews returns public contract.ChannelEventView items in channelID with seq > afterSeq.
func (s *Store) ListEventViews(ctx context.Context, channelID string, afterSeq int64, limit int) ([]contract.ChannelEventView, error) {
	events, err := s.ListEvents(ctx, channelID, afterSeq, limit)
	if err != nil {
		return nil, err
	}
	views := make([]contract.ChannelEventView, len(events))
	for i, ev := range events {
		views[i] = ev.View()
	}
	return views, nil
}

// EventsAfterGlobal returns committed events across all channels with globalSeq > afterGlobalSeq.
func (s *Store) EventsAfterGlobal(ctx context.Context, afterGlobalSeq int64, limit int) ([]Event, error) {
	if s.closed.Load() {
		return nil, ErrStoreClosed
	}
	return s.backend.eventsAfterGlobal(ctx, afterGlobalSeq, limit)
}

// AdvanceReadCursor monotonically advances actorID's read cursor in channelID up to seq.
func (s *Store) AdvanceReadCursor(ctx context.Context, channelID, actorID string, seq int64) (ReadCursor, error) {
	if s.closed.Load() {
		return ReadCursor{}, ErrStoreClosed
	}
	if strings.TrimSpace(channelID) == "" || strings.TrimSpace(actorID) == "" || seq < 0 {
		return ReadCursor{}, fmtInvalid("channelId, actorId, and seq >= 0 are required")
	}
	return s.backend.advanceReadCursor(ctx, channelID, actorID, seq, s.clock.NowMs())
}

// GetReadCursor returns actorID's current read cursor in channelID.
func (s *Store) GetReadCursor(ctx context.Context, channelID, actorID string) (ReadCursor, error) {
	if s.closed.Load() {
		return ReadCursor{}, ErrStoreClosed
	}
	rc, ok, err := s.backend.getReadCursor(ctx, channelID, actorID)
	if err != nil {
		return ReadCursor{}, err
	}
	if !ok {
		return ReadCursor{ChannelID: channelID, ActorID: actorID, ReadSeq: 0}, nil
	}
	return rc, nil
}

// ListReadCursors returns all actor read cursors for channelID sorted by actorID.
func (s *Store) ListReadCursors(ctx context.Context, channelID string) ([]ReadCursor, error) {
	if s.closed.Load() {
		return nil, ErrStoreClosed
	}
	return s.backend.listReadCursors(ctx, channelID)
}

// UnreadCount returns the count of non-reaction events in channelID after actorID's read cursor.
func (s *Store) UnreadCount(ctx context.Context, channelID, actorID string) (int64, error) {
	if s.closed.Load() {
		return 0, ErrStoreClosed
	}
	return s.backend.unreadCount(ctx, channelID, actorID)
}

var fallbackIDSeq atomic.Uint64

func newUUIDv7(timestampMs int64) string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		n := fallbackIDSeq.Add(1)
		b[6] = byte(n >> 8)
		b[7] = byte(n)
	}
	ms := uint64(timestampMs)
	b[0] = byte(ms >> 40)
	b[1] = byte(ms >> 32)
	b[2] = byte(ms >> 24)
	b[3] = byte(ms >> 16)
	b[4] = byte(ms >> 8)
	b[5] = byte(ms)
	b[6] = (b[6] & 0x0f) | 0x70
	b[8] = (b[8] & 0x3f) | 0x80
	var dst [36]byte
	hex.Encode(dst[0:8], b[0:4])
	dst[8] = '-'
	hex.Encode(dst[9:13], b[4:6])
	dst[13] = '-'
	hex.Encode(dst[14:18], b[6:8])
	dst[18] = '-'
	hex.Encode(dst[19:23], b[8:10])
	dst[23] = '-'
	hex.Encode(dst[24:36], b[10:16])
	return string(dst[:])
}
