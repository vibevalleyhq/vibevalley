package durable

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"

	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
)

// SignalPermissionDecision wakes a tool execution parked under always_ask or auto->indeterminate.
const SignalPermissionDecision = "permission.decision"

// PermissionConfig configures default tool permission policies and per-tool overrides.
type PermissionConfig struct {
	BuiltinDefault contract.PermissionPolicy            `json:"builtinDefault"`
	MCPDefault     contract.PermissionPolicy            `json:"mcpDefault"`
	Overrides      map[string]contract.PermissionPolicy `json:"overrides,omitempty"`
}

// DefaultPermissionConfig sets built-in tools to always_allow and external MCP tools to always_ask.
func DefaultPermissionConfig() PermissionConfig {
	return PermissionConfig{
		BuiltinDefault: contract.PolicyAlwaysAllow,
		MCPDefault:     contract.PolicyAlwaysAsk,
		Overrides:      make(map[string]contract.PermissionPolicy),
	}
}

// PolicyFor resolves the effective PermissionPolicy for toolName.
func (c PermissionConfig) PolicyFor(toolName string, isMCP bool) contract.PermissionPolicy {
	if c.Overrides != nil {
		if pol, ok := c.Overrides[toolName]; ok && pol != "" {
			return pol
		}
	}
	if isMCP || strings.HasPrefix(toolName, "mcp:") || strings.HasPrefix(toolName, "mcp_") {
		if c.MCPDefault != "" {
			return c.MCPDefault
		}
		return contract.PolicyAlwaysAsk
	}
	if c.BuiltinDefault != "" {
		return c.BuiltinDefault
	}
	return contract.PolicyAlwaysAllow
}

// RiskLevel classifies dynamic auto-mode tool authorization risk.
type RiskLevel string

const (
	RiskSafe          RiskLevel = "safe"
	RiskHigh          RiskLevel = "high_risk"
	RiskIndeterminate RiskLevel = "indeterminate"
)

// ClassifierRequest contains ONLY trusted inputs for auto permission evaluation.
// Untrusted pi.tool_result, web fetch content, and MCP responses are strictly excluded.
type ClassifierRequest struct {
	ToolName           string          `json:"toolName"`
	ArgsJSON           json.RawMessage `json:"argsJson"`
	TrustedUserIntents []string        `json:"trustedUserIntents"`
	RecentToolCalls    []string        `json:"recentToolCalls,omitempty"`
}

// RiskAssessment is returned by a RiskClassifier.
type RiskAssessment struct {
	Risk   RiskLevel `json:"risk"`
	Reason string    `json:"reason"`
}

// RiskClassifier dynamically evaluates tool calls under PolicyAuto.
type RiskClassifier interface {
	Classify(ctx context.Context, req ClassifierRequest) (RiskAssessment, error)
}

// RiskClassifierFunc adapts a function to RiskClassifier.
type RiskClassifierFunc func(ctx context.Context, req ClassifierRequest) (RiskAssessment, error)

func (f RiskClassifierFunc) Classify(ctx context.Context, req ClassifierRequest) (RiskAssessment, error) {
	return f(ctx, req)
}

// PermissionDecision represents a user's approval or denial sent to resolve a parked tool call.
type PermissionDecision struct {
	ToolCallID string `json:"toolCallId"`
	Approved   bool   `json:"approved"`
	Reason     string `json:"reason,omitempty"`
}

// ExtractTrustedUserIntent extracts authentic human intent strictly from pi.user entries.
// All pi.tool_result, web fetch results, MCP responses, and assistant outputs are filtered out
// to defeat indirect prompt injection attacks.
func ExtractTrustedUserIntent(entries []store.Entry) []string {
	var intents []string
	for _, e := range entries {
		if e.Kind != store.EntryUser {
			continue
		}
		text := extractUserText(e.PayloadJSON)
		if text != "" {
			intents = append(intents, text)
		}
	}
	return intents
}

func extractUserText(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	var asStr string
	if json.Unmarshal(raw, &asStr) == nil {
		return strings.TrimSpace(asStr)
	}
	var obj map[string]any
	if json.Unmarshal(raw, &obj) != nil {
		return ""
	}
	// Reject explicitly marked untrusted/synthetic tool payloads if any caller tagged source.
	if src, ok := obj["source"].(string); ok {
		switch strings.ToLower(src) {
		case "tool_result", "web", "mcp", "untrusted":
			return ""
		}
	}
	for _, k := range []string{"text", "prompt", "content", "message"} {
		if s, ok := obj[k].(string); ok && strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}
	return ""
}

// PermissionEvaluator enforces always_allow, always_ask Park, and auto intent risk control.
type PermissionEvaluator struct {
	st         *store.Store
	cfg        PermissionConfig
	classifier RiskClassifier
	alertSink  AlertSink
}

// NewPermissionEvaluator constructs a PermissionEvaluator backed by st.
func NewPermissionEvaluator(st *store.Store, cfg PermissionConfig, classifier RiskClassifier, alertSink AlertSink) *PermissionEvaluator {
	if classifier == nil {
		classifier = DefaultRiskClassifier{}
	}
	return &PermissionEvaluator{
		st:         st,
		cfg:        cfg,
		classifier: classifier,
		alertSink:  alertSink,
	}
}

// Evaluate authorizes a tool call against configured policy, records evaluated_permission
// in pi.governance, and (for non-overridable deny) marks the call ID hard-denied.
func (p *PermissionEvaluator) Evaluate(ctx context.Context, conversationID string, call ToolCall) (contract.PermissionEvaluation, error) {
	policy := p.cfg.PolicyFor(call.ToolName, call.IsMCP)
	var eval contract.PermissionEvaluation

	switch policy {
	case contract.PolicyAlwaysAllow:
		eval = contract.PermissionEvaluation{
			ToolName:          call.ToolName,
			Policy:            policy,
			Verdict:           contract.VerdictAllow,
			Reason:            "policy_always_allow",
			ClientOverridable: true,
		}

	case contract.PolicyAlwaysAsk:
		eval = contract.PermissionEvaluation{
			ToolName:          call.ToolName,
			Policy:            policy,
			Verdict:           contract.VerdictAsk,
			Reason:            "policy_always_ask",
			ClientOverridable: true,
		}

	case contract.PolicyAuto:
		entries, err := p.st.GetVisibleEntries(ctx, conversationID)
		if err != nil {
			return contract.PermissionEvaluation{}, err
		}
		trustedIntents := ExtractTrustedUserIntent(entries)
		recentCalls := extractRecentToolNames(entries, 8)
		assessment, err := p.classifier.Classify(ctx, ClassifierRequest{
			ToolName:           call.ToolName,
			ArgsJSON:           call.ArgsJSON,
			TrustedUserIntents: trustedIntents,
			RecentToolCalls:    recentCalls,
		})
		if err != nil {
			eval = contract.PermissionEvaluation{
				ToolName:          call.ToolName,
				Policy:            policy,
				Verdict:           contract.VerdictAsk,
				Reason:            "classifier_error_fallback_ask",
				ClientOverridable: true,
			}
		} else {
			switch assessment.Risk {
			case RiskSafe:
				eval = contract.PermissionEvaluation{
					ToolName:          call.ToolName,
					Policy:            policy,
					Verdict:           contract.VerdictAllow,
					Reason:            assessment.Reason,
					ClientOverridable: true,
				}
			case RiskHigh:
				eval = contract.PermissionEvaluation{
					ToolName:          call.ToolName,
					Policy:            policy,
					Verdict:           contract.VerdictDeny,
					Reason:            assessment.Reason,
					ClientOverridable: false,
				}
			default:
				eval = contract.PermissionEvaluation{
					ToolName:          call.ToolName,
					Policy:            policy,
					Verdict:           contract.VerdictAsk,
					Reason:            assessment.Reason,
					ClientOverridable: true,
				}
			}
		}

	default:
		eval = contract.PermissionEvaluation{
			ToolName:          call.ToolName,
			Policy:            policy,
			Verdict:           contract.VerdictAsk,
			Reason:            "unknown_policy_ask",
			ClientOverridable: true,
		}
	}

	if err := p.recordEvaluation(ctx, conversationID, call.ID, eval); err != nil {
		return contract.PermissionEvaluation{}, err
	}
	return eval, nil
}

func (p *PermissionEvaluator) recordEvaluation(ctx context.Context, conversationID, callID string, eval contract.PermissionEvaluation) error {
	return p.st.Mutate(ctx, func(tx *store.Tx) error {
		gov, err := loadGovernanceDocTx(ctx, tx, conversationID)
		if err != nil {
			return err
		}
		gov.EvaluatedPermissions = append(gov.EvaluatedPermissions, eval)
		if eval.Verdict == contract.VerdictDeny && !eval.ClientOverridable && callID != "" {
			if gov.HardDeniedCalls == nil {
				gov.HardDeniedCalls = make(map[string]bool)
			}
			gov.HardDeniedCalls[callID] = true
		}
		return saveGovernanceDocTx(ctx, tx, conversationID, gov)
	})
}

// Park writes a pending approval request to pi.inbox and notifies AlertSink so the UI/Dynamic Island
// can surface the approval card while the task transitions to sleeping.
func (p *PermissionEvaluator) Park(ctx context.Context, conversationID, taskID string, call ToolCall, eval contract.PermissionEvaluation) error {
	payload, _ := json.Marshal(map[string]any{
		"toolCall":   call,
		"evaluation": eval,
	})
	var emitted Alert
	err := p.st.Mutate(ctx, func(tx *store.Tx) error {
		al, err := persistAlertTx(ctx, tx, Alert{
			Kind:           AlertPermissionPark,
			TaskID:         taskID,
			ConversationID: conversationID,
			Title:          fmt.Sprintf("Permission required: %s", call.ToolName),
			Message:        eval.Reason,
			Payload:        payload,
			CreatedAtMs:    tx.NowMs(),
		})
		if err != nil {
			return err
		}
		emitted = al
		return nil
	})
	if err != nil {
		return err
	}
	if p.alertSink != nil {
		p.alertSink.OnAlert(emitted)
	}
	return nil
}

// ResolveDecision delivers a user approval or denial signal to wake a parked task.
// Attempting to override a hard-denied (ClientOverridable == false) call fails with ErrPermissionNotOverridable.
func (p *PermissionEvaluator) ResolveDecision(ctx context.Context, sched *Scheduler, conversationID, taskID string, decision PermissionDecision) error {
	doc, err := p.st.GetDocument(ctx, store.ScopeConversation, conversationID, store.DocGovernance)
	if err == nil && len(doc.StateJSON) > 0 {
		var gov GovernanceDocState
		if json.Unmarshal(doc.StateJSON, &gov) == nil && gov.HardDeniedCalls[decision.ToolCallID] {
			return ErrPermissionNotOverridable
		}
	}
	payload, err := json.Marshal(decision)
	if err != nil {
		return err
	}
	_, err = sched.SendSignal(ctx, store.Signal{
		TaskID:      taskID,
		SignalName:  SignalPermissionDecision,
		SignalKey:   decision.ToolCallID,
		PayloadJSON: payload,
	})
	return err
}

func extractRecentToolNames(entries []store.Entry, limit int) []string {
	var names []string
	for i := len(entries) - 1; i >= 0 && len(names) < limit; i-- {
		if entries[i].Kind != store.EntryAssistant {
			continue
		}
		var payload struct {
			ToolCalls []ToolCall `json:"toolCalls"`
		}
		if json.Unmarshal(entries[i].PayloadJSON, &payload) == nil {
			for _, tc := range payload.ToolCalls {
				names = append(names, tc.ToolName)
			}
		}
	}
	return names
}

// DefaultRiskClassifier provides deterministic high-risk detection when no external LLM classifier is wired.
// It inspects tool name and args strictly against TrustedUserIntents (never tool_result content).
type DefaultRiskClassifier struct{}

var highRiskTokens = []string{
	"delete production db",
	"drop database",
	"drop table",
	"truncate table",
	"rm -rf",
	"mkfs.",
	":(){",
	"curl ",
	"wget ",
	"printenv",
	"exfiltrate",
	"shutdown",
}

var safeReadTools = map[string]bool{
	"read_file": true,
	"list_dir":  true,
	"grep":      true,
	"search":    true,
	"glob":      true,
}

func (DefaultRiskClassifier) Classify(_ context.Context, req ClassifierRequest) (RiskAssessment, error) {
	if safeReadTools[req.ToolName] {
		return RiskAssessment{Risk: RiskSafe, Reason: "readonly_builtin"}, nil
	}
	argsLower := strings.ToLower(string(req.ArgsJSON))
	intentJoined := strings.ToLower(strings.Join(req.TrustedUserIntents, "\n"))

	for _, tok := range highRiskTokens {
		if strings.Contains(argsLower, tok) {
			// Even if mentioned, destructive DB/prod commands or piping curl require explicit user intent;
			// when missing from trusted pi.user entries, classify as high_risk hard deny!
			if !strings.Contains(intentJoined, tok) {
				return RiskAssessment{
					Risk:   RiskHigh,
					Reason: fmt.Sprintf("high_risk pattern %q not present in trusted user intent", strings.TrimSpace(tok)),
				}, nil
			}
		}
	}
	if req.ToolName == "web_fetch" && !strings.Contains(argsLower, "metadata") && !strings.Contains(argsLower, "169.254.169.254") {
		return RiskAssessment{Risk: RiskSafe, Reason: "benign_web_fetch"}, nil
	}
	return RiskAssessment{Risk: RiskIndeterminate, Reason: "requires_user_confirmation"}, nil
}
