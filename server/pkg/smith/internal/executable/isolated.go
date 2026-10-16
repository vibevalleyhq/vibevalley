package executable

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// IsolatedResult is a run with no stdin and no controlling terminal.
type IsolatedResult struct {
	ExitCode *int
	TimedOut bool
	Stdout   string
	Stderr   string
}

const isolatedOutputLimit = 1024 * 1024

type tailBuffer struct {
	mu   sync.Mutex
	text string
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.text += string(p)
	if len(b.text) > isolatedOutputLimit {
		b.text = b.text[len(b.text)-isolatedOutputLimit:]
	}
	return len(p), nil
}

func (b *tailBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.text
}

// RunIsolated runs a command that may start others (an updater runs npm or
// `curl | sh`) with no stdin, its own process group, and a timeout that
// stops the whole group (shared/executable/isolated.ts).
func RunIsolated(ctx context.Context, command string, args []string, env []string, timeout time.Duration) IsolatedResult {
	cmd := exec.Command(command, args...)
	cmd.Env = env
	ConfigureGroup(cmd)
	stdout, stderr := &tailBuffer{}, &tailBuffer{}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	cmd.WaitDelay = 2 * time.Second
	if err := cmd.Start(); err != nil {
		return IsolatedResult{Stderr: err.Error()}
	}
	track(cmd.Process)
	defer forget(cmd.Process)
	var timedOut atomic.Bool
	var once sync.Once
	stop := func() {
		once.Do(func() {
			SignalGroup(cmd.Process, false)
			time.AfterFunc(KillGraceFromEnv(), func() { SignalGroup(cmd.Process, true) })
		})
	}
	timer := time.AfterFunc(timeout, func() {
		timedOut.Store(true)
		stop()
	})
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			stop()
		case <-done:
		}
	}()
	_ = cmd.Wait()
	close(done)
	timer.Stop()
	result := IsolatedResult{TimedOut: timedOut.Load(), Stdout: stdout.String(), Stderr: stderr.String()}
	if !timedOut.Load() && cmd.ProcessState != nil {
		if code, ok := ExitStatus(cmd.ProcessState); ok {
			result.ExitCode = &code
		}
	}
	return result
}

// IsolatedOutput is a run's stdout then stderr, with OAR's note when the timeout stopped it.
func IsolatedOutput(result IsolatedResult, timeout time.Duration, what string) string {
	output := result.Stdout + result.Stderr
	if result.TimedOut {
		return fmt.Sprintf("%s\n[oar: stopped the %s after %d ms]\n", output, what, timeout.Milliseconds())
	}
	return output
}

// FirstLine is the first line of trimmed text.
func FirstLine(text string) string {
	text = strings.TrimSpace(text)
	if i := strings.IndexAny(text, "\r\n"); i >= 0 {
		return text[:i]
	}
	return text
}
