package codex

import (
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// A failed codex turn, classified from its `turn.error.codexErrorInfo`
// (failure.ts; docs/spec/runtime-matrix.md#codex), observed on 0.160.1
// against a scripted provider: a named value, or a transport variant carrying
// the HTTP status. `other` (an HTTP 400 codex does not name) carries the
// provider's JSON body as its message, read for its code. A usage limit and
// an exhausted credit balance are the same `usageLimitExceeded`, so both are
// `quota`. Declared values no run produced (`unauthorized`, `badRequest`,
// `sessionBudgetExceeded`, `cyberPolicy`, …) stay `unknown`.

var namedFailures = map[string]oar.FailureClass{
	"usageLimitExceeded":    oar.FailureQuota,
	"rateLimitExceeded":     oar.FailureRateLimited,
	"serverOverloaded":      oar.FailureOverloaded,
	"internalServerError":   oar.FailureProvider,
	"contextWindowExceeded": oar.FailureInputTooLarge,
}

var transportFailures = []string{"httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"}

// fromInfo is what `codexErrorInfo` says: a class, and the HTTP status a transport variant carries.
func fromInfo(info any, message string) shared.Classified {
	if name, ok := info.(string); ok {
		if named, known := namedFailures[name]; known {
			return shared.Classified{Failure: named}
		}
		if name == "other" {
			if failure, read := shared.FailureFromErrorBody(message); read {
				return shared.Classified{Failure: failure}
			}
		}
		return shared.Classified{Failure: oar.FailureUnknown}
	}
	record := jsonx.AsRecord(info)
	for _, variant := range transportFailures {
		if status, ok := jsonx.Num(jsonx.AsRecord(record[variant]), "httpStatusCode"); ok {
			code := int(status)
			return shared.Classified{Failure: shared.FailureFromStatus(code), Status: &code}
		}
	}
	return shared.Classified{Failure: oar.FailureUnknown}
}

// codexFailure classifies a failed codex turn whose reason is reason, from its `turn.error`.
func codexFailure(reason string, turnError any) oar.TurnOutcome {
	failure := jsonx.AsRecord(turnError)
	message, _ := failure["message"].(string)
	classified := fromInfo(failure["codexErrorInfo"], message)
	return oar.TurnOutcome{Kind: "failed", Reason: reason, Failure: classified.Failure, Status: classified.Status}
}
