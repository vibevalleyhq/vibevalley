//go:build unix

package machine

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func processGroupID(proc *os.Process) int {
	if proc == nil {
		return 0
	}
	return proc.Pid
}

func signalTerminateGroup(proc *os.Process) error {
	if proc == nil {
		return os.ErrProcessDone
	}
	return signalTerminateGroupByPGID(proc.Pid)
}

func signalTerminateGroupByPGID(pgid int) error {
	if pgid <= 0 {
		return os.ErrProcessDone
	}
	err := syscall.Kill(-pgid, syscall.SIGTERM)
	if errors.Is(err, syscall.ESRCH) {
		return os.ErrProcessDone
	}
	return err
}

func signalKillGroup(pgid int) error {
	if pgid <= 0 {
		return os.ErrProcessDone
	}
	err := syscall.Kill(-pgid, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) {
		return os.ErrProcessDone
	}
	return err
}

func isProcessGroupAlive(pgid int) bool {
	if pgid <= 0 {
		return false
	}
	err := syscall.Kill(-pgid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
