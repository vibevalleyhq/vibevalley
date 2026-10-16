package kimi

import (
	"os"
	"path/filepath"

	"vibevalley/pkg/smith/internal/shared"
)

// InstallMethod is Moonshot's native installer, documented at
// https://github.com/MoonshotAI/kimi-code#install. It installs the release
// `code.kimi.com/kimi-code/latest` names as `$KIMI_INSTALL_DIR/bin/kimi`
// (default `~/.kimi-code/bin/kimi`), the native copy `kimi upgrade` stages
// updates for, and records region `mainland-cn` (the `code.kimi.com` source
// CheckUpdate then reads; the region only seeds the first login). It never
// prompts; it adds its folder to the shell profile and renames an older
// Python `kimi-cli` shim it finds first on PATH to `kimi-legacy`, where this
// user can write.
var InstallMethod = shared.ScriptInstallMethod{
	Source: "https://github.com/MoonshotAI/kimi-code#install",
	Line:   "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
	Tools:  []string{"curl", "bash"},
	Writes: func() []string {
		userHome, _ := os.UserHomeDir()
		home := filepath.Join(userHome, ".kimi-code")
		return []string{shared.InstallDir(os.Getenv("KIMI_INSTALL_DIR"), home), shared.InstallDir(os.Getenv("KIMI_CODE_HOME"), home)}
	},
	Windows: "Moonshot documents, in PowerShell: irm https://code.kimi.com/kimi-code/install.ps1 | iex",
}

// InstallPlan plans InstallMethod on this machine.
var InstallPlan = shared.ScriptInstallPlan(InstallMethod, shared.ThisMachine)

// Install runs InstallPlan, judged by the installation probe.
var Install = shared.PlanInstaller(Installation, InstallPlan, nil)
