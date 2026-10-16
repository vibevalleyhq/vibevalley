//go:build !windows

package codex

import (
	"fmt"
	"os"
	"syscall"
)

// identity is a home directory's identity, "" when it is no directory:
// device and inode. TS adds its birth time, which Go's os.Stat does not
// portably expose (smith/GAPS.md).
func identity(home string) string {
	info, err := os.Stat(home)
	if err != nil || !info.IsDir() {
		return ""
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		return fmt.Sprintf("%d:%d", stat.Dev, stat.Ino)
	}
	return info.ModTime().String()
}
