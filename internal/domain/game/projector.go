package game

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"sort"
	"strconv"
	"sync"

	"github.com/vibevalleyhq/vibevalley/internal/durable"
	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/delta"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/watch"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

// Projector maintains a live reactive pkg/chord/watch.Document[contract.SpaceView]
// projecting live revisions, issues, inbox, approvals, dreams, and online machines
// as minimal incremental delta operations over Chord.
type Projector struct {
	doc *watch.Document[contract.SpaceView]

	mu             sync.Mutex
	issues         []contract.IssueView
	inbox          []contract.InboxItemView
	approvals      []contract.ApprovalPromptView
	dreams         []contract.DreamProposalView
	onlineMachines []string
	liveRevisions  map[string]int64
}

// NewProjector initializes a Projector backed by a new watch.Document[contract.SpaceView] at rev 1.
func NewProjector(opts ...watch.DocumentOption[contract.SpaceView]) (*Projector, error) {
	initial := contract.SpaceView{
		Rev:            1,
		Issues:         []contract.IssueView{},
		Inbox:          []contract.InboxItemView{},
		Approvals:      []contract.ApprovalPromptView{},
		Dreams:         []contract.DreamProposalView{},
		OnlineMachines: []string{},
	}
	doc, err := watch.NewDocument(initial, opts...)
	if err != nil {
		return nil, err
	}
	return &Projector{
		doc:            doc,
		issues:         []contract.IssueView{},
		inbox:          []contract.InboxItemView{},
		approvals:      []contract.ApprovalPromptView{},
		dreams:         []contract.DreamProposalView{},
		onlineMachines: []string{},
		liveRevisions:  make(map[string]int64),
	}, nil
}

// Document returns the underlying Chord watch.Document[contract.SpaceView] (implementing watch.RawSource).
func (p *Projector) Document() *watch.Document[contract.SpaceView] {
	return p.doc
}

// Watch subscribes a single-flight WatchHandle[contract.SpaceView] to SpaceView updates.
func (p *Projector) Watch(ctx context.Context, fn func(context.Context, watch.Event[contract.SpaceView]), opts ...watch.HandleOption) (*watch.WatchHandle[contract.SpaceView], error) {
	return p.doc.Watch(ctx, fn, opts...)
}

// Snapshot returns the current SpaceView copy and its revision.
func (p *Projector) Snapshot() (int64, contract.SpaceView) {
	rev, val, _ := p.doc.State()
	return rev, val
}

// LiveRevisions returns a copy of tracked per-scope live document revisions.
func (p *Projector) LiveRevisions() map[string]int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return maps.Clone(p.liveRevisions)
}

// ProjectIssues replaces the projected issue list with minimal delta ops.
func (p *Projector) ProjectIssues(issues []contract.IssueView) (int64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	next := normalizeIssues(issues)
	return p.commitLocked(func(cur *spaceDraft) {
		cur.issues = next
	})
}

// UpsertIssue inserts or updates a single IssueView in SpaceView.
func (p *Projector) UpsertIssue(issue contract.IssueView) (int64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.commitLocked(func(cur *spaceDraft) {
		next := slices.Clone(cur.issues)
		replaced := false
		for i := range next {
			if next[i].ID == issue.ID {
				next[i] = issue
				replaced = true
				break
			}
		}
		if !replaced {
			next = append(next, issue)
		}
		cur.issues = next
	})
}

// RemoveIssue removes an IssueView by ID from SpaceView.
func (p *Projector) RemoveIssue(issueID string) (int64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.commitLocked(func(cur *spaceDraft) {
		next := make([]contract.IssueView, 0, len(cur.issues))
		for _, item := range cur.issues {
			if item.ID != issueID {
				next = append(next, item)
			}
		}
		cur.issues = next
	})
}

// ProjectInbox replaces the projected owner inbox list with minimal delta ops.
func (p *Projector) ProjectInbox(items []contract.InboxItemView) (int64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	next := normalizeInbox(items)
	return p.commitLocked(func(cur *spaceDraft) {
		cur.inbox = next
	})
}

// UpsertInboxItem inserts or updates a single InboxItemView in SpaceView.
func (p *Projector) UpsertInboxItem(item contract.InboxItemView) (int64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.commitLocked(func(cur *spaceDraft) {
		next := slices.Clone(cur.inbox)
		replaced := false
		for i := range next {
			if next[i].ID == item.ID {
				next[i] = item
				replaced = true
				break
			}
		}
		if !replaced {
			next = append(next, item)
		}
		cur.inbox = next
	})
}

// ProjectApprovals replaces the projected pending approval list.
func (p *Projector) ProjectApprovals(approvals []contract.ApprovalPromptView) (int64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	next := normalizeApprovals(approvals)
	return p.commitLocked(func(cur *spaceDraft) {
		cur.approvals = next
	})
}

// UpsertApproval inserts or updates a parked ApprovalPromptView by TaskID.
func (p *Projector) UpsertApproval(a contract.ApprovalPromptView) (int64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.commitLocked(func(cur *spaceDraft) {
		next := slices.Clone(cur.approvals)
		replaced := false
		for i := range next {
			if next[i].TaskID == a.TaskID {
				next[i] = a
				replaced = true
				break
			}
		}
		if !replaced {
			next = append(next, a)
		}
		cur.approvals = next
	})
}

// RemoveApproval removes a resolved ApprovalPromptView by TaskID.
func (p *Projector) RemoveApproval(taskID string) (int64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.commitLocked(func(cur *spaceDraft) {
		next := make([]contract.ApprovalPromptView, 0, len(cur.approvals))
		for _, a := range cur.approvals {
			if a.TaskID != taskID {
				next = append(next, a)
			}
		}
		cur.approvals = next
	})
}

// ProjectDreams replaces the projected offline DreamProposalView list.
func (p *Projector) ProjectDreams(dreams []contract.DreamProposalView) (int64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	next := normalizeDreams(dreams)
	return p.commitLocked(func(cur *spaceDraft) {
		cur.dreams = next
	})
}

// UpsertDream inserts or updates a DreamProposalView by ProposalID.
func (p *Projector) UpsertDream(d contract.DreamProposalView) (int64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.commitLocked(func(cur *spaceDraft) {
		next := slices.Clone(cur.dreams)
		replaced := false
		for i := range next {
			if next[i].ProposalID == d.ProposalID {
				next[i] = d
				replaced = true
				break
			}
		}
		if !replaced {
			next = append(next, d)
		}
		cur.dreams = next
	})
}

// ProjectOnlineMachines replaces the projected sorted list of online machine node IDs.
func (p *Projector) ProjectOnlineMachines(machines []string) (int64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	next := normalizeMachines(machines)
	return p.commitLocked(func(cur *spaceDraft) {
		cur.onlineMachines = next
	})
}

// ProjectSpace atomically projects a complete SpaceView slice set as minimal per-field deltas.
func (p *Projector) ProjectSpace(view contract.SpaceView) (int64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	issues := normalizeIssues(view.Issues)
	inbox := normalizeInbox(view.Inbox)
	approvals := normalizeApprovals(view.Approvals)
	dreams := normalizeDreams(view.Dreams)
	machines := normalizeMachines(view.OnlineMachines)
	return p.commitLocked(func(cur *spaceDraft) {
		cur.issues = issues
		cur.inbox = inbox
		cur.approvals = approvals
		cur.dreams = dreams
		cur.onlineMachines = machines
	})
}

// SetMachineOnline marks a machine ID online or offline in SpaceView.OnlineMachines.
func (p *Projector) SetMachineOnline(machineID string, online bool) (int64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.commitLocked(func(cur *spaceDraft) {
		set := make(map[string]bool, len(cur.onlineMachines)+1)
		for _, m := range cur.onlineMachines {
			set[m] = true
		}
		if online {
			set[machineID] = true
		} else {
			delete(set, machineID)
		}
		next := make([]string, 0, len(set))
		for m := range set {
			next = append(next, m)
		}
		slices.Sort(next)
		cur.onlineMachines = next
	})
}

// RecordLiveRevision tracks a live document revision change and bumps SpaceView.Rev.
func (p *Projector) RecordLiveRevision(scopeKey string, rev int64) (int64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if prev, ok := p.liveRevisions[scopeKey]; ok && prev == rev {
		curRev, _, _ := p.doc.Snapshot()
		return curRev, nil
	}
	p.liveRevisions[scopeKey] = rev
	return p.bumpRevOnlyLocked()
}

// RemoveLiveRevision clears a retired live scope and bumps SpaceView.Rev.
func (p *Projector) RemoveLiveRevision(scopeKey string) (int64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, ok := p.liveRevisions[scopeKey]; !ok {
		curRev, _, _ := p.doc.Snapshot()
		return curRev, nil
	}
	delete(p.liveRevisions, scopeKey)
	return p.bumpRevOnlyLocked()
}

// OnDocumentChange implements store.DocumentObserver so durable pi.live and pi.inbox
// updates project reactively into SpaceView over Chord.
func (p *Projector) OnDocumentChange(ev store.DocumentEvent) {
	key := fmt.Sprintf("%s:%s:%s", ev.ScopeKind, ev.ScopeID, ev.DocKind)
	switch ev.DocKind {
	case store.DocLive:
		if ev.Retired {
			_, _ = p.RemoveLiveRevision(key)
		} else {
			_, _ = p.RecordLiveRevision(key, ev.Rev)
		}
	case store.DocInbox:
		var doc struct {
			Items []durable.Alert `json:"items"`
		}
		if len(ev.StateJSON) == 0 || json.Unmarshal(ev.StateJSON, &doc) != nil {
			return
		}
		p.mu.Lock()
		defer p.mu.Unlock()
		_, _ = p.commitLocked(func(cur *spaceDraft) {
			for idx, al := range doc.Items {
				itemID := fmt.Sprintf("durable:%s:%s:%d:%d", al.Kind, al.TaskID, al.CreatedAtMs, idx)
				var inboxKind contract.InboxItemKind
				switch al.Kind {
				case durable.AlertPermissionPark:
					inboxKind = contract.InboxApproval
					var payload struct {
						ToolCall   durable.ToolCall              `json:"toolCall"`
						Evaluation contract.PermissionEvaluation `json:"evaluation"`
					}
					if json.Unmarshal(al.Payload, &payload) == nil && al.TaskID != "" {
						ap := contract.ApprovalPromptView{
							TaskID:        al.TaskID,
							SessionID:     al.ConversationID,
							ToolName:      payload.ToolCall.ToolName,
							Policy:        payload.Evaluation.Policy,
							Summary:       al.Message,
							RequestedAtMs: al.CreatedAtMs,
						}
						cur.approvals = upsertApprovalSlice(cur.approvals, ap)
					}
				case durable.AlertBudgetReached:
					inboxKind = contract.InboxBudgetReached
				default:
					inboxKind = contract.InboxMention
				}
				cur.inbox = upsertInboxSlice(cur.inbox, contract.InboxItemView{
					ID:          itemID,
					Kind:        inboxKind,
					Title:       al.Title,
					Summary:     al.Message,
					SessionID:   al.ConversationID,
					Resolved:    false,
					CreatedAtMs: al.CreatedAtMs,
				})
			}
		})
	}
}

type spaceDraft struct {
	issues         []contract.IssueView
	inbox          []contract.InboxItemView
	approvals      []contract.ApprovalPromptView
	dreams         []contract.DreamProposalView
	onlineMachines []string
}

func (p *Projector) bumpRevOnlyLocked() (int64, error) {
	return p.doc.Mutate(func(d *delta.Draft) error {
		curRev := readDraftRev(d)
		return d.Set([]string{"rev"}, curRev+1)
	})
}

func (p *Projector) commitLocked(mutateFn func(*spaceDraft)) (int64, error) {
	draftState := spaceDraft{
		issues:         slices.Clone(p.issues),
		inbox:          slices.Clone(p.inbox),
		approvals:      slices.Clone(p.approvals),
		dreams:         slices.Clone(p.dreams),
		onlineMachines: slices.Clone(p.onlineMachines),
	}
	mutateFn(&draftState)

	prevIssuesVal, err := toStrictValue(p.issues)
	if err != nil {
		return 0, err
	}
	nextIssuesVal, err := toStrictValue(draftState.issues)
	if err != nil {
		return 0, err
	}
	prevInboxVal, err := toStrictValue(p.inbox)
	if err != nil {
		return 0, err
	}
	nextInboxVal, err := toStrictValue(draftState.inbox)
	if err != nil {
		return 0, err
	}
	prevApprovalsVal, err := toStrictValue(p.approvals)
	if err != nil {
		return 0, err
	}
	nextApprovalsVal, err := toStrictValue(draftState.approvals)
	if err != nil {
		return 0, err
	}
	prevDreamsVal, err := toStrictValue(p.dreams)
	if err != nil {
		return 0, err
	}
	nextDreamsVal, err := toStrictValue(draftState.dreams)
	if err != nil {
		return 0, err
	}
	prevMachinesVal, err := toStrictValue(p.onlineMachines)
	if err != nil {
		return 0, err
	}
	nextMachinesVal, err := toStrictValue(draftState.onlineMachines)
	if err != nil {
		return 0, err
	}

	issuesChanged := !delta.Equal(prevIssuesVal, nextIssuesVal)
	inboxChanged := !delta.Equal(prevInboxVal, nextInboxVal)
	approvalsChanged := !delta.Equal(prevApprovalsVal, nextApprovalsVal)
	dreamsChanged := !delta.Equal(prevDreamsVal, nextDreamsVal)
	machinesChanged := !delta.Equal(prevMachinesVal, nextMachinesVal)

	if !issuesChanged && !inboxChanged && !approvalsChanged && !dreamsChanged && !machinesChanged {
		curRev, _, _ := p.doc.Snapshot()
		return curRev, nil
	}

	rev, err := p.doc.Mutate(func(d *delta.Draft) error {
		curRev := readDraftRev(d)
		if err := d.Set([]string{"rev"}, curRev+1); err != nil {
			return err
		}
		if issuesChanged {
			if err := applyArrayDelta(d, "issues", prevIssuesVal.([]any), nextIssuesVal.([]any)); err != nil {
				return err
			}
		}
		if inboxChanged {
			if err := applyArrayDelta(d, "inbox", prevInboxVal.([]any), nextInboxVal.([]any)); err != nil {
				return err
			}
		}
		if approvalsChanged {
			if err := applyArrayDelta(d, "approvals", prevApprovalsVal.([]any), nextApprovalsVal.([]any)); err != nil {
				return err
			}
		}
		if dreamsChanged {
			if err := applyArrayDelta(d, "dreams", prevDreamsVal.([]any), nextDreamsVal.([]any)); err != nil {
				return err
			}
		}
		if machinesChanged {
			if err := applyArrayDelta(d, "onlineMachines", prevMachinesVal.([]any), nextMachinesVal.([]any)); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}

	p.issues = draftState.issues
	p.inbox = draftState.inbox
	p.approvals = draftState.approvals
	p.dreams = draftState.dreams
	p.onlineMachines = draftState.onlineMachines
	return rev, nil
}

func applyArrayDelta(d *delta.Draft, field string, prev, next []any) error {
	if len(next) > len(prev) {
		prefixEqual := true
		for i := range prev {
			if !delta.Equal(prev[i], next[i]) {
				prefixEqual = false
				break
			}
		}
		if prefixEqual {
			return d.SpliceArray([]string{field}, len(prev), 0, next[len(prev):]...)
		}
	}
	if len(next) == len(prev) {
		for i := range next {
			if !delta.Equal(prev[i], next[i]) {
				if err := d.Set([]string{field, strconv.Itoa(i)}, next[i]); err != nil {
					return err
				}
			}
		}
		return nil
	}
	return d.Set([]string{field}, next)
}

func readDraftRev(d *delta.Draft) int64 {
	if m, ok := d.Value().(map[string]any); ok {
		if r, ok := m["rev"].(int64); ok {
			return r
		}
	}
	return 1
}

func toStrictValue[T any](in []T) (any, error) {
	if in == nil {
		in = []T{}
	}
	raw, err := json.Marshal(in)
	if err != nil {
		return nil, err
	}
	return delta.UnmarshalValue(raw)
}

func normalizeIssues(in []contract.IssueView) []contract.IssueView {
	if len(in) == 0 {
		return []contract.IssueView{}
	}
	return slices.Clone(in)
}

func normalizeInbox(in []contract.InboxItemView) []contract.InboxItemView {
	if len(in) == 0 {
		return []contract.InboxItemView{}
	}
	return slices.Clone(in)
}

func normalizeApprovals(in []contract.ApprovalPromptView) []contract.ApprovalPromptView {
	if len(in) == 0 {
		return []contract.ApprovalPromptView{}
	}
	return slices.Clone(in)
}

func normalizeDreams(in []contract.DreamProposalView) []contract.DreamProposalView {
	if len(in) == 0 {
		return []contract.DreamProposalView{}
	}
	return slices.Clone(in)
}

func normalizeMachines(in []string) []string {
	if len(in) == 0 {
		return []string{}
	}
	cp := slices.Clone(in)
	sort.Strings(cp)
	return slices.Compact(cp)
}

func upsertApprovalSlice(in []contract.ApprovalPromptView, ap contract.ApprovalPromptView) []contract.ApprovalPromptView {
	out := slices.Clone(in)
	for i := range out {
		if out[i].TaskID == ap.TaskID {
			out[i] = ap
			return out
		}
	}
	return append(out, ap)
}

func upsertInboxSlice(in []contract.InboxItemView, item contract.InboxItemView) []contract.InboxItemView {
	out := slices.Clone(in)
	for i := range out {
		if out[i].ID == item.ID {
			out[i] = item
			return out
		}
	}
	return append(out, item)
}
