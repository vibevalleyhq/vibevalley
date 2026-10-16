package grok

import (
	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// A prompt grok answered with an error (failure.ts,
// docs/spec/runtime-matrix.md#opencode-kimi-grok-antigravity-acp), observed
// on 1.0.46 against a scripted provider: -32003 "Rate limited" for every 429
// (throttling, a usage limit, an exhausted balance: grok's code does not
// tell them apart); otherwise -32603 "Internal error", whose cause is the
// `error_type` of the `retry_state` update that ended grok's retries.

const codeRateLimited = -32003

var errorTypes = map[string]oar.FailureClass{
	"auth":           oar.FailureAuth,
	"rate_limited":   oar.FailureRateLimited,
	"context_length": oar.FailureInputTooLarge,
	"api":            oar.FailureProvider,
}

// finalRetryState is the last `retry_state` update that ended grok's retries (`failed` or `exhausted`).
func finalRetryState(frames []oar.FrameBody) jsonx.Record {
	for index := len(frames) - 1; index >= 0; index-- {
		frame := frames[index]
		if frame.Type != "_x.ai/session_notification" {
			continue
		}
		update := jsonx.AsRecord(jsonx.ParseRecord(frame.Native)["update"])
		if update["sessionUpdate"] == "retry_state" && (update["type"] == "failed" || update["type"] == "exhausted") {
			return update
		}
	}
	return nil
}

// FailureOutcome reads grok's codes and retry notifications; nil leaves the
// failure to the generic rules.
func FailureOutcome(err error, frames []oar.FrameBody) *oar.TurnOutcome {
	reason := acp.ErrorReason(err)
	if code, ok := acp.RPCErrorCode(err); ok && code == codeRateLimited {
		outcome := oar.Failed(oar.FailureRateLimited, reason)
		return &outcome
	}
	update := finalRetryState(frames)
	errorType, _ := update["error_type"].(string)
	named, ok := errorTypes[errorType]
	if !ok {
		return nil
	}
	outcome := oar.Failed(named, reason)
	return &outcome
}

// PromptOutcome reads grok's answer: it validates its schema and reports
// either a value or a typed error field, even with end_turn.
func PromptOutcome(response jsonx.Record) *oar.TurnOutcome {
	if response["stopReason"] == "cancelled" {
		outcome := oar.AbortedOutcome()
		return &outcome
	}
	meta := jsonx.AsRecord(response["_meta"])
	if failure, ok := meta["structuredOutputError"].(string); ok {
		outcome := oar.Failed(oar.FailureOutputSchema, failure)
		return &outcome
	}
	outcome := oar.Completed()
	if value, ok := meta["structuredOutput"]; ok {
		outcome.StructuredOutput = jsonx.Marshal(value)
	}
	return &outcome
}
