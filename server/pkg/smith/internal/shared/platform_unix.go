//go:build !windows

package shared

import (
	"errors"
	"os"
	"syscall"
)

// writable reports whether this user may write dir (access(2) W_OK).
func writable(dir string) bool {
	return syscall.Access(dir, 0x2) == nil
}

// releaseFifo opens a FIFO for writing without blocking and closes it at
// once, so a reader blocked opening it reads an empty document. ENXIO: no
// reader is waiting.
func releaseFifo(file string, info os.FileInfo) {
	if info.Mode()&os.ModeNamedPipe == 0 {
		return
	}
	if fd, err := syscall.Open(file, syscall.O_WRONLY|syscall.O_NONBLOCK, 0); err == nil {
		_ = syscall.Close(fd)
	}
}

// pidRunning reports whether pid runs; EPERM means it runs as another user.
func pidRunning(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
