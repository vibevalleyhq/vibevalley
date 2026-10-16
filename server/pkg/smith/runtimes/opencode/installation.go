package opencode

import (
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"time"

	"vibevalley/pkg/smith/internal/shared"
)

// InstalledExecutableCandidates is the install script's directory,
// `~/.opencode/bin`, which a GUI process's PATH can miss. npm
// (`opencode-ai`), Homebrew and Scoop copies are on PATH. goos uses Go's
// names; the path is spelled for that platform.
func InstalledExecutableCandidates(goos, home string) []string {
	if goos == "windows" {
		return []string{strings.TrimRight(home, `\/`) + `\.opencode\bin\opencode.exe`}
	}
	return []string{filepath.ToSlash(filepath.Join(home, ".opencode", "bin", "opencode"))}
}

// Installation probes `opencode`; `opencode --version` is kept verbatim: v1
// prints 1.x, v2 "opencode v2.x".
var Installation = shared.ExecutableInstallation("OAR_OPENCODE_BIN", "opencode", func() []string {
	home, _ := os.UserHomeDir()
	return InstalledExecutableCandidates(goruntime.GOOS, home)
}, nil, shared.ExecutableInstallationOptions{VersionTimeout: 15 * time.Second})
