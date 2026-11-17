//go:build unix

package oar

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

const execKillGrace = 2 * time.Second

// ExecLauncher spawns external agent CLIs via shell-free os/exec in isolated Unix process groups.
type ExecLauncher struct{}

// Launch starts spec without invoking a shell and assigns a dedicated process group (Setpgid: true).
func (ExecLauncher) Launch(ctx context.Context, spec LaunchSpec) (Process, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		return nil, fmt.Errorf("oar: stdin pipe: %w", err)
	}
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		_ = stdinR.Close()
		_ = stdinW.Close()
		return nil, fmt.Errorf("oar: stdout pipe: %w", err)
	}
	stderrR, stderrW, err := os.Pipe()
	if err != nil {
		_ = stdinR.Close()
		_ = stdinW.Close()
		_ = stdoutR.Close()
		_ = stdoutW.Close()
		return nil, fmt.Errorf("oar: stderr pipe: %w", err)
	}

	cmd := exec.Command(spec.Command, spec.Args...)
	cmd.Dir = spec.Dir
	if spec.Env != nil {
		cmd.Env = spec.Env
	}
	cmd.Stdin = stdinR
	cmd.Stdout = stdoutW
	cmd.Stderr = stderrW
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	if err := cmd.Start(); err != nil {
		_ = stdinR.Close()
		_ = stdinW.Close()
		_ = stdoutR.Close()
		_ = stdoutW.Close()
		_ = stderrR.Close()
		_ = stderrW.Close()
		return nil, fmt.Errorf("oar: start %q: %w", spec.Command, err)
	}
	// Close child-side pipe descriptors immediately so EOF arrives cleanly when the process group exits.
	_ = stdinR.Close()
	_ = stdoutW.Close()
	_ = stderrW.Close()

	p := &unixProcess{
		cmd:    cmd,
		pid:    cmd.Process.Pid,
		stdin:  stdinW,
		stdout: stdoutR,
		stderr: stderrR,
		done:   make(chan struct{}),
	}
	go p.reap()
	return p, nil
}

type unixProcess struct {
	cmd    *exec.Cmd
	pid    int
	stdin  *os.File
	stdout *os.File
	stderr *os.File

	done     chan struct{}
	exitStat ExitStatus
	waitErr  error

	closeOnce sync.Once
}

func (p *unixProcess) reap() {
	defer close(p.done)
	err := p.cmd.Wait()
	if err == nil {
		p.exitStat = ExitStatus{Code: 0}
		return
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		status := exitErr.Sys().(syscall.WaitStatus)
		if status.Signaled() {
			p.exitStat = ExitStatus{
				Code:   128 + int(status.Signal()),
				Signal: status.Signal().String(),
			}
		} else {
			p.exitStat = ExitStatus{Code: exitErr.ExitCode()}
		}
		p.waitErr = err
		return
	}
	p.exitStat = ExitStatus{Code: -1}
	p.waitErr = err
}

func (p *unixProcess) Stdin() io.WriteCloser { return p.stdin }
func (p *unixProcess) Stdout() io.ReadCloser { return p.stdout }
func (p *unixProcess) Stderr() io.ReadCloser { return p.stderr }

func (p *unixProcess) Wait() (ExitStatus, error) {
	<-p.done
	return p.exitStat, p.waitErr
}

func (p *unixProcess) Interrupt() error {
	select {
	case <-p.done:
		return nil
	default:
	}
	if err := syscall.Kill(-p.pid, syscall.SIGINT); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	return nil
}

func (p *unixProcess) Close() error {
	p.closeOnce.Do(func() {
		_ = p.stdin.Close()
		select {
		case <-p.done:
		default:
			_ = syscall.Kill(-p.pid, syscall.SIGTERM)
			timer := time.NewTimer(execKillGrace)
			select {
			case <-p.done:
				timer.Stop()
			case <-timer.C:
				_ = syscall.Kill(-p.pid, syscall.SIGKILL)
				<-p.done
			}
		}
		_ = p.stdout.Close()
		_ = p.stderr.Close()
	})
	return nil
}
