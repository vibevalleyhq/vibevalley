package acp

import (
	"errors"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// Failures an ACP agent reports as JSON-RPC errors (failure.ts,
// docs/spec/runtime-matrix.md#opencode-kimi-grok-antigravity-acp). ACP's
// `RequestError.authRequired` is -32000: an `auth` failure that does not say
// whether the login was missing or refused. An invalid-params answer
// (-32602) to the call that selects the model refuses the model. Anything
// else is the profile's to read (grok's own codes) or, as the last resort,
// its words.

const (
	codeAuthRequired  = -32000
	codeInvalidParams = -32602
)

// RPCErrorCode is the JSON-RPC error code an ACP request was answered with, if it was.
func RPCErrorCode(err error) (int, bool) {
	var failure *RequestError
	if !errors.As(err, &failure) {
		return 0, false
	}
	return failure.Code, true
}

func requestErrorCause(err error) error {
	var failure *RequestError
	if errors.As(err, &failure) && failure.Cause != nil {
		return failure.Cause
	}
	return err
}

// OpenFailure is an open step's error as session() rejects with it: a
// refused login (or, for the "model" step, a refused model) becomes a
// RuntimeFailureError whose Cause is the native answer.
func OpenFailure(err error, step string) error {
	code, ok := RPCErrorCode(err)
	if !ok {
		return err
	}
	if code == codeAuthRequired {
		return &oar.RuntimeFailureError{Failure: oar.FailureAuth, Reason: err.Error(), Cause: requestErrorCause(err)}
	}
	if step == "model" && code == codeInvalidParams {
		return &oar.RuntimeFailureError{Failure: oar.FailureModelUnavailable, Reason: err.Error(), Cause: requestErrorCause(err)}
	}
	return err
}

// ResumeFailure reads a failed native resume/load call under its runtime's
// missing-target rule.
func ResumeFailure(err error, method, sessionID string, isNotFound func(native jsonx.Record) bool) error {
	// Auth refusals retain their type even if a list was empty.
	if failure := OpenFailure(err, "open"); failure != err {
		return failure
	}
	var requestErr *RequestError
	if errors.As(err, &requestErr) && requestErr.Cause != nil && requestErr.Cause.Method == method && requestErr.Cause.Native != nil && isNotFound(requestErr.Cause.Native) {
		return &oar.SessionNotFoundError{SessionID: sessionID, Message: err.Error(), Method: method, Native: jsonx.Marshal(requestErr.Cause.Native)}
	}
	return err
}

// FailureReader reads a failed prompt the generic rules do not (grok's
// codes and its retry notifications); nil leaves it to them.
type FailureReader func(err error, turnFrames []oar.FrameBody) *oar.TurnOutcome

// ErrorReason is an RPC error's words: its message, and its `data` when that
// is text (grok puts the provider's answer there).
func ErrorReason(err error) string {
	if err == nil {
		return "ACP prompt failed"
	}
	var failure *RequestError
	if errors.As(err, &failure) && failure != nil {
		if text, ok := failure.Data.(string); ok && text != "" {
			return failure.Message + ": " + text
		}
		return failure.Message
	}
	return err.Error()
}

// FailureOutcome is the outcome a rejected prompt request reports.
func FailureOutcome(err error, turnFrames []oar.FrameBody, reader FailureReader) oar.TurnOutcome {
	reason := ErrorReason(err)
	var acpErr *Error
	if errors.As(err, &acpErr) && acpErr.Kind == KindProcessExited {
		return oar.Failed(oar.FailureRuntimeExited, reason)
	}
	if code, ok := RPCErrorCode(err); ok && code == codeAuthRequired {
		return oar.Failed(oar.FailureAuth, reason)
	}
	if reader != nil {
		if outcome := reader(err, turnFrames); outcome != nil {
			return *outcome
		}
	}
	return oar.Failed(shared.ClassifyFailure(reason), reason)
}
