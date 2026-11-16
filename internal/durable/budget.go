package durable

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"

	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
)

// SignalBudgetUpdated wakes a task parked in budget_reached sleeping state after budget.updated.
const SignalBudgetUpdated = "budget.updated"

// GovernanceDocState is the durable_document state stored under doc_kind = "pi.governance".
type GovernanceDocState struct {
	Budget               *contract.BudgetSpec            `json:"budget,omitempty"`
	BudgetSnapshot       *contract.BudgetSnapshot        `json:"budgetSnapshot,omitempty"`
	Status               string                          `json:"status,omitempty"`
	EvaluatedPermissions []contract.PermissionEvaluation `json:"evaluatedPermissions,omitempty"`
	HardDeniedCalls      map[string]bool                 `json:"hardDeniedCalls,omitempty"`
	LastRubricVerdict    *contract.RubricVerdict         `json:"lastRubricVerdict,omitempty"`
	RubricHistory        []contract.RubricVerdict        `json:"rubricHistory,omitempty"`
}

// BudgetGate tracks cumulative session + child task spend in pi.usage and enforces
// contract.BudgetSpec limits via pi.governance without terminating leases or sessions.
type BudgetGate struct {
	st        *store.Store
	leases    *LeaseStore
	alertSink AlertSink
}

// NewBudgetGate creates a BudgetGate backed by st.
func NewBudgetGate(st *store.Store, leases *LeaseStore, alertSink AlertSink) *BudgetGate {
	return &BudgetGate{st: st, leases: leases, alertSink: alertSink}
}

// SetBudget configures (or removes, when MaxCostMicros <= 0) the session spend cap in pi.governance.
func (g *BudgetGate) SetBudget(ctx context.Context, conversationID string, spec contract.BudgetSpec) (contract.BudgetSnapshot, error) {
	var snap contract.BudgetSnapshot
	err := g.st.Mutate(ctx, func(tx *store.Tx) error {
		doc, err := loadGovernanceDocTx(ctx, tx, conversationID)
		if err != nil {
			return err
		}
		cp := spec
		doc.Budget = &cp
		snap, err = computeBudgetSnapshotTx(ctx, tx, conversationID, doc.Budget)
		if err != nil {
			return err
		}
		doc.BudgetSnapshot = &snap
		if !snap.Reached && doc.Status == "budget_reached" {
			doc.Status = "active"
		}
		return saveGovernanceDocTx(ctx, tx, conversationID, doc)
	})
	return snap, err
}

// RecordUsage accumulates incremental token and cost usage into conversationID's pi.usage document.
// Nil CostMicros remains nil/uncounted rather than fabricating fake estimates.
func (g *BudgetGate) RecordUsage(ctx context.Context, conversationID string, delta contract.UsageTotals) (contract.UsageTotals, error) {
	var updated contract.UsageTotals
	err := g.st.Mutate(ctx, func(tx *store.Tx) error {
		cur, err := loadUsageDocTx(ctx, tx, conversationID)
		if err != nil {
			return err
		}
		cur.InputTokens += delta.InputTokens
		cur.OutputTokens += delta.OutputTokens
		cur.CacheReadTokens += delta.CacheReadTokens
		cur.CacheWriteTokens += delta.CacheWriteTokens
		cur.ReasoningTokens += delta.ReasoningTokens
		if delta.CostMicros != nil {
			prev := int64(0)
			if cur.CostMicros != nil {
				prev = *cur.CostMicros
			}
			sum := prev + *delta.CostMicros
			cur.CostMicros = &sum
		}
		raw, err := json.Marshal(cur)
		if err != nil {
			return err
		}
		if _, err := tx.PutDocument(ctx, store.ScopeConversation, conversationID, store.DocUsage, raw); err != nil {
			return err
		}
		updated = cur
		return nil
	})
	return updated, err
}

// Snapshot computes cumulative spend across rootConversationID and all child tasks/conversations
// derived from it, compared against the configured contract.BudgetSpec.
func (g *BudgetGate) Snapshot(ctx context.Context, rootConversationID string) (contract.BudgetSnapshot, error) {
	var snap contract.BudgetSnapshot
	err := g.st.Mutate(ctx, func(tx *store.Tx) error {
		doc, err := loadGovernanceDocTx(ctx, tx, rootConversationID)
		if err != nil {
			return err
		}
		snap, err = computeBudgetSnapshotTx(ctx, tx, rootConversationID, doc.Budget)
		return err
	})
	return snap, err
}

// CheckBeforeGeneration evaluates the budget gate before issuing a new pi.generation model call.
// If Reached == true, it persists status="budget_reached" in pi.governance and an Alert in pi.inbox
// while leaving any workspace Lease active and unbroken.
func (g *BudgetGate) CheckBeforeGeneration(ctx context.Context, rootConversationID, taskID string) (contract.BudgetSnapshot, error) {
	var snap contract.BudgetSnapshot
	var emitted *Alert

	err := g.st.Mutate(ctx, func(tx *store.Tx) error {
		doc, err := loadGovernanceDocTx(ctx, tx, rootConversationID)
		if err != nil {
			return err
		}
		snap, err = computeBudgetSnapshotTx(ctx, tx, rootConversationID, doc.Budget)
		if err != nil {
			return err
		}
		doc.BudgetSnapshot = &snap
		if snap.Reached {
			doc.Status = "budget_reached"
			payload, _ := json.Marshal(snap)
			al, err := persistAlertTx(ctx, tx, Alert{
				Kind:           AlertBudgetReached,
				TaskID:         taskID,
				ConversationID: rootConversationID,
				Title:          "Session budget reached",
				Message:        fmt.Sprintf("spend %d micros reached limit %d micros; paused awaiting budget.updated", snap.SpentMicros, snap.MaxCostMicros),
				Payload:        payload,
				CreatedAtMs:    tx.NowMs(),
			})
			if err != nil {
				return err
			}
			emitted = &al
		} else {
			doc.Status = "active"
		}
		return saveGovernanceDocTx(ctx, tx, rootConversationID, doc)
	})
	if err != nil {
		return contract.BudgetSnapshot{}, err
	}
	if emitted != nil && g.alertSink != nil {
		g.alertSink.OnAlert(*emitted)
	}
	return snap, nil
}

// UpdateBudgetAndResume updates the budget cap (or sets MaxCostMicros=0 to remove cap)
// and delivers a budget.updated signal via sched so a sleeping task resumes seamlessly.
func (g *BudgetGate) UpdateBudgetAndResume(ctx context.Context, sched *Scheduler, rootConversationID, taskID string, newSpec contract.BudgetSpec) (contract.BudgetSnapshot, error) {
	snap, err := g.SetBudget(ctx, rootConversationID, newSpec)
	if err != nil {
		return contract.BudgetSnapshot{}, err
	}
	if sched != nil && taskID != "" {
		payload, _ := json.Marshal(map[string]any{
			"budget":   newSpec,
			"snapshot": snap,
		})
		if _, err := sched.SendSignal(ctx, store.Signal{
			TaskID:      taskID,
			SignalName:  SignalBudgetUpdated,
			SignalKey:   fmt.Sprintf("budget:%d:%d", newSpec.MaxCostMicros, g.st.Clock().NowMs()),
			PayloadJSON: payload,
		}); err != nil {
			return contract.BudgetSnapshot{}, err
		}
	}
	return snap, nil
}

func computeBudgetSnapshotTx(ctx context.Context, tx *store.Tx, rootConvID string, spec *contract.BudgetSpec) (contract.BudgetSnapshot, error) {
	spent, err := aggregateConversationTreeSpendTx(ctx, tx, rootConvID)
	if err != nil {
		return contract.BudgetSnapshot{}, err
	}
	var maxMicros int64
	if spec != nil {
		maxMicros = spec.MaxCostMicros
	}
	reached := maxMicros > 0 && spent >= maxMicros
	return contract.BudgetSnapshot{
		SpentMicros:   spent,
		MaxCostMicros: maxMicros,
		Reached:       reached,
	}, nil
}

// aggregateConversationTreeSpendTx sums pi.usage CostMicros across rootConvID and all descendant
// conversations owned by tasks belonging to rootConvID (or recursively derived child tasks).
func aggregateConversationTreeSpendTx(ctx context.Context, tx *store.Tx, rootConvID string) (int64, error) {
	visitedConvs := map[string]bool{rootConvID: true}
	visitedTasks := make(map[string]bool)
	convQueue := []string{rootConvID}
	var total int64

	for len(convQueue) > 0 {
		cid := convQueue[0]
		convQueue = convQueue[1:]

		usage, err := loadUsageDocTx(ctx, tx, cid)
		if err != nil {
			return 0, err
		}
		if usage.CostMicros != nil {
			total += *usage.CostMicros
		}

		tasks, err := tx.ListTasksByConversation(ctx, cid)
		if err != nil {
			return 0, err
		}
		taskQueue := make([]store.Task, 0, len(tasks))
		for _, t := range tasks {
			if !visitedTasks[t.ID] {
				visitedTasks[t.ID] = true
				taskQueue = append(taskQueue, t)
			}
		}

		for len(taskQueue) > 0 {
			t := taskQueue[0]
			taskQueue = taskQueue[1:]

			// Include any child conversations spawned under this task.
			childConvs, err := tx.ListConversationsByOwnerTask(ctx, t.ID)
			if err != nil {
				return 0, err
			}
			for _, cc := range childConvs {
				if !visitedConvs[cc.ID] {
					visitedConvs[cc.ID] = true
					convQueue = append(convQueue, cc.ID)
				}
			}

			// Include task-scoped usage docs if recorded directly under ScopeTask.
			tUsage, err := loadTaskUsageDocTx(ctx, tx, t.ID)
			if err != nil {
				return 0, err
			}
			if tUsage.CostMicros != nil {
				total += *tUsage.CostMicros
			}

			// Walk nested subtasks owned by t.ID.
			subTasks, err := tx.ListChildTasks(ctx, t.ID)
			if err != nil {
				return 0, err
			}
			for _, st := range subTasks {
				if !visitedTasks[st.ID] {
					visitedTasks[st.ID] = true
					taskQueue = append(taskQueue, st)
				}
			}
		}
	}
	return total, nil
}

func loadUsageDocTx(ctx context.Context, tx *store.Tx, conversationID string) (contract.UsageTotals, error) {
	return loadUsageByScopeTx(ctx, tx, store.ScopeConversation, conversationID)
}

func loadTaskUsageDocTx(ctx context.Context, tx *store.Tx, taskID string) (contract.UsageTotals, error) {
	return loadUsageByScopeTx(ctx, tx, store.ScopeTask, taskID)
}

func loadUsageByScopeTx(ctx context.Context, tx *store.Tx, scopeKind, scopeID string) (contract.UsageTotals, error) {
	doc, err := tx.GetDocument(ctx, scopeKind, scopeID, store.DocUsage)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return contract.UsageTotals{}, nil
		}
		return contract.UsageTotals{}, err
	}
	var out contract.UsageTotals
	if len(doc.StateJSON) > 0 {
		if err := json.Unmarshal(doc.StateJSON, &out); err != nil {
			return contract.UsageTotals{}, err
		}
	}
	return out, nil
}

func loadGovernanceDocTx(ctx context.Context, tx *store.Tx, conversationID string) (GovernanceDocState, error) {
	doc, err := tx.GetDocument(ctx, store.ScopeConversation, conversationID, store.DocGovernance)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return GovernanceDocState{}, nil
		}
		return GovernanceDocState{}, err
	}
	var state GovernanceDocState
	if len(doc.StateJSON) > 0 {
		if err := json.Unmarshal(doc.StateJSON, &state); err != nil {
			return GovernanceDocState{}, err
		}
	}
	return state, nil
}

func saveGovernanceDocTx(ctx context.Context, tx *store.Tx, conversationID string, state GovernanceDocState) error {
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	_, err = tx.PutDocument(ctx, store.ScopeConversation, conversationID, store.DocGovernance, raw)
	return err
}
