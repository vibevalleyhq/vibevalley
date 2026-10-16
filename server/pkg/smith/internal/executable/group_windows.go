//go:build windows

package executable

import (
	"os"
	"os/exec"
	"strconv"
)

// OwnProcessGroup: Windows has no process groups; a detached child would get its own console.
const OwnProcessGroup = false

func ConfigureGroup(*exec.Cmd) {}

// SignalGroup ends the child and its tree (taskkill /T /F); the child alone when that fails.
func SignalGroup(process *os.Process, _ bool) {
	if err := exec.Command("taskkill", "/pid", strconv.Itoa(process.Pid), "/T", "/F").Run(); err != nil {
		_ = process.Kill()
	}
}

func ExitStatus(state *os.ProcessState) (int, bool) {
	return state.ExitCode(), state.ExitCode() >= 0
}

func SignalName(*os.ProcessState) string { return "" }

func killPid(pid int) {
	if process, err := os.FindProcess(pid); err == nil {
		_ = process.Kill()
	}
}

func killGroup(int) {}
