package executable

import (
	"errors"
	"fmt"
	"sync"
	"unicode/utf8"
)

// StderrTailBytes is how much stderr a process keeps.
const StderrTailBytes = 8192

// StderrTail keeps the last StderrTailBytes bytes written to it.
type StderrTail struct {
	mu    sync.Mutex
	bytes []byte
}

// Append adds a chunk.
func (t *StderrTail) Append(chunk []byte) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.bytes = append(t.bytes, chunk...)
	if len(t.bytes) > StderrTailBytes {
		t.bytes = append([]byte(nil), t.bytes[len(t.bytes)-StderrTailBytes:]...)
	}
}

// Text is the tail without a UTF-8 character cut at its start.
func (t *StderrTail) Text() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	start := 0
	for start < len(t.bytes) && !utf8.RuneStart(t.bytes[start]) {
		start++
	}
	return string(t.bytes[start:])
}

// Tail is the StderrTail of text.
func Tail(text string) string {
	tail := &StderrTail{}
	tail.Append([]byte(text))
	return tail.Text()
}

// spawnFailure names the command, never the argv (prompts, launch args).
func spawnFailure(command string, err error) error {
	return &SpawnError{Command: command, Err: err}
}

// SpawnError is a process that could not start.
type SpawnError struct {
	Command string
	Err     error
}

func (e *SpawnError) Error() string {
	return fmt.Sprintf("spawn %s: %v", e.Command, unwrapPathError(e.Err))
}
func (e *SpawnError) Unwrap() error { return e.Err }

func unwrapPathError(err error) error {
	var inner interface{ Unwrap() error }
	if errors.As(err, &inner) {
		if wrapped := inner.Unwrap(); wrapped != nil {
			return wrapped
		}
	}
	return err
}

// ProcessFailure is an operational failure carrying the native reason and a bounded stderr tail.
func ProcessFailure(context string, diagnostics Diagnostics) error {
	code := "unavailable"
	if diagnostics.ExitCode != nil {
		code = fmt.Sprint(*diagnostics.ExitCode)
	}
	signal := diagnostics.Signal
	if signal == "" {
		signal = "none"
	}
	message := fmt.Sprintf("%s: exit code %s; signal %s", context, code, signal)
	if diagnostics.Timeout > 0 {
		message += fmt.Sprintf("; timeout after %d ms", diagnostics.Timeout.Milliseconds())
	}
	if diagnostics.Error != "" {
		message += "; " + diagnostics.Error
	}
	if diagnostics.Stderr != "" {
		message += "\nstderr (tail):\n" + diagnostics.Stderr
	}
	return errors.New(message)
}
