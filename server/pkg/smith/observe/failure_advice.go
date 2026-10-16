package observe

import "vibevalley/pkg/smith/oar"

// FailureAdvice is recovery timing for a failed turn (or a
// RuntimeFailureError at open), based only on its failure class
// (observe/failure-advice.ts):
//   - Retry "now": try again with ordinary backoff (seconds to minutes);
//   - Retry "later": wait for a limit to reset, typically hours (quota, whose
//     resetsAt says when where the runtime reports it; a time already past means unknown);
//   - Retry "no": the same request will fail the same way.
//
// UserAction: a person has to act first (sign in, pay, pick another model,
// shorten the input). This says when another attempt may recover, not
// whether replaying input is safe: tools may already have run or files
// changed. Even runtime_exited means no input echo was observed, not proof
// the runtime never read it.
type FailureAdvice struct {
	Retry      string `json:"retry"`
	UserAction bool   `json:"userAction"`
}

var failureAdvice = map[oar.FailureClass]FailureAdvice{
	oar.FailureAuth:             {Retry: "no", UserAction: true},
	oar.FailureBilling:          {Retry: "no", UserAction: true},
	oar.FailureModelUnavailable: {Retry: "no", UserAction: true},
	oar.FailureInputTooLarge:    {Retry: "no", UserAction: true},
	oar.FailureRateLimited:      {Retry: "now"},
	oar.FailureOverloaded:       {Retry: "now"},
	oar.FailureProvider:         {Retry: "now"},
	oar.FailureRuntimeExited:    {Retry: "now"},
	oar.FailureQuota:            {Retry: "later"},
	oar.FailureInvalidRequest:   {Retry: "no"},
	// The host's own limit or schema: the same request stops the same way until the host changes it.
	oar.FailureLimitReached: {Retry: "no"},
	oar.FailureOutputSchema: {Retry: "no"},
	oar.FailureUnknown:      {Retry: "no"},
}

// FailureAdviceOf is the recovery timing for failure; no guarantee that
// replaying a turn is safe. False for a class this version does not know.
func FailureAdviceOf(failure oar.FailureClass) (FailureAdvice, bool) {
	advice, ok := failureAdvice[failure]
	return advice, ok
}
