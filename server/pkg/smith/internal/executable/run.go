package executable

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
)

// Result is a one-shot run's outcome. OK means exit code 0, no signal, no
// failure. ExitCode is nil when the command never exited with a code of its
// own (spawn failure, signal, timeout, cancellation).
type Result struct {
	OK          bool
	Stdout      string
	Stderr      string
	ExitCode    *int
	Diagnostics *Diagnostics
}

// RunOptions configures Run.
type RunOptions struct {
	Dir string
	// The whole environment; nil inherits the host's.
	Env []string
	// Default 15 s (0). Negative or sub-millisecond values are refused
	// (ERR_OUT_OF_RANGE) before anything is spawned; NoTimeout runs unbounded.
	Timeout   time.Duration
	NoTimeout bool
	// Written to stdin, then stdin is closed (nil: stdin closed at once).
	Stdin []byte
}

const outputLimit = 2 * 1024 * 1024

type limitedBuffer struct {
	mu       sync.Mutex
	buf      bytes.Buffer
	exceeded bool
	onExceed func()
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	remaining := outputLimit - b.buf.Len()
	if len(p) > remaining {
		if remaining > 0 {
			b.buf.Write(p[:remaining])
		}
		if !b.exceeded {
			b.exceeded = true
			go b.onExceed()
		}
		return len(p), nil
	}
	b.buf.Write(p)
	return len(p), nil
}

func (b *limitedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// Run runs a command to completion in its own process group; a timeout or
// a cancelled ctx stops the whole group (SIGTERM, then SIGKILL after the grace).
func Run(ctx context.Context, command string, args []string, options RunOptions) Result {
	timeout := options.Timeout
	if timeout < 0 || timeout%time.Millisecond != 0 {
		diagnostics := Diagnostics{Error: "ERR_OUT_OF_RANGE: timeoutMs must be a nonnegative integer"}
		return Result{Diagnostics: &diagnostics}
	}
	if timeout == 0 {
		timeout = 15 * time.Second
	}
	if options.NoTimeout {
		timeout = 0
	}
	cmd := exec.Command(command, args...)
	cmd.Dir = options.Dir
	cmd.Env = options.Env
	ConfigureGroup(cmd)
	if options.Stdin != nil {
		cmd.Stdin = bytes.NewReader(options.Stdin)
	}
	var stopOnce sync.Once
	stopped := make(chan struct{})
	failure := ""
	var failureMu sync.Mutex
	setFailure := func(text string) {
		failureMu.Lock()
		if failure == "" {
			failure = text
		}
		failureMu.Unlock()
	}
	stop := func() {
		stopOnce.Do(func() {
			close(stopped)
			if cmd.Process == nil {
				return
			}
			SignalGroup(cmd.Process, false)
			time.AfterFunc(KillGraceFromEnv(), func() { SignalGroup(cmd.Process, true) })
		})
	}
	stdout := &limitedBuffer{onExceed: func() { setFailure("ERR_CHILD_PROCESS_STDIO_MAXBUFFER: stdout maxBuffer length exceeded"); stop() }}
	stderr := &limitedBuffer{onExceed: func() { setFailure("ERR_CHILD_PROCESS_STDIO_MAXBUFFER: stderr maxBuffer length exceeded"); stop() }}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	// A launcher that exits while a descendant holds the pipes: stop waiting after a while.
	cmd.WaitDelay = 2 * time.Second
	if err := cmd.Start(); err != nil {
		diagnostics := Diagnostics{Error: (&SpawnError{Command: command, Err: err}).Error()}
		return Result{Diagnostics: &diagnostics}
	}
	track(cmd.Process)
	defer forget(cmd.Process)
	var timedOut atomic.Bool
	var timer *time.Timer
	if timeout > 0 {
		timer = time.AfterFunc(timeout, func() {
			timedOut.Store(true)
			setFailure("")
			stop()
		})
	}
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			setFailure("ABORT_ERR: The operation was aborted")
			stop()
		case <-done:
		}
	}()
	err := cmd.Wait()
	close(done)
	if timer != nil {
		timer.Stop()
	}
	result := Result{Stdout: stdout.String(), Stderr: stderr.String()}
	select {
	case <-stopped:
	default:
		var exitErr *exec.ExitError
		if err == nil || errors.As(err, &exitErr) || errors.Is(err, exec.ErrWaitDelay) {
			if state := cmd.ProcessState; state != nil {
				if code, ok := ExitStatus(state); ok {
					result.ExitCode = &code
				}
			}
		}
	}
	failureMu.Lock()
	failed := failure
	failureMu.Unlock()
	result.OK = result.ExitCode != nil && *result.ExitCode == 0 && failed == ""
	if !result.OK {
		diagnostics := Diagnostics{ExitCode: result.ExitCode, Stderr: Tail(result.Stderr), Error: failed}
		if cmd.ProcessState != nil {
			diagnostics.Signal = SignalName(cmd.ProcessState)
		}
		if timedOut.Load() {
			diagnostics.Timeout = timeout
		}
		result.Diagnostics = &diagnostics
	}
	return result
}

// AssertRan errors when a command timed out or never ran to an exit code of
// its own; a command that exited with a code returns nil (its answer is the caller's).
func AssertRan(result Result, context string) error {
	if result.OK {
		return nil
	}
	if result.ExitCode == nil || (result.Diagnostics != nil && result.Diagnostics.Timeout > 0) {
		diagnostics := Diagnostics{ExitCode: result.ExitCode, Stderr: Tail(result.Stderr)}
		if result.Diagnostics != nil {
			diagnostics = *result.Diagnostics
		}
		return ProcessFailure(context, diagnostics)
	}
	return nil
}

// Environ is the host environment, for options that take a whole environment.
func Environ() []string { return os.Environ() }
