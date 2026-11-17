//go:build !unix

package main

import "os/exec"

func configureTerminalCmd(_ *exec.Cmd) {}

func killTerminalCmd(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	return cmd.Process.Kill()
}
