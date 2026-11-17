package durable

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"

	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
)

const (
	TaskKindGeneration = "pi.generation"

	PhaseGenerate   = "generate"
	PhaseToolTurn   = "tool_turn"
	PhaseYieldCheck = "yield_check"
)

// ToolExecutor runs an authorized tool invocation and returns its JSON/text result payload.
type ToolExecutor interface {
	Execute(ctx context.Context, conversationID string, call ToolCall) (json.RawMessage, error)
}

// ToolExecutorFunc adapts a function to ToolExecutor.
type ToolExecutorFunc func(ctx context.Context, conversationID string, call ToolCall) (json.RawMessage, error)

func (f ToolExecutorFunc) Execute(ctx context.Context, conversationID string, call ToolCall) (json.RawMessage, error) {
	return f(ctx, conversationID, call)
}

// DeliverablesFunc collects artifacts/diffs from the workspace for OutcomeGrader onYield.
type DeliverablesFunc func(ctx context.Context, conversationID string) (string, error)

// GenerationDeps bundles the governance and execution dependencies for pi.generation.
type GenerationDeps struct {
	Store        *store.Store
	Model        ModelClient
	Tools        ToolExecutor
	Compactor    *Compactor
	Budget       *BudgetGate
	Permissions  *PermissionEvaluator
	Grader       *OutcomeGrader
	Deliverables DeliverablesFunc
}

// GenerationCheckpoint persists the explicit phase state of a pi.generation task.
type GenerationCheckpoint struct {
	ConversationID  string               `json:"conversationId"`
	TaskPrompt      string               `json:"taskPrompt,omitempty"`
	Tools           []ToolSpec           `json:"tools,omitempty"`
	Rubric          *contract.RubricSpec `json:"rubric,omitempty"`
	Deliverables    string               `json:"deliverables,omitempty"`
	GraderIteration int                  `json:"graderIteration,omitempty"`
	LastOutput      string               `json:"lastOutput,omitempty"`
	PendingCalls    []ToolCall           `json:"pendingCalls,omitempty"`
	CallIndex       int                  `json:"callIndex,omitempty"`
	ParkedCall      *ToolCall            `json:"parkedCall,omitempty"`
}

// GenerationResult is saved to durable_task.result_json when pi.generation finishes.
type GenerationResult struct {
	Output               string                  `json:"output"`
	Iterations           int                     `json:"iterations"`
	RubricVerdict        *contract.RubricVerdict `json:"rubricVerdict,omitempty"`
	MaxIterationsReached bool                    `json:"maxIterationsReached,omitempty"`
}

// RegisterGenerationPhases registers the pi.generation phase state machine on sched.
func RegisterGenerationPhases(sched *Scheduler, deps GenerationDeps) {
	if deps.Compactor == nil {
		deps.Compactor = NewCompactor(deps.Store, nil, DefaultCompactionThresholds())
	}
	sched.RegisterPhase(TaskKindGeneration, PhaseGenerate, makeGeneratePhase(deps))
	sched.RegisterPhase(TaskKindGeneration, PhaseToolTurn, makeToolTurnPhase(deps))
	sched.RegisterPhase(TaskKindGeneration, PhaseYieldCheck, makeYieldCheckPhase(deps))
}

func makeGeneratePhase(deps GenerationDeps) PhaseFunc {
	return func(ctx context.Context, tc *TaskContext) (Transition, error) {
		var cp GenerationCheckpoint
		if err := tc.UnmarshalCheckpoint(&cp); err != nil {
			return Transition{}, err
		}
		convID := cp.ConversationID
		if convID == "" {
			convID = tc.Task().ConversationID
			cp.ConversationID = convID
		}

		// 1. Session Budget Gate check BEFORE launching a new model request.
		if deps.Budget != nil {
			snap, err := deps.Budget.CheckBeforeGeneration(ctx, convID, tc.Task().ID)
			if err != nil {
				return Transition{}, err
			}
			if snap.Reached {
				return TransSleep(PhaseGenerate, cp, SleepOptions{SignalName: SignalBudgetUpdated}), nil
			}
		}

		// 2. Soft (background) or Hard (blocking) context compaction before generation.
		if deps.Compactor != nil {
			if _, err := deps.Compactor.MaybeCompactBeforeGenerate(ctx, convID); err != nil {
				return Transition{}, err
			}
		}

		// 3. Build transcript with pinned provider_affinity and tail pi.system deltas.
		resp, err := runModelWithOverflowRetry(ctx, deps, convID, cp.Tools)
		if err != nil {
			return Transition{}, err
		}

		// 4. Record usage (even if it pushes cumulative spend over budget, current tool turn finishes first)
		// and append immutable pi.assistant entry.
		if resp.Usage != nil && deps.Budget != nil {
			if _, err := deps.Budget.RecordUsage(ctx, convID, *resp.Usage); err != nil {
				return Transition{}, err
			}
		}
		assistantPayload, err := json.Marshal(map[string]any{
			"text":      resp.Text,
			"toolCalls": resp.ToolCalls,
		})
		if err != nil {
			return Transition{}, err
		}
		if _, err := deps.Store.AppendEntry(ctx, convID, store.EntryAssistant, assistantPayload); err != nil {
			return Transition{}, err
		}

		cp.LastOutput = resp.Text
		if len(resp.ToolCalls) > 0 {
			cp.PendingCalls = resp.ToolCalls
			cp.CallIndex = 0
			cp.ParkedCall = nil
			return TransNext(PhaseToolTurn, cp), nil
		}
		return TransNext(PhaseYieldCheck, cp), nil
	}
}

func runModelWithOverflowRetry(ctx context.Context, deps GenerationDeps, convID string, tools []ToolSpec) (ModelResponse, error) {
	tr, err := BuildTranscript(ctx, deps.Store, convID)
	if err != nil {
		return ModelResponse{}, err
	}
	var acc string
	onDelta := func(chunk string) {
		acc += chunk
		liveBytes, _ := json.Marshal(map[string]any{"text": acc})
		_ = deps.Store.PutDocumentDeferred(ctx, store.ScopeConversation, convID, store.DocLive, liveBytes)
	}

	resp, err := deps.Model.Generate(ctx, ModelRequest{
		ConversationID:   convID,
		ProviderAffinity: tr.ProviderAffinity,
		Transcript:       tr,
		Tools:            tools,
	}, onDelta)
	if errors.Is(err, ErrContextOverflow) && deps.Compactor != nil {
		// Level 4 compaction: emergency overflow fold and immediate retry.
		if _, compErr := deps.Compactor.Compact(ctx, convID, CompactionOverflow, 0); compErr != nil {
			return ModelResponse{}, compErr
		}
		tr, err = BuildTranscript(ctx, deps.Store, convID)
		if err != nil {
			return ModelResponse{}, err
		}
		acc = ""
		resp, err = deps.Model.Generate(ctx, ModelRequest{
			ConversationID:   convID,
			ProviderAffinity: tr.ProviderAffinity,
			Transcript:       tr,
			Tools:            tools,
		}, onDelta)
	}
	return resp, err
}

func makeToolTurnPhase(deps GenerationDeps) PhaseFunc {
	return func(ctx context.Context, tc *TaskContext) (Transition, error) {
		var cp GenerationCheckpoint
		if err := tc.UnmarshalCheckpoint(&cp); err != nil {
			return Transition{}, err
		}
		convID := cp.ConversationID
		if convID == "" {
			convID = tc.Task().ConversationID
		}

		// Resume from parked always_ask / auto->indeterminate decision if present.
		if cp.ParkedCall != nil {
			call := *cp.ParkedCall
			var dec PermissionDecision
			if sig := tc.Signal(); sig != nil {
				_ = json.Unmarshal(sig.PayloadJSON, &dec)
			}
			if dec.Approved {
				if err := executeAndAppendToolResult(ctx, deps, convID, call); err != nil {
					return Transition{}, err
				}
			} else {
				reason := dec.Reason
				if reason == "" {
					reason = "permission denied by user"
				}
				if err := appendToolErrorResult(ctx, deps.Store, convID, call, reason, true); err != nil {
					return Transition{}, err
				}
			}
			cp.ParkedCall = nil
			cp.CallIndex++
		}

		for cp.CallIndex < len(cp.PendingCalls) {
			call := cp.PendingCalls[cp.CallIndex]
			var eval contract.PermissionEvaluation
			if deps.Permissions != nil {
				var err error
				eval, err = deps.Permissions.Evaluate(ctx, convID, call)
				if err != nil {
					return Transition{}, err
				}
			} else {
				eval = contract.PermissionEvaluation{
					ToolName:          call.ToolName,
					Policy:            contract.PolicyAlwaysAllow,
					Verdict:           contract.VerdictAllow,
					ClientOverridable: true,
				}
			}

			switch eval.Verdict {
			case contract.VerdictAllow:
				if err := executeAndAppendToolResult(ctx, deps, convID, call); err != nil {
					return Transition{}, err
				}
				cp.CallIndex++

			case contract.VerdictDeny:
				msg := fmt.Sprintf("permission denied (%s): %s", eval.Policy, eval.Reason)
				if err := appendToolErrorResult(ctx, deps.Store, convID, call, msg, eval.ClientOverridable); err != nil {
					return Transition{}, err
				}
				cp.CallIndex++

			case contract.VerdictAsk:
				if deps.Permissions != nil {
					if err := deps.Permissions.Park(ctx, convID, tc.Task().ID, call, eval); err != nil {
						return Transition{}, err
					}
				}
				cp.ParkedCall = &call
				return TransSleep(PhaseToolTurn, cp, SleepOptions{SignalName: SignalPermissionDecision}), nil
			}
		}

		cp.PendingCalls = nil
		cp.CallIndex = 0
		return TransNext(PhaseGenerate, cp), nil
	}
}

func makeYieldCheckPhase(deps GenerationDeps) PhaseFunc {
	return func(ctx context.Context, tc *TaskContext) (Transition, error) {
		var cp GenerationCheckpoint
		if err := tc.UnmarshalCheckpoint(&cp); err != nil {
			return Transition{}, err
		}
		if cp.Rubric == nil || cp.Rubric.Markdown == "" || deps.Grader == nil {
			return TransComplete(GenerationResult{
				Output:     cp.LastOutput,
				Iterations: cp.GraderIteration,
			}), nil
		}

		cp.GraderIteration++
		deliverables := cp.Deliverables
		if deps.Deliverables != nil {
			d, err := deps.Deliverables(ctx, cp.ConversationID)
			if err != nil {
				return Transition{}, err
			}
			deliverables = d
		}

		res, err := deps.Grader.OnYield(ctx, YieldCheckRequest{
			ConversationID:  cp.ConversationID,
			TaskID:          tc.Task().ID,
			Rubric:          *cp.Rubric,
			TaskPrompt:      cp.TaskPrompt,
			Deliverables:    deliverables,
			CandidateOutput: cp.LastOutput,
			Iteration:       cp.GraderIteration,
		})
		if err != nil {
			return Transition{}, err
		}
		if res.NeedsRevision {
			return TransNext(PhaseGenerate, cp), nil
		}
		v := res.Verdict
		return TransComplete(GenerationResult{
			Output:               cp.LastOutput,
			Iterations:           cp.GraderIteration,
			RubricVerdict:        &v,
			MaxIterationsReached: res.MaxIterationsReached,
		}), nil
	}
}

func executeAndAppendToolResult(ctx context.Context, deps GenerationDeps, convID string, call ToolCall) error {
	if deps.Tools == nil {
		return appendToolErrorResult(ctx, deps.Store, convID, call, "no tool executor configured", true)
	}
	out, execErr := deps.Tools.Execute(ctx, convID, call)
	if execErr != nil {
		return appendToolErrorResult(ctx, deps.Store, convID, call, execErr.Error(), true)
	}
	if len(out) == 0 {
		out = json.RawMessage(`{}`)
	}
	payload, err := json.Marshal(map[string]any{
		"toolCallId": call.ID,
		"toolName":   call.ToolName,
		"isMcp":      call.IsMCP,
		"ok":         true,
		"output":     json.RawMessage(out),
	})
	if err != nil {
		return err
	}
	_, err = deps.Store.AppendEntry(ctx, convID, store.EntryToolResult, payload)
	return err
}

func appendToolErrorResult(ctx context.Context, st *store.Store, convID string, call ToolCall, errMsg string, overridable bool) error {
	payload, err := json.Marshal(map[string]any{
		"toolCallId":        call.ID,
		"toolName":          call.ToolName,
		"isMcp":             call.IsMCP,
		"ok":                false,
		"error":             errMsg,
		"clientOverridable": overridable,
	})
	if err != nil {
		return err
	}
	_, err = st.AppendEntry(ctx, convID, store.EntryToolResult, payload)
	return err
}
