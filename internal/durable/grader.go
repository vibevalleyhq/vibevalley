package durable

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"

	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
)

const defaultRubricMaxIterations = 3

// GraderInput contains ONLY the isolated artifacts passed to an independent grader session.
// The primary agent's internal chain-of-thought and tool chatter are strictly omitted.
type GraderInput struct {
	TaskPrompt      string `json:"taskPrompt"`
	RubricMarkdown  string `json:"rubricMarkdown"`
	Deliverables    string `json:"deliverables"`
	CandidateOutput string `json:"candidateOutput"`
	Iteration       int    `json:"iteration"`
}

// GraderDriver evaluates deliverables against a RubricSpec inside an isolated read-only conversation.
type GraderDriver interface {
	Grade(ctx context.Context, graderConvID string, input GraderInput) (contract.RubricVerdict, error)
}

// GraderDriverFunc adapts a function to GraderDriver.
type GraderDriverFunc func(ctx context.Context, graderConvID string, input GraderInput) (contract.RubricVerdict, error)

func (f GraderDriverFunc) Grade(ctx context.Context, graderConvID string, input GraderInput) (contract.RubricVerdict, error) {
	return f(ctx, graderConvID, input)
}

// ModelGraderDriver runs an isolated read-only ModelClient inside the grader conversation.
type ModelGraderDriver struct {
	Store  *store.Store
	Model  ModelClient
	Budget *BudgetGate
}

func (d *ModelGraderDriver) Grade(ctx context.Context, graderConvID string, input GraderInput) (contract.RubricVerdict, error) {
	tr, err := BuildTranscript(ctx, d.Store, graderConvID)
	if err != nil {
		return contract.RubricVerdict{}, err
	}
	resp, err := d.Model.Generate(ctx, ModelRequest{
		ConversationID:   graderConvID,
		ProviderAffinity: tr.ProviderAffinity,
		Transcript:       tr,
		Tools:            nil, // Read-only isolated session with zero mutating tools.
		ReadOnly:         true,
	}, nil)
	if err != nil {
		return contract.RubricVerdict{}, err
	}
	if resp.Usage != nil && d.Budget != nil {
		_, _ = d.Budget.RecordUsage(ctx, graderConvID, *resp.Usage)
	}
	respPayload, _ := json.Marshal(map[string]any{"text": resp.Text})
	if _, err := d.Store.AppendEntry(ctx, graderConvID, store.EntryAssistant, respPayload); err != nil {
		return contract.RubricVerdict{}, err
	}

	var verdict contract.RubricVerdict
	if err := json.Unmarshal([]byte(resp.Text), &verdict); err != nil {
		return contract.RubricVerdict{}, fmt.Errorf("durable/grader: invalid grader JSON verdict: %w", err)
	}
	verdict.Iteration = input.Iteration
	return verdict, nil
}

// YieldCheckRequest triggers OutcomeGrader at the pi.generation onYield intercept point.
type YieldCheckRequest struct {
	ConversationID  string
	TaskID          string
	Rubric          contract.RubricSpec
	TaskPrompt      string
	Deliverables    string
	CandidateOutput string
	Iteration       int
}

// YieldCheckResult instructs the generation phase to either finalize or loop for revision.
type YieldCheckResult struct {
	AllowYield           bool                   `json:"allowYield"`
	NeedsRevision        bool                   `json:"needsRevision"`
	MaxIterationsReached bool                   `json:"maxIterationsReached"`
	GraderConversationID string                 `json:"graderConversationId"`
	Verdict              contract.RubricVerdict `json:"verdict"`
}

// OutcomeGrader intercepts primary session completion at onYield and runs an isolated,
// read-only grader conversation against contract.RubricSpec up to maxIterations.
type OutcomeGrader struct {
	st     *store.Store
	driver GraderDriver
}

// NewOutcomeGrader creates an OutcomeGrader over st using driver.
func NewOutcomeGrader(st *store.Store, driver GraderDriver) *OutcomeGrader {
	return &OutcomeGrader{st: st, driver: driver}
}

// OnYield spins up a brand-new isolated read-only grader conversation (ParentID == ""),
// feeds only task prompt + rubric + deliverables, persists the RubricVerdict into pi.governance,
// and injects structured revision feedback into the primary conversation if unmetItems remain.
func (g *OutcomeGrader) OnYield(ctx context.Context, req YieldCheckRequest) (YieldCheckResult, error) {
	maxIter := req.Rubric.MaxIterations
	if maxIter <= 0 {
		maxIter = defaultRubricMaxIterations
	}
	iter := req.Iteration
	if iter <= 0 {
		iter = 1
	}

	// Create a completely isolated grader conversation (no ParentID link to primary agent reasoning!).
	primaryConv, err := g.st.GetConversation(ctx, req.ConversationID)
	if err != nil {
		return YieldCheckResult{}, err
	}

	graderConvID := store.NewUUIDv7(g.st.Clock().NowMs())
	graderInput := GraderInput{
		TaskPrompt:      req.TaskPrompt,
		RubricMarkdown:  req.Rubric.Markdown,
		Deliverables:    req.Deliverables,
		CandidateOutput: req.CandidateOutput,
		Iteration:       iter,
	}

	err = g.st.Mutate(ctx, func(tx *store.Tx) error {
		if _, err := tx.CreateConversation(ctx, store.Conversation{
			ID:               graderConvID,
			OwnerTaskID:      req.TaskID,
			ParentID:         "", // Strictly isolated context window.
			ProviderAffinity: primaryConv.ProviderAffinity,
		}); err != nil {
			return err
		}
		agentDoc, _ := json.Marshal(map[string]any{
			"role":     "outcome_grader",
			"readOnly": true,
			"tools":    []string{},
		})
		if _, err := tx.PutDocument(ctx, store.ScopeConversation, graderConvID, store.DocAgent, agentDoc); err != nil {
			return err
		}
		sysPayload, _ := json.Marshal(map[string]any{
			"text": "You are an independent read-only outcome grader. Evaluate deliverables strictly against the rubric.",
		})
		if _, err := tx.AppendEntry(ctx, graderConvID, store.EntrySystem, sysPayload); err != nil {
			return err
		}
		userPayload, _ := json.Marshal(graderInput)
		if _, err := tx.AppendEntry(ctx, graderConvID, store.EntryUser, userPayload); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return YieldCheckResult{}, err
	}

	verdict, err := g.driver.Grade(ctx, graderConvID, graderInput)
	if err != nil {
		return YieldCheckResult{}, err
	}
	verdict.Iteration = iter

	needsRevision := !verdict.Satisfied && iter < maxIter
	maxReached := !verdict.Satisfied && iter >= maxIter

	err = g.st.Mutate(ctx, func(tx *store.Tx) error {
		gov, err := loadGovernanceDocTx(ctx, tx, req.ConversationID)
		if err != nil {
			return err
		}
		vCopy := verdict
		gov.LastRubricVerdict = &vCopy
		gov.RubricHistory = append(gov.RubricHistory, vCopy)
		if err := saveGovernanceDocTx(ctx, tx, req.ConversationID, gov); err != nil {
			return err
		}

		if needsRevision {
			revPayload, _ := json.Marshal(map[string]any{
				"kind":       "outcome_revision",
				"iteration":  iter,
				"summary":    verdict.Summary,
				"unmetItems": verdict.UnmetItems,
				"text": fmt.Sprintf(
					"Outcome grader rejected submission (iteration %d/%d): %s. Unmet items: %v",
					iter, maxIter, verdict.Summary, verdict.UnmetItems,
				),
			})
			if _, err := tx.AppendEntry(ctx, req.ConversationID, store.EntryUser, revPayload); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return YieldCheckResult{}, err
	}

	return YieldCheckResult{
		AllowYield:           verdict.Satisfied || maxReached,
		NeedsRevision:        needsRevision,
		MaxIterationsReached: maxReached,
		GraderConversationID: graderConvID,
		Verdict:              verdict,
	}, nil
}
