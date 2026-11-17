package channel

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"sync"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

type sendKeyID struct {
	channelID string
	authorID  string
	sendKey   string
}

type cursorKey struct {
	channelID string
	actorID   string
}

type memoryBackend struct {
	mu           sync.RWMutex
	channels     map[string]Channel
	members      map[string]map[string]bool
	events       []Event
	byChan       map[string][]Event
	sendKeys     map[sendKeyID]Event
	cursors      map[cursorKey]ReadCursor
	globalSeq    int64
	channelSeqs  map[string]int64
	issueThreads map[string]string
}

func newMemoryBackend() *memoryBackend {
	return &memoryBackend{
		channels:     make(map[string]Channel),
		members:      make(map[string]map[string]bool),
		byChan:       make(map[string][]Event),
		sendKeys:     make(map[sendKeyID]Event),
		cursors:      make(map[cursorKey]ReadCursor),
		channelSeqs:  make(map[string]int64),
		issueThreads: make(map[string]string),
	}
}

func (m *memoryBackend) createChannel(_ context.Context, ch Channel) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.channels[ch.ID]; exists {
		return fmt.Errorf("%w: %q", ErrDuplicateChannel, ch.ID)
	}
	if ch.Type == TypeThread && ch.IssueID != "" {
		if existingID, ok := m.issueThreads[ch.IssueID]; ok && existingID != ch.ID {
			return fmt.Errorf("%w: thread for issue %q already exists (%s)", ErrDuplicateChannel, ch.IssueID, existingID)
		}
		m.issueThreads[ch.IssueID] = ch.ID
	}
	m.channels[ch.ID] = cloneChannel(ch)
	return nil
}

func (m *memoryBackend) ensureChannel(_ context.Context, ch Channel) (Channel, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if existing, ok := m.channels[ch.ID]; ok {
		return cloneChannel(existing), false, nil
	}
	if ch.Type == TypeThread && ch.IssueID != "" {
		if existingID, ok := m.issueThreads[ch.IssueID]; ok {
			if existing, exists := m.channels[existingID]; exists {
				return cloneChannel(existing), false, nil
			}
		}
		m.issueThreads[ch.IssueID] = ch.ID
	}
	m.channels[ch.ID] = cloneChannel(ch)
	return cloneChannel(ch), true, nil
}

func (m *memoryBackend) getChannel(_ context.Context, id string) (Channel, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	ch, ok := m.channels[id]
	return cloneChannel(ch), ok, nil
}

func (m *memoryBackend) getThreadByIssue(_ context.Context, issueID string) (Channel, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	id, ok := m.issueThreads[issueID]
	if !ok {
		return Channel{}, false, nil
	}
	ch, exists := m.channels[id]
	return cloneChannel(ch), exists, nil
}

func (m *memoryBackend) listChannels(_ context.Context) ([]Channel, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Channel, 0, len(m.channels))
	for _, ch := range m.channels {
		out = append(out, cloneChannel(ch))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAtMs != out[j].CreatedAtMs {
			return out[i].CreatedAtMs < out[j].CreatedAtMs
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func (m *memoryBackend) addMember(_ context.Context, channelID, memberID string, _ int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.channels[channelID]; !ok {
		return fmt.Errorf("%w: channel %q", ErrNotFound, channelID)
	}
	set := m.members[channelID]
	if set == nil {
		set = make(map[string]bool)
		m.members[channelID] = set
	}
	set[memberID] = true
	return nil
}

func (m *memoryBackend) removeMember(_ context.Context, channelID, memberID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if set := m.members[channelID]; set != nil {
		delete(set, memberID)
	}
	return nil
}

func (m *memoryBackend) listMembers(_ context.Context, channelID string) ([]string, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if _, ok := m.channels[channelID]; !ok {
		return nil, fmt.Errorf("%w: channel %q", ErrNotFound, channelID)
	}
	set := m.members[channelID]
	out := make([]string, 0, len(set))
	for id := range set {
		out = append(out, id)
	}
	slices.Sort(out)
	return out, nil
}

func (m *memoryBackend) appendEvent(_ context.Context, req AppendRequest, nowMs int64) (AppendResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	ch, ok := m.channels[req.ChannelID]
	if !ok {
		return AppendResult{}, fmt.Errorf("%w: channel %q", ErrNotFound, req.ChannelID)
	}
	if req.SendKey != "" {
		sk := sendKeyID{channelID: req.ChannelID, authorID: req.AuthorID, sendKey: req.SendKey}
		if existing, dup := m.sendKeys[sk]; dup {
			return AppendResult{Event: cloneEvent(existing), Deduplicated: true}, nil
		}
	}

	curSeq := m.channelSeqs[req.ChannelID]
	if req.Kind == contract.ChannelEventReaction && req.Reaction != nil {
		if req.Reaction.TargetSeq > curSeq {
			return AppendResult{}, fmt.Errorf("%w: targetSeq %d not found in channel %q", ErrNotFound, req.Reaction.TargetSeq, req.ChannelID)
		}
	}

	m.globalSeq++
	curSeq++
	m.channelSeqs[req.ChannelID] = curSeq

	ev := Event{
		GlobalSeq:     m.globalSeq,
		ChannelID:     req.ChannelID,
		Seq:           curSeq,
		Kind:          req.Kind,
		AuthorID:      req.AuthorID,
		ActorKind:     req.ActorKind,
		ActorRole:     req.ActorRole,
		Text:          req.Text,
		SessionID:     req.SessionID,
		IssueID:       req.IssueID,
		Mentions:      slices.Clone(req.Mentions),
		TargetAgentID: req.TargetAgentID,
		SendKey:       req.SendKey,
		CreatedAtMs:   nowMs,
	}
	if req.Question != nil {
		q := *req.Question
		q.Options = slices.Clone(q.Options)
		ev.Question = &q
	}
	if req.Report != nil {
		r := *req.Report
		ev.Report = &r
	}
	if req.Reaction != nil {
		rc := *req.Reaction
		ev.Reaction = &rc
	}

	stored := cloneEvent(ev)
	m.events = append(m.events, stored)
	m.byChan[req.ChannelID] = append(m.byChan[req.ChannelID], stored)
	if req.SendKey != "" {
		m.sendKeys[sendKeyID{channelID: req.ChannelID, authorID: req.AuthorID, sendKey: req.SendKey}] = stored
	}

	ch.UpdatedAtMs = nowMs
	m.channels[req.ChannelID] = ch

	// Author has implicitly read up to their own committed event.
	ck := cursorKey{channelID: req.ChannelID, actorID: req.AuthorID}
	if cur, exists := m.cursors[ck]; !exists || cur.ReadSeq < curSeq {
		m.cursors[ck] = ReadCursor{
			ChannelID:   req.ChannelID,
			ActorID:     req.AuthorID,
			ReadSeq:     curSeq,
			UpdatedAtMs: nowMs,
		}
	}

	return AppendResult{Event: cloneEvent(stored), Deduplicated: false}, nil
}

func (m *memoryBackend) getEvent(_ context.Context, channelID string, seq int64) (Event, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	list := m.byChan[channelID]
	for _, ev := range list {
		if ev.Seq == seq {
			return cloneEvent(ev), true, nil
		}
	}
	return Event{}, false, nil
}

func (m *memoryBackend) listEvents(_ context.Context, channelID string, afterSeq int64, limit int) ([]Event, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if _, ok := m.channels[channelID]; !ok {
		return nil, fmt.Errorf("%w: channel %q", ErrNotFound, channelID)
	}
	list := m.byChan[channelID]
	out := make([]Event, 0, len(list))
	for _, ev := range list {
		if ev.Seq > afterSeq {
			out = append(out, cloneEvent(ev))
			if limit > 0 && len(out) >= limit {
				break
			}
		}
	}
	return out, nil
}

func (m *memoryBackend) eventsAfterGlobal(_ context.Context, afterGlobalSeq int64, limit int) ([]Event, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Event, 0)
	for _, ev := range m.events {
		if ev.GlobalSeq > afterGlobalSeq {
			out = append(out, cloneEvent(ev))
			if limit > 0 && len(out) >= limit {
				break
			}
		}
	}
	return out, nil
}

func (m *memoryBackend) advanceReadCursor(_ context.Context, channelID, actorID string, seq, nowMs int64) (ReadCursor, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.channels[channelID]; !ok {
		return ReadCursor{}, fmt.Errorf("%w: channel %q", ErrNotFound, channelID)
	}
	ck := cursorKey{channelID: channelID, actorID: actorID}
	cur, exists := m.cursors[ck]
	if !exists || seq > cur.ReadSeq {
		cur = ReadCursor{
			ChannelID:   channelID,
			ActorID:     actorID,
			ReadSeq:     seq,
			UpdatedAtMs: nowMs,
		}
		m.cursors[ck] = cur
	}
	return cur, nil
}

func (m *memoryBackend) getReadCursor(_ context.Context, channelID, actorID string) (ReadCursor, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if _, ok := m.channels[channelID]; !ok {
		return ReadCursor{}, false, fmt.Errorf("%w: channel %q", ErrNotFound, channelID)
	}
	cur, ok := m.cursors[cursorKey{channelID: channelID, actorID: actorID}]
	return cur, ok, nil
}

func (m *memoryBackend) listReadCursors(_ context.Context, channelID string) ([]ReadCursor, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if _, ok := m.channels[channelID]; !ok {
		return nil, fmt.Errorf("%w: channel %q", ErrNotFound, channelID)
	}
	var out []ReadCursor
	for k, v := range m.cursors {
		if k.channelID == channelID {
			out = append(out, v)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].ActorID < out[j].ActorID
	})
	return out, nil
}

func (m *memoryBackend) unreadCount(_ context.Context, channelID, actorID string) (int64, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if _, ok := m.channels[channelID]; !ok {
		return 0, fmt.Errorf("%w: channel %q", ErrNotFound, channelID)
	}
	readSeq := m.cursors[cursorKey{channelID: channelID, actorID: actorID}].ReadSeq
	var count int64
	for _, ev := range m.byChan[channelID] {
		if ev.Seq > readSeq && ev.Kind != contract.ChannelEventReaction {
			count++
		}
	}
	return count, nil
}

func (m *memoryBackend) close() error { return nil }
