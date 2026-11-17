//go:build unix

package main

import (
	"os/exec"
	"syscall"
)

func configureTerminalCmd(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func killTerminalCmd(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	pid := cmd.Process.Pid
	if pid > 0 {
		_ = syscall.Kill(-pid, syscall.SIGTERM)
		_ = syscall.Kill(-pid, syscall.SIGKILL)
	}
	return cmd.Process.Kill()
}
