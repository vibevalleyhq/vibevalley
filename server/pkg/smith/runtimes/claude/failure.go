package claude

import (
	"math"
	"strings"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// A failed claude turn, classified from what claude says (failure.ts,
// docs/spec/runtime-matrix.md#claude): the category on the turn's error
// assistant frame (error), then the result's terminal_reason and
// api_error_status. The declared categories no run produced fall through to
// the status. A rate_limit while claude's latest rate_limit_event says a
// subscription limit refuses requests until a named reset is quota with
// that resetsAt (claudeLimitReset); without one it stays rate_limited.

// claudeCategories are the categories observed, by what they mean;
// server_error is decided by its status (a 529 is overload).
var claudeCategories = map[string]oar.FailureClass{
	"authentication_failed": oar.FailureAuth,
	"model_not_found":       oar.FailureModelUnavailable,
	"rate_limit":            oar.FailureRateLimited,
	"billing_error":         oar.FailureBilling,
	"invalid_request":       oar.FailureInvalidRequest,
}

// claudeSubtypes are result subtypes for a limit or schema the host set
// (#339): the session's own options stopped the turn.
var claudeSubtypes = map[string]oar.FailureClass{
	"error_max_turns":                     oar.FailureLimitReached,
	"error_max_budget_usd":                oar.FailureLimitReached,
	"error_max_structured_output_retries": oar.FailureOutputSchema,
}

// claudeFailureFacts is what claude's error frames say about one failed turn.
type claudeFailureFacts struct {
	// The error of the turn's last root assistant frame; "" when none.
	Category string
	// The result's api_error_status: the HTTP status, nil when no request was sent.
	Status *int
	// The result's terminal_reason.
	TerminalReason string
	// The result's subtype when it is not success.
	Subtype string
	// The reset of the limit claude's latest rate_limit_event says refuses requests; "" when none does.
	LimitResetsAt string
}

// claudeLimitReset is when the subscription limit claude reports refusing
// requests resets: a rate_limit_event's rate_limit_info with status
// "rejected" and its resetsAt, unix seconds. claude sends one whenever its
// view of the limits changes, so the latest event stands until another
// replaces it. "" when the limit refuses nothing, when paid overage still
// takes the requests (overageStatus allowed or allowed_warning), or when
// the event names no reset. The time is kept as claude sent it; no clock is read.
func claudeLimitReset(info jsonx.Record) string {
	if info["status"] != "rejected" || info["overageStatus"] == "allowed" || info["overageStatus"] == "allowed_warning" {
		return ""
	}
	seconds, ok := jsonx.Num(info, "resetsAt")
	if !ok {
		return ""
	}
	ms := math.Trunc(seconds * 1000)
	if math.Abs(ms) > 8.64e15 {
		return ""
	}
	return shared.UtcInstantFromDate(time.UnixMilli(int64(ms)))
}

// claudeResultReason is an error result's own words: the subtype, then
// claude's errors text when it gives any (#339). subtype "" is none.
func claudeResultReason(subtype string, errors any) string {
	var parts []string
	for _, entry := range jsonx.AsList(errors) {
		if text, ok := entry.(string); ok && text != "" {
			parts = append(parts, text)
		}
	}
	detail := strings.Join(parts, "; ")
	if subtype == "" {
		if detail != "" {
			return detail
		}
		return "error"
	}
	if detail != "" {
		return subtype + ": " + detail
	}
	return subtype
}

// claudeFailure classifies a failed claude turn whose result says reason.
func claudeFailure(reason string, facts claudeFailureFacts) oar.TurnOutcome {
	failed := func(failure oar.FailureClass) oar.TurnOutcome {
		outcome := oar.Failed(failure, reason)
		outcome.Status = facts.Status
		return outcome
	}
	if facts.TerminalReason == "prompt_too_long" {
		return failed(oar.FailureInputTooLarge)
	}
	if limit, ok := claudeSubtypes[facts.Subtype]; ok && facts.Subtype != "" {
		return failed(limit)
	}
	if facts.Category == "authentication_failed" {
		// No request sent: no credential at all ("Not logged in"). A 401: refused.
		outcome := oar.Failed(oar.FailureAuth, reason)
		if facts.Status == nil {
			outcome.Credential = "missing"
			return outcome
		}
		outcome.Status = facts.Status
		if *facts.Status == 401 {
			outcome.Credential = "rejected"
		}
		return outcome
	}
	if facts.Category == "rate_limit" && facts.LimitResetsAt != "" {
		// A subscription limit refuses requests until a reset claude named: a usage limit, not throttling.
		outcome := failed(oar.FailureQuota)
		outcome.ResetsAt = facts.LimitResetsAt
		return outcome
	}
	if named, ok := claudeCategories[facts.Category]; ok && facts.Category != "" {
		return failed(named)
	}
	if facts.Status == nil {
		return failed(oar.FailureUnknown)
	}
	// A 400 with no category of its own: Anthropic's spend limit says so only in words.
	if *facts.Status == 400 {
		if class, ok := shared.AnthropicLimitText(reason); ok {
			return failed(class)
		}
		return failed(oar.FailureInvalidRequest)
	}
	return failed(shared.FailureFromStatus(*facts.Status))
}
