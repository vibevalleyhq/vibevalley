// Package acp is the Go port of packages/oar/src/shared/acp: the Agent
// Client Protocol layer shared by the grok, kimi, opencode and antigravity
// runtimes. TS drives ACP through the official @agentclientprotocol/sdk; Go
// speaks JSON-RPC 2.0 over newline-delimited stdio itself (process.go),
// keeping the SDK behaviors the TS code relies on. One Go file per TS file.
package acp

import (
	"fmt"
	"time"
)

// ErrorKind is "timeout" or "process_exited" (errors.ts AcpErrorKind).
type ErrorKind string

const (
	KindTimeout       ErrorKind = "timeout"
	KindProcessExited ErrorKind = "process_exited"
)

// Error is the one ACP transport error, with a discriminant (errors.ts AcpError).
type Error struct {
	Kind    ErrorKind
	Message string
	// nil: no exit code (a signal, or not an exit).
	ExitCode *int
	// "" when not about one request (TS null).
	Method string
	// 0 when not a timeout (TS null).
	Timeout time.Duration
}

func (e *Error) Error() string { return e.Message }

// RequestTimeoutError is the deadline of one request passing.
func RequestTimeoutError(method string, timeout time.Duration) *Error {
	return &Error{Kind: KindTimeout, Message: fmt.Sprintf("ACP request %s timed out after %dms", method, timeout.Milliseconds()), Method: method, Timeout: timeout}
}

// ProcessExitedError is the agent process gone; exitCode nil when it had none.
func ProcessExitedError(exitCode *int) *Error {
	message := "ACP process exited"
	if exitCode != nil {
		message = fmt.Sprintf("ACP process exited with code %d", *exitCode)
	}
	return &Error{Kind: KindProcessExited, Message: message, ExitCode: exitCode}
}
