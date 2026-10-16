//go:build windows

package codex

import (
	"fmt"
	"os"
	"syscall"
)

// identity is a home directory's identity, "" when it is no directory: its
// creation time (TS: device, inode and birth time).
func identity(home string) string {
	info, err := os.Stat(home)
	if err != nil || !info.IsDir() {
		return ""
	}
	if data, ok := info.Sys().(*syscall.Win32FileAttributeData); ok {
		return fmt.Sprintf("%d", data.CreationTime.Nanoseconds())
	}
	return info.ModTime().String()
}
