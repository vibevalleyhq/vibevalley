//go:build !windows

package claude

import (
	"errors"
	"syscall"
	"time"
)

// makeFifo makes a 0600 FIFO at file; false where none can be made.
func makeFifo(file string) bool {
	return syscall.Mkfifo(file, 0o600) == nil
}

// feedFifo writes content to the FIFO once a reader has it open, polling
// for the reader (ENXIO until then) and for a full pipe (EAGAIN), until
// stopped. Its own goroutine; nothing waits on it.
func feedFifo(file string, content []byte, stopped func() bool) error {
	wait := 5 * time.Millisecond
	fd := -1
	for !stopped() {
		opened, err := syscall.Open(file, syscall.O_WRONLY|syscall.O_NONBLOCK, 0)
		if err == nil {
			fd = opened
			break
		}
		if !errors.Is(err, syscall.ENXIO) {
			return err
		}
		time.Sleep(wait)
		wait = min(wait*2, 100*time.Millisecond)
	}
	if fd < 0 {
		return nil
	}
	defer syscall.Close(fd)
	rest := content
	for len(rest) > 0 && !stopped() {
		written, err := syscall.Write(fd, rest)
		if err != nil {
			if errors.Is(err, syscall.EAGAIN) || errors.Is(err, syscall.EINTR) {
				time.Sleep(5 * time.Millisecond)
				continue
			}
			return err
		}
		rest = rest[written:]
	}
	return nil
}
