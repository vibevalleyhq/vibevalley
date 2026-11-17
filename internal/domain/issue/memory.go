package issue

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"sync"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

type memIssueBackend struct {
	mu     sync.RWMutex
	issues map[string]Issue
	crons  map[string]CronSchedule
}

func newMemoryIssueBackend() *memIssueBackend {
	return &memIssueBackend{
		issues: make(map[string]Issue),
		crons:  make(map[string]CronSchedule),
	}
}

func (m *memIssueBackend) createIssue(_ context.Context, iss Issue) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.issues[iss.ID]; exists {
		return fmt.Errorf("%w: issue %q", ErrDuplicate, iss.ID)
	}
	m.issues[iss.ID] = cloneIssue(iss)
	return nil
}

func (m *memIssueBackend) upsertIssue(_ context.Context, iss Issue) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.issues[iss.ID] = cloneIssue(iss)
	return nil
}

func (m *memIssueBackend) getIssue(_ context.Context, id string) (Issue, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	iss, ok := m.issues[id]
	return cloneIssue(iss), ok, nil
}

func (m *memIssueBackend) findIssueByConversationOrSession(_ context.Context, conversationID, sessionID string) (Issue, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, iss := range m.issues {
		if conversationID != "" && iss.ConversationID == conversationID {
			return cloneIssue(iss), true, nil
		}
		if sessionID != "" && iss.SessionID == sessionID {
			return cloneIssue(iss), true, nil
		}
	}
	return Issue{}, false, nil
}

func (m *memIssueBackend) listIssues(_ context.Context, statuses ...contract.IssueStatus) ([]Issue, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []Issue
	for _, iss := range m.issues {
		if len(statuses) > 0 && !slices.Contains(statuses, iss.Status) {
			continue
		}
		out = append(out, cloneIssue(iss))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAtMs != out[j].CreatedAtMs {
			return out[i].CreatedAtMs < out[j].CreatedAtMs
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func (m *memIssueBackend) createCron(_ context.Context, c CronSchedule) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.crons[c.ID]; exists {
		return fmt.Errorf("%w: cron %q", ErrDuplicate, c.ID)
	}
	m.crons[c.ID] = cloneCron(c)
	return nil
}

func (m *memIssueBackend) updateCron(_ context.Context, c CronSchedule) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.crons[c.ID]; !exists {
		return fmt.Errorf("%w: cron %q", ErrNotFound, c.ID)
	}
	m.crons[c.ID] = cloneCron(c)
	return nil
}

func (m *memIssueBackend) getCron(_ context.Context, id string) (CronSchedule, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	c, ok := m.crons[id]
	return cloneCron(c), ok, nil
}

func (m *memIssueBackend) listCrons(_ context.Context) ([]CronSchedule, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]CronSchedule, 0, len(m.crons))
	for _, c := range m.crons {
		out = append(out, cloneCron(c))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAtMs != out[j].CreatedAtMs {
			return out[i].CreatedAtMs < out[j].CreatedAtMs
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func (m *memIssueBackend) dueCrons(_ context.Context, nowMs int64) ([]CronSchedule, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []CronSchedule
	for _, c := range m.crons {
		if c.Enabled && !c.PendingApproval && c.NextRunAtMs > 0 && c.NextRunAtMs <= nowMs {
			out = append(out, cloneCron(c))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].NextRunAtMs != out[j].NextRunAtMs {
			return out[i].NextRunAtMs < out[j].NextRunAtMs
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func (m *memIssueBackend) close() error { return nil }
