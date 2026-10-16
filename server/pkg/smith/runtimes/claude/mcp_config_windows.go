//go:build windows

package claude

// makeFifo: Windows has no FIFOs; the config is a 0600 file (mcp-config.ts).
func makeFifo(string) bool { return false }

func feedFifo(string, []byte, func() bool) error { return nil }
