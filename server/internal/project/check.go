package project

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Bound memory even when a broken check produces output without newlines.
type checkTail struct{ data []byte }

func (b *checkTail) Write(p []byte) (int, error) {
	const limit = 64 * 1024
	n := len(p)
	if len(p) >= limit {
		b.data = append(b.data[:0], p[len(p)-limit:]...)
	} else {
		if len(b.data)+len(p) > limit {
			b.data = b.data[len(b.data)+len(p)-limit:]
		}
		b.data = append(b.data, p...)
	}
	return n, nil
}

func (p *Service) check(cwd string) error {
	file := filepath.Join(cwd, ".vibevalley", "check")
	if _, err := os.Lstat(file); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), p.checkTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, file)
	cmd.Dir = cwd
	// Kill the whole check, including test runners spawned by its shell.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = time.Second
	var output checkTail
	cmd.Stdout, cmd.Stderr = &output, &output
	err := cmd.Run()
	if err == nil {
		return nil
	}
	why := fmt.Sprintf("项目检查 .vibevalley/check 没通过：%v", err)
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		why = fmt.Sprintf("项目检查 .vibevalley/check 超时（%s）", p.checkTimeout)
	}
	lines := strings.Split(strings.TrimSpace(string(output.data)), "\n")
	if len(lines) > 40 {
		lines = lines[len(lines)-40:]
	}
	return MergeFailure{Kind: "check", Reason: why + "\n" + strings.Join(lines, "\n")}
}
