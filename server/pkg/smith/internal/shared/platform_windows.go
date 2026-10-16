//go:build windows

package shared

import "os"

// writable reports whether this user may write dir: Windows has no
// access(2), so the read-only attribute decides.
func writable(dir string) bool {
	info, err := os.Stat(dir)
	return err == nil && info.Mode().Perm()&0o200 != 0
}

// releaseFifo: Windows has no FIFOs in the file system.
func releaseFifo(string, os.FileInfo) {}

// pidRunning reports whether pid runs.
func pidRunning(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	_ = process.Release()
	return true
}
