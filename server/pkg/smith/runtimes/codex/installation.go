package codex

import (
	"os"
	"path"
	"runtime"

	"vibevalley/pkg/smith/internal/shared"
)

// codexInstalledExecutableCandidates are copies a process's PATH can miss
// (installation.ts). The macOS Desktop app bundles the Codex CLI instead of
// putting it on PATH; OpenAI relocated the app from Codex.app to
// ChatGPT.app, so the new bundle is tried before the legacy one, and system
// installs before per-user installs. Then the standalone installer's
// launcher (https://chatgpt.com/codex/install.sh: `$CODEX_INSTALL_DIR/codex`,
// by default `~/.local/bin/codex`, a link into
// `$CODEX_HOME/packages/standalone/current`), which it adds to PATH only in
// shell profiles. platform is a Node platform name (win32, darwin, linux);
// installDir is CODEX_INSTALL_DIR ("" when unset).
func codexInstalledExecutableCandidates(platform, home, installDir string) []string {
	if platform == "win32" {
		return []string{}
	}
	candidates := []string{}
	if platform == "darwin" {
		candidates = append(candidates,
			"/Applications/ChatGPT.app/Contents/Resources/codex",
			"/Applications/Codex.app/Contents/Resources/codex",
			path.Join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
			path.Join(home, "Applications", "Codex.app", "Contents", "Resources", "codex"),
		)
	}
	if installDir != "" {
		candidates = append(candidates, path.Join(installDir, "codex"))
	}
	return append(candidates, path.Join(home, ".local", "bin", "codex"))
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
	return codexInstalledExecutableCandidates(nodePlatform(), homeDir(), os.Getenv("CODEX_INSTALL_DIR"))
}

// Installation is codex's installation probe (codexInstallation). OAR drives
// Codex through its app-server surface; a codex without it is unsupported.
var Installation = shared.ExecutableInstallation("OAR_CODEX_BIN", "codex", installedCandidates, []string{"app-server", "--help"}, shared.ExecutableInstallationOptions{})
