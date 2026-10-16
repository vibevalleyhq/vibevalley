package claude

import (
	"os"
	"path"
	"runtime"

	"vibevalley/pkg/smith/internal/shared"
)

// claudeInstalledExecutableCandidates is where the native installer puts the
// launcher (~/.local/bin/claude, a link into
// ~/.local/share/claude/versions/<version>; %USERPROFILE%\.local\bin\claude.exe
// on Windows), which a GUI or service process's PATH can miss: the
// installer only prints a note when that folder is not on PATH
// (installation.ts). npm, Homebrew and WinGet copies are on PATH. platform
// is a Node platform name (win32, darwin, linux).
func claudeInstalledExecutableCandidates(platform, home string) []string {
	if platform == "win32" {
		return []string{winJoin(home, ".local", "bin", "claude.exe")}
	}
	return []string{path.Join(home, ".local", "bin", "claude")}
}

// winJoin is path.win32.join for these segments.
func winJoin(parts ...string) string {
	joined := ""
	for _, part := range parts {
		if part == "" {
			continue
		}
		if joined == "" {
			joined = part
		} else if joined[len(joined)-1] == '\\' || joined[len(joined)-1] == '/' {
			joined += part
		} else {
			joined += `\` + part
		}
	}
	return joined
}

func homeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

func nodePlatform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}

func installedCandidates() []string {
	return claudeInstalledExecutableCandidates(nodePlatform(), homeDir())
}

// Installation is claude's installation probe (claudeInstallation): OAR_CLAUDE_BIN pins one; else claude on PATH, then the native launcher.
var Installation = shared.ExecutableInstallation("OAR_CLAUDE_BIN", "claude", installedCandidates, nil, shared.ExecutableInstallationOptions{})
