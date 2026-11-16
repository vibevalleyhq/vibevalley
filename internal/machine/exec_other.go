//go:build !unix

package machine

import (
	"os"
	"os/exec"
)

func setProcessGroup(_ *exec.Cmd) {}

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
	return proc.Kill()
}

func signalTerminateGroupByPGID(_ int) error {
	return nil
}

func signalKillGroup(_ int) error {
	return nil
}

func isProcessGroupAlive(_ int) bool {
	return false
}
