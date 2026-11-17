//go:build !windows

package vibevalley_test

import (
	"bytes"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

func sendGracefulStop(p *os.Process) error {
	return p.Signal(syscall.SIGTERM)
}

func pgidAliveCount(pgid int) (int, error) {
	if pgid <= 0 {
		return 0, nil
	}
	cmd := exec.Command("ps", "-o", "pid=", "-g", strconv.Itoa(pgid))
	out, err := cmd.CombinedOutput()
	trimmed := strings.TrimSpace(string(out))
	if trimmed == "" {
		return 0, nil
	}
	if err != nil {
		// `ps -g` exits non-zero when no matching processes exist.
		return 0, nil
	}
	lines := bytes.Split([]byte(trimmed), []byte{'\n'})
	count := 0
	for _, line := range lines {
		if len(bytes.TrimSpace(line)) > 0 {
			count++
		}
	}
	return count, nil
}
