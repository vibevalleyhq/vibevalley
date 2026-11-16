//go:build windows

package vibevalley_test

import (
	"os"
)

func sendGracefulStop(p *os.Process) error {
	return p.Signal(os.Interrupt)
}

func pgidAliveCount(_ int) (int, error) {
	return 0, nil
}
