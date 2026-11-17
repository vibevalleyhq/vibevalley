package watch

import (
	"context"
	"fmt"
	"sort"
	"sync"

	"github.com/vibevalleyhq/vibevalley/internal/domain/channel"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

type seatKey struct {
	channelID string
	agentID   string
}

type inboxEntry struct {
	item      contract.InboxItemView
	channelID string
	eventSeq  int64
}

type memWatchBackend struct {
	mu     sync.RWMutex
	cursor int64
	seats  map[seatKey]Seat
	homes  map[string]string
	brakes BrakeState
	inbox  map[string]inboxEntry
}

func newMemoryWatchBackend() *memWatchBackend {
	return &memWatchBackend{
		seats:  make(map[seatKey]Seat),
		homes:  make(map[string]string),
		brakes: newBrakeState(),
		inbox:  make(map[string]inboxEntry),
	}
}

func (m *memWatchBackend) getCursor(_ context.Context) (int64, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.cursor, nil
}

func (m *memWatchBackend) setCursor(_ context.Context, globalSeq, _ int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if globalSeq > m.cursor {
		m.cursor = globalSeq
	}
	return nil
}

func (m *memWatchBackend) upsertSeat(_ context.Context, seat Seat, maxPerChan, maxActive int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := seatKey{channelID: seat.ChannelID, agentID: seat.AgentID}
	existing, exists := m.seats[k]

	if seat.Active && (!exists || !existing.Active) && seat.Role == channel.RoleWorker {
		if maxPerChan > 0 {
			chanCount := 0
			for sk, s := range m.seats {
				if sk.channelID == seat.ChannelID && s.Active && s.Role == channel.RoleWorker {
					chanCount++
				}
			}
			if chanCount >= maxPerChan {
				return fmt.Errorf("%w: channel %q reached limit %d", ErrSeatCapacityReached, seat.ChannelID, maxPerChan)
			}
		}
		if maxActive > 0 {
			totalCount := 0
			for _, s := range m.seats {
				if s.Active && s.Role == channel.RoleWorker {
					totalCount++
				}
			}
			if totalCount >= maxActive {
				return fmt.Errorf("%w: global active limit %d", ErrSeatCapacityReached, maxActive)
			}
		}
	}

	m.seats[k] = cloneSeat(seat)
	if seat.HomeChannelID != "" {
		m.homes[seat.AgentID] = seat.HomeChannelID
	} else if seat.Active && m.homes[seat.AgentID] == "" {
		m.homes[seat.AgentID] = seat.ChannelID
	}
	return nil
}

func (m *memWatchBackend) vacateSeat(_ context.Context, channelID, agentID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := seatKey{channelID: channelID, agentID: agentID}
	if s, ok := m.seats[k]; ok {
		s.Active = false
		m.seats[k] = s
	}
	return nil
}

func (m *memWatchBackend) getSeat(_ context.Context, channelID, agentID string) (Seat, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.seats[seatKey{channelID: channelID, agentID: agentID}]
	return cloneSeat(s), ok, nil
}

func (m *memWatchBackend) listSeats(_ context.Context, channelID string) ([]Seat, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []Seat
	for k, s := range m.seats {
		if (channelID == "" || k.channelID == channelID) && s.Active {
			out = append(out, cloneSeat(s))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ChannelID != out[j].ChannelID {
			return out[i].ChannelID < out[j].ChannelID
		}
		return out[i].AgentID < out[j].AgentID
	})
	return out, nil
}

func (m *memWatchBackend) homeOf(_ context.Context, agentID string) (string, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	h, ok := m.homes[agentID]
	return h, ok, nil
}

func (m *memWatchBackend) loadBrakes(_ context.Context) (BrakeState, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return cloneBrakeState(m.brakes), nil
}

func (m *memWatchBackend) saveBrakes(_ context.Context, state BrakeState) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.brakes = cloneBrakeState(state)
	return nil
}

func (m *memWatchBackend) upsertInbox(_ context.Context, item contract.InboxItemView) error {
	return m.upsertInboxWithChannel(context.Background(), item, "", 0)
}

func (m *memWatchBackend) upsertInboxWithChannel(_ context.Context, item contract.InboxItemView, channelID string, eventSeq int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if cur, ok := m.inbox[item.ID]; ok {
		if cur.item.Resolved && !item.Resolved {
			item.Resolved = true
		}
		if channelID == "" {
			channelID = cur.channelID
		}
		if eventSeq == 0 {
			eventSeq = cur.eventSeq
		}
	}
	m.inbox[item.ID] = inboxEntry{
		item:      cloneInboxItem(item),
		channelID: channelID,
		eventSeq:  eventSeq,
	}
	return nil
}

func (m *memWatchBackend) resolveInbox(_ context.Context, id string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	cur, ok := m.inbox[id]
	if !ok {
		return false, nil
	}
	cur.item.Resolved = true
	m.inbox[id] = cur
	return true, nil
}

func (m *memWatchBackend) resolveChannelInboxUpTo(_ context.Context, channelID string, maxSeq int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, entry := range m.inbox {
		if entry.channelID == channelID && entry.eventSeq > 0 && entry.eventSeq <= maxSeq && !entry.item.Resolved {
			entry.item.Resolved = true
			m.inbox[id] = entry
		}
	}
	return nil
}

func (m *memWatchBackend) listInbox(_ context.Context, includeResolved bool) ([]contract.InboxItemView, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]contract.InboxItemView, 0, len(m.inbox))
	for _, entry := range m.inbox {
		if !includeResolved && entry.item.Resolved {
			continue
		}
		out = append(out, cloneInboxItem(entry.item))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAtMs != out[j].CreatedAtMs {
			return out[i].CreatedAtMs < out[j].CreatedAtMs
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func (m *memWatchBackend) close() error { return nil }
