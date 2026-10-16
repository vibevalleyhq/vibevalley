package grok

import (
	"os"
	"path"
	goruntime "runtime"
	"strings"

	"vibevalley/pkg/smith/internal/shared"
)

// joinFor is path.posix.join, or path.win32.join for platform "win32".
func joinFor(platform string, parts ...string) string {
	if platform != "win32" {
		return path.Join(parts...)
	}
	out := ""
	for _, part := range parts {
		if part == "" {
			continue
		}
		if out == "" {
			out = part
			continue
		}
		out = strings.TrimRight(out, `/\`) + `\` + strings.TrimLeft(part, `/\`)
	}
	return out
}

// InstalledExecutableCandidates is the official script/npm layouts that can
// be invisible to a GUI process's PATH. platform uses Node's names; env
// holds the variables read (GROK_BIN_DIR, GROK_HOME).
func InstalledExecutableCandidates(platform, home string, env map[string]string) []string {
	executable := "grok"
	if platform == "win32" {
		executable = "grok.exe"
	}
	var out []string
	if dir := env["GROK_BIN_DIR"]; dir != "" {
		out = append(out, joinFor(platform, dir, executable))
	}
	if dir := env["GROK_HOME"]; dir != "" {
		out = append(out, joinFor(platform, dir, "bin", executable))
	}
	return append(out, joinFor(platform, home, ".grok", "bin", executable))
}

// Installation probes `grok` (OAR_GROK_BIN pins one); `grok agent stdio --help` must run.
var Installation = shared.ExecutableInstallation(
	"OAR_GROK_BIN",
	"grok",
	func() []string {
		home, _ := os.UserHomeDir()
		return InstalledExecutableCandidates(shared.NodePlatform(goruntime.GOOS), home, map[string]string{
			"GROK_BIN_DIR": os.Getenv("GROK_BIN_DIR"),
			"GROK_HOME":    os.Getenv("GROK_HOME"),
		})
	},
	[]string{"agent", "stdio", "--help"},
	shared.ExecutableInstallationOptions{},
)
