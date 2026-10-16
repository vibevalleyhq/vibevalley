package claude

import (
	"path/filepath"

	"vibevalley/pkg/smith/internal/shared"
)

// claudeInstallMethod is Anthropic's native installer
// (https://code.claude.com/docs/en/setup, install.ts). It downloads the
// release downloads.claude.ai/claude-code-releases/latest names, checks it
// against the release manifest and runs `claude install`, which links
// ~/.local/bin/claude into ~/.local/share/claude/versions/<version>: the
// native layout `claude update` updates. It needs no terminal and never
// prompts, and it does not edit shell profiles (it prints the PATH line
// instead), so the probe looks in ~/.local/bin itself.
var claudeInstallMethod = shared.ScriptInstallMethod{
	Source: "https://code.claude.com/docs/en/setup",
	Line:   "curl -fsSL https://claude.ai/install.sh | bash",
	Tools:  []string{"curl", "bash"},
	Writes: func() []string {
		home := homeDir()
		return []string{filepath.Join(home, ".local", "bin"), filepath.Join(home, ".local", "share", "claude"), filepath.Join(home, ".claude")}
	},
	Windows: "Anthropic documents, in PowerShell: irm https://claude.ai/install.ps1 | iex",
}

// InstallPlan is claude's install planner (claudeInstallPlan).
var InstallPlan = shared.ScriptInstallPlan(claudeInstallMethod, shared.ThisMachine)

// Install is claude's installer (claudeInstall).
var Install = shared.PlanInstaller(Installation, InstallPlan, nil)
