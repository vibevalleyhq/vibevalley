package machine

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"time"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

// Exec runs spec without a shell inside the workspace root, tearing down the entire process group
// via SIGTERM followed by SIGKILL after the configured grace period on cancel or link disconnect.
func (e *LocalEnv) Exec(ctx context.Context, spec contract.ExecSpec) (contract.ExecResult, error) {
	if err := ctx.Err(); err != nil {
		return contract.ExecResult{}, err
	}
	if len(spec.Argv) == 0 || strings.TrimSpace(spec.Argv[0]) == "" {
		return contract.ExecResult{}, errors.New("machine: exec argv must not be empty")
	}

	e.lifeMu.Lock()
	if e.closed.Load() {
		e.lifeMu.Unlock()
		return contract.ExecResult{}, ErrEnvClosed
	}
	lifeCtx := e.lifeCtx
	if lifeCtx.Err() != nil {
		e.lifeMu.Unlock()
		return contract.ExecResult{}, context.Cause(lifeCtx)
	}
	e.execWG.Add(1)
	e.lifeMu.Unlock()
	defer e.execWG.Done()

	_, workDir, err := e.resolveRelPath(spec.Dir, true)
	if err != nil {
		return contract.ExecResult{}, err
	}
	dirInfo, err := os.Stat(workDir)
	if err != nil {
		return contract.ExecResult{}, fmt.Errorf("exec dir %s: %w", workDir, err)
	}
	if !dirInfo.IsDir() {
		return contract.ExecResult{}, fmt.Errorf("%w: exec dir %s is not a directory", ErrInvalidPath, spec.Dir)
	}

	runCtx, cancelRun := context.WithCancelCause(ctx)
	defer cancelRun(nil)

	stopLifeWatch := context.AfterFunc(lifeCtx, func() {
		cancelRun(context.Cause(lifeCtx))
	})
	defer stopLifeWatch()

	if spec.TimeoutMs > 0 {
		var cancelTimeout context.CancelFunc
		runCtx, cancelTimeout = context.WithTimeout(runCtx, time.Duration(spec.TimeoutMs)*time.Millisecond)
		defer cancelTimeout()
	}

	start := time.Now()
	cmd := exec.CommandContext(runCtx, spec.Argv[0], spec.Argv[1:]...)
	cmd.Dir = workDir
	cmd.Env = buildExecEnv(spec.Env)
	if len(spec.Stdin) > 0 {
		cmd.Stdin = bytes.NewReader(spec.Stdin)
	}

	var stdoutBuf, stderrBuf bytes.Buffer
	cmd.Stdout = &stdoutBuf
	cmd.Stderr = &stderrBuf

	setProcessGroup(cmd)

	var termSentAtUnix atomic.Int64
	var cancelled atomic.Bool

	cmd.Cancel = func() error {
		cancelled.Store(true)
		termSentAtUnix.CompareAndSwap(0, time.Now().UnixNano())
		return signalTerminateGroup(cmd.Process)
	}
	cmd.WaitDelay = e.execGrace + 250*time.Millisecond

	if err := cmd.Start(); err != nil {
		return contract.ExecResult{}, err
	}

	pgid := processGroupID(cmd.Process)
	waitDone := make(chan struct{})
	killerDone := make(chan struct{})

	go func() {
		defer close(killerDone)
		select {
		case <-waitDone:
			return
		case <-runCtx.Done():
		}

		timer := time.NewTimer(e.execGrace)
		defer timer.Stop()
		select {
		case <-waitDone:
			return
		case <-timer.C:
			_ = signalKillGroup(pgid)
		}
	}()

	waitErr := cmd.Wait()
	close(waitDone)
	<-killerDone

	if (cancelled.Load() || runCtx.Err() != nil) && pgid > 0 && isProcessGroupAlive(pgid) {
		ensureGroupKilled(pgid, termSentAtUnix.Load(), e.execGrace)
	}

	durationMs := time.Since(start).Milliseconds()
	exitCode := 0
	if cmd.ProcessState != nil {
		exitCode = cmd.ProcessState.ExitCode()
	}

	interrupted := cancelled.Load() || errors.Is(waitErr, exec.ErrWaitDelay) || (waitErr != nil && runCtx.Err() != nil)
	result := contract.ExecResult{
		ExitCode:    exitCode,
		Stdout:      stdoutBuf.String(),
		Stderr:      stderrBuf.String(),
		Interrupted: interrupted,
		DurationMs:  durationMs,
	}

	if interrupted {
		if cause := context.Cause(lifeCtx); cause != nil {
			return result, cause
		}
		if runCtx.Err() != nil {
			return result, runCtx.Err()
		}
		return result, waitErr
	}

	if waitErr != nil {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			return result, nil
		}
		return result, waitErr
	}
	return result, nil
}

func ensureGroupKilled(pgid int, termSentAtNano int64, grace time.Duration) {
	if termSentAtNano == 0 {
		_ = signalTerminateGroupByPGID(pgid)
		termSentAtNano = time.Now().UnixNano()
	}
	deadline := time.Unix(0, termSentAtNano).Add(grace)
	for time.Now().Before(deadline) {
		if !isProcessGroupAlive(pgid) {
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	_ = signalKillGroup(pgid)
	killDeadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(killDeadline) {
		if !isProcessGroupAlive(pgid) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func buildExecEnv(extra []string) []string {
	base := os.Environ()
	out := make([]string, 0, len(base)+len(extra))
	for _, entry := range base {
		key, _, ok := strings.Cut(entry, "=")
		if !ok || isBlockedSecretEnv(key) {
			continue
		}
		out = append(out, entry)
	}
	out = append(out, extra...)
	return out
}

func isBlockedSecretEnv(key string) bool {
	upper := strings.ToUpper(key)
	switch {
	case strings.Contains(upper, "_API_KEY"):
		return true
	case strings.Contains(upper, "_SECRET"):
		return true
	case strings.Contains(upper, "ACCESS_TOKEN"):
		return true
	case strings.HasPrefix(upper, "VIBEVALLEY_VAULT"):
		return true
	case upper == "ANTHROPIC_API_KEY",
		upper == "OPENAI_API_KEY",
		upper == "GEMINI_API_KEY",
		upper == "GOOGLE_API_KEY",
		upper == "GITHUB_TOKEN",
		upper == "GH_TOKEN":
		return true
	default:
		return false
	}
}
