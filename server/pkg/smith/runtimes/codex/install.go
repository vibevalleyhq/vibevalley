package codex

import (
	"os"
	"path/filepath"

	"vibevalley/pkg/smith/internal/shared"
)

// codexInstallMethod is OpenAI's standalone installer (install.ts),
// documented at https://github.com/openai/codex#installing-and-running-codex-cli.
// It unpacks the release into `$CODEX_HOME/packages/standalone/releases`,
// points `current` at it and links `$CODEX_INSTALL_DIR/codex` (default
// `~/.local/bin/codex`) there: the layout `codex doctor` reports as
// `standalone installer` and `codex update` reruns. `CODEX_NON_INTERACTIVE=1`
// is the installer's own switch that skips its prompts (start codex now,
// remove an npm or Homebrew copy); the README doesn't name it, install.sh's
// own usage text does. It adds its folder to PATH in the shell profile,
// which a running host does not read, so the probe looks there too.
var codexInstallMethod = shared.ScriptInstallMethod{
	Source: "https://github.com/openai/codex#installing-and-running-codex-cli",
	Line:   "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
	Tools:  []string{"curl"},
	Writes: func() []string {
		home := homeDir()
		return []string{
			shared.InstallDir(os.Getenv("CODEX_INSTALL_DIR"), filepath.Join(home, ".local", "bin")),
			shared.InstallDir(os.Getenv("CODEX_HOME"), filepath.Join(home, ".codex")),
		}
	},
	Windows: `OpenAI documents: powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"`,
}

// InstallPlan is codex's install planner (codexInstallPlan).
var InstallPlan = shared.ScriptInstallPlan(codexInstallMethod, shared.ThisMachine)

// Install is codex's installer (codexInstall).
var Install = shared.PlanInstaller(Installation, InstallPlan, nil)
