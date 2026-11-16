//go:build !unix

package oar

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
)

// ExecLauncher spawns external agent CLIs via shell-free os/exec.
type ExecLauncher struct{}

// Launch starts spec without invoking a shell.
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

	if err := cmd.Start(); err != nil {
		_ = stdinR.Close()
		_ = stdinW.Close()
		_ = stdoutR.Close()
		_ = stdoutW.Close()
		_ = stderrR.Close()
		_ = stderrW.Close()
		return nil, fmt.Errorf("oar: start %q: %w", spec.Command, err)
	}
	_ = stdinR.Close()
	_ = stdoutW.Close()
	_ = stderrW.Close()

	p := &genericProcess{
		cmd:    cmd,
		stdin:  stdinW,
		stdout: stdoutR,
		stderr: stderrR,
		done:   make(chan struct{}),
	}
	go p.reap()
	return p, nil
}

type genericProcess struct {
	cmd       *exec.Cmd
	stdin     *os.File
	stdout    *os.File
	stderr    *os.File
	done      chan struct{}
	exitStat  ExitStatus
	waitErr   error
	closeOnce sync.Once
}

func (p *genericProcess) reap() {
	defer close(p.done)
	err := p.cmd.Wait()
	if err == nil {
		p.exitStat = ExitStatus{Code: 0}
		return
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		p.exitStat = ExitStatus{Code: exitErr.ExitCode()}
		p.waitErr = err
		return
	}
	p.exitStat = ExitStatus{Code: -1}
	p.waitErr = err
}

func (p *genericProcess) Stdin() io.WriteCloser { return p.stdin }
func (p *genericProcess) Stdout() io.ReadCloser { return p.stdout }
func (p *genericProcess) Stderr() io.ReadCloser { return p.stderr }

func (p *genericProcess) Wait() (ExitStatus, error) {
	<-p.done
	return p.exitStat, p.waitErr
}

func (p *genericProcess) Interrupt() error {
	if p.cmd.Process == nil {
		return nil
	}
	return p.cmd.Process.Signal(os.Interrupt)
}

func (p *genericProcess) Close() error {
	p.closeOnce.Do(func() {
		_ = p.stdin.Close()
		if p.cmd.Process != nil {
			_ = p.cmd.Process.Kill()
		}
		<-p.done
		_ = p.stdout.Close()
		_ = p.stderr.Close()
	})
	return nil
}
