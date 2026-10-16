package kimi

import (
	"os"
	goruntime "runtime"
	"strings"
	"time"

	"vibevalley/pkg/smith/internal/shared"
)

// joinFor is path.join for platform ("win32" joins with backslashes).
func joinFor(platform string, parts ...string) string {
	separator := "/"
	if platform == "win32" {
		separator = `\`
	}
	out := ""
	for _, part := range parts {
		if out == "" {
			out = part
			continue
		}
		out = strings.TrimRight(out, `/\`) + separator + strings.TrimLeft(part, `/\`)
	}
	return out
}

// InstalledExecutableCandidates is the official native-installer layouts
// that can be invisible to a GUI process's PATH. platform uses Node's names;
// env holds the variables read (KIMI_INSTALL_DIR).
func InstalledExecutableCandidates(platform, home string, env map[string]string) []string {
	executable := "kimi"
	if platform == "win32" {
		executable = "kimi.exe"
	}
	var out []string
	if dir := env["KIMI_INSTALL_DIR"]; dir != "" {
		out = append(out, joinFor(platform, dir, "bin", executable))
	}
	return append(out,
		joinFor(platform, home, ".kimi-code", "bin", executable),
		// The previous command name only as the last compatibility fallback.
		"kimi-code",
	)
}

// Installation probes `kimi` (OAR_KIMI_BIN pins one); `kimi acp --help` must run.
var Installation = shared.ExecutableInstallation(
	"OAR_KIMI_BIN",
	"kimi",
	func() []string {
		home, _ := os.UserHomeDir()
		return InstalledExecutableCandidates(shared.NodePlatform(goruntime.GOOS), home, map[string]string{"KIMI_INSTALL_DIR": os.Getenv("KIMI_INSTALL_DIR")})
	},
	[]string{"acp", "--help"},
	shared.ExecutableInstallationOptions{ReadinessTimeout: 30 * time.Second, VersionTimeout: 30 * time.Second},
)
