//go:build !windows

package executable

import (
	"os"
	"os/exec"
	"syscall"
)

// OwnProcessGroup: POSIX children lead their own process group, so one
// signal to the negative pid reaches everything they started.
const OwnProcessGroup = true

func ConfigureGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// SignalGroup sends SIGTERM (or SIGKILL) to the child's process group,
// falling back to the child alone when the group is gone.
func SignalGroup(process *os.Process, kill bool) {
	signal := syscall.SIGTERM
	if kill {
		signal = syscall.SIGKILL
	}
	if err := syscall.Kill(-process.Pid, signal); err != nil {
		_ = process.Signal(signal)
	}
}

func ExitStatus(state *os.ProcessState) (int, bool) {
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		return 0, false
	}
	return state.ExitCode(), state.ExitCode() >= 0
}

func SignalName(state *os.ProcessState) string {
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		return signalNames[status.Signal()]
	}
	return ""
}

var signalNames = map[syscall.Signal]string{
	syscall.SIGTERM: "SIGTERM", syscall.SIGKILL: "SIGKILL", syscall.SIGINT: "SIGINT",
	syscall.SIGHUP: "SIGHUP", syscall.SIGPIPE: "SIGPIPE", syscall.SIGABRT: "SIGABRT",
	syscall.SIGSEGV: "SIGSEGV", syscall.SIGQUIT: "SIGQUIT",
}

func killPid(pid int) {
	_ = syscall.Kill(pid, syscall.SIGKILL)
}

func killGroup(pgid int) {
	_ = syscall.Kill(-pgid, syscall.SIGKILL)
}
