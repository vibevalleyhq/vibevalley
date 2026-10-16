package grok

import (
	"os"
	"path/filepath"

	"vibevalley/pkg/smith/internal/shared"
)

// InstallMethod is xAI's installer, documented at
// https://docs.x.ai/build/overview. It downloads the stable release into
// `~/.grok/downloads` and links `$GROK_BIN_DIR/grok` (default
// `~/.grok/bin/grok`) to it: the `internal` install `grok update` updates
// (an npm copy would be a second one). It never prompts. Besides adding its
// folder to the shell profile, it links `grok` into `~/.local/bin` or
// `/usr/local/bin` when one is on PATH and writable.
var InstallMethod = shared.ScriptInstallMethod{
	Source: "https://docs.x.ai/build/overview",
	Line:   "curl -fsSL https://x.ai/cli/install.sh | bash",
	Tools:  []string{"curl", "bash"},
	Writes: func() []string {
		userHome, _ := os.UserHomeDir()
		home := filepath.Join(userHome, ".grok")
		return []string{shared.InstallDir(os.Getenv("GROK_BIN_DIR"), filepath.Join(home, "bin")), home}
	},
	Windows: "xAI documents, in PowerShell: irm https://x.ai/cli/install.ps1 | iex",
}

// InstallPlan plans InstallMethod on this machine.
var InstallPlan = shared.ScriptInstallPlan(InstallMethod, shared.ThisMachine)

// Install runs InstallPlan, judged by the installation probe.
var Install = shared.PlanInstaller(Installation, InstallPlan, nil)
