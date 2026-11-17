package artifact

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

var (
	ErrNotFound            = errors.New("artifact: not found")
	ErrBlobNotFound        = errors.New("artifact: content blob not found")
	ErrInvalidSHA256       = errors.New("artifact: invalid sha256 digest")
	ErrCorruptedBlob       = errors.New("artifact: blob sha256 verification failed")
	ErrCompileFailed       = errors.New("artifact: bundle compilation failed")
	ErrInvalidBundle       = errors.New("artifact: invalid bundle input")
	ErrInvalidOrderKey     = errors.New("artifact: invalid fractional order key")
	ErrInvalidBlockOp      = errors.New("artifact: invalid block operation")
	ErrConflict            = errors.New("artifact: revision conflict")
	ErrStaleSuggestion     = errors.New("artifact: suggestion baseRev is stale")
	ErrSuggestionNotFound  = errors.New("artifact: suggestion not found")
	ErrSuggestionConflict  = errors.New("artifact: suggestion already resolved with different outcome")
	ErrVersionNotFound     = errors.New("artifact: version not found")
	ErrInvalidDisplayMode  = errors.New("artifact: invalid display mode")
	ErrHTMLPolicyViolation = errors.New("artifact: html security policy violation")
	ErrOriginForbidden     = errors.New("artifact: preview origin isolation rejected request")
	ErrMethodNotAllowed    = errors.New("artifact: method not allowed")
)

// Diagnostic captures a single compiler or policy failure with exact 1-based source location.
type Diagnostic struct {
	File       string `json:"file"`
	Line       int    `json:"line"`
	Column     int    `json:"column"`
	Length     int    `json:"length,omitempty"`
	LineText   string `json:"lineText,omitempty"`
	Message    string `json:"message"`
	Suggestion string `json:"suggestion,omitempty"`
}

// CompileError is a typed tool error carrying structured diagnostics so durable can trigger same-turn self-healing.
type CompileError struct {
	Cause       error        `json:"-"`
	Diagnostics []Diagnostic `json:"diagnostics"`
	DurationMs  int64        `json:"durationMs"`
}

func (e *CompileError) Error() string {
	base := ErrCompileFailed.Error()
	if e != nil && e.Cause != nil {
		base = e.Cause.Error()
	}
	if e == nil || len(e.Diagnostics) == 0 {
		return base
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "%s (%d diagnostic(s), %dms):", base, len(e.Diagnostics), e.DurationMs)
	for _, d := range e.Diagnostics {
		loc := d.File
		if loc == "" {
			loc = "<virtual>"
		}
		if d.Line > 0 {
			if d.Column > 0 {
				fmt.Fprintf(&sb, "\n  %s:%d:%d: %s", loc, d.Line, d.Column, d.Message)
			} else {
				fmt.Fprintf(&sb, "\n  %s:%d: %s", loc, d.Line, d.Message)
			}
		} else {
			fmt.Fprintf(&sb, "\n  %s: %s", loc, d.Message)
		}
	}
	return sb.String()
}

func (e *CompileError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

func (e *CompileError) Is(target error) bool {
	return target == ErrCompileFailed || (e != nil && e.Cause != nil && errors.Is(e.Cause, target))
}

// ToolErrorPayload returns a structured JSON error payload consumable by durable tool executors and agents.
func (e *CompileError) ToolErrorPayload() json.RawMessage {
	payload := struct {
		Code        string       `json:"code"`
		Retryable   bool         `json:"retryable"`
		Message     string       `json:"message"`
		DurationMs  int64        `json:"durationMs"`
		Diagnostics []Diagnostic `json:"diagnostics"`
	}{
		Code:        "artifact_compile_error",
		Retryable:   true,
		Message:     e.Error(),
		DurationMs:  e.DurationMs,
		Diagnostics: e.Diagnostics,
	}
	raw, _ := json.Marshal(payload)
	return raw
}
