//go:build windows

package main

import "os"

func sendGracefulStop(p *os.Process) error {
	return p.Signal(os.Interrupt)
}
