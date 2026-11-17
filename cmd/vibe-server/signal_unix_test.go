//go:build !windows

package main

import (
	"os"
	"syscall"
)

func sendGracefulStop(p *os.Process) error {
	return p.Signal(syscall.SIGTERM)
}
