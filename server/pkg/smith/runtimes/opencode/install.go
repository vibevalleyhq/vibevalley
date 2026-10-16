package opencode

import (
	"os"
	"path/filepath"
	"strings"

	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// InstallLines: OpenCode ships two major lines of the same `opencode`
// command in parallel, OpenCode 1 (npm `opencode-ai`, 1.x) and OpenCode 2
// (npm `@opencode/cli`, 2.x, a rewrite with a new plugin and server API).
// They do not install side by side: both install scripts write
// `~/.opencode/bin/opencode`; the 2 installer replaces a 1 binary, and the 1
// script silently replaces a 2 binary with 1. So OAR never chooses a line
// for the person, and an install never runs over a copy of either line: the
// probe finds it first (`already_installed`).
var InstallLines = []oar.InstallLine{
	{Line: "v1", Description: "OpenCode 1: the opencode-ai 1.x releases"},
	{Line: "v2", Description: "OpenCode 2: the @opencode/cli 2.x releases, with a new plugin and server API"},
}

func writes() []string {
	home, _ := os.UserHomeDir()
	return []string{filepath.Join(home, ".opencode", "bin")}
}

// InstallMethods is each line's install script as OpenCode documents it
// first, downloading that line's latest release to `~/.opencode/bin/opencode`,
// never prompting, and adding the folder to the shell profile when one
// exists. Each line's own `opencode upgrade` takes that path as its `curl`
// method and stays on the line. OpenCode documents no script for Windows.
var InstallMethods = map[string]shared.ScriptInstallMethod{
	"v1": {
		Source:  "https://opencode.ai/docs/#install",
		Line:    "curl -fsSL https://opencode.ai/install | bash",
		Tools:   []string{"curl", "bash"},
		Writes:  writes,
		Windows: "OpenCode recommends WSL, or npm install -g opencode-ai, Scoop or Chocolatey",
	},
	"v2": {
		Source:  "https://opencode.ai/v2/docs/",
		Line:    "curl -fsSL https://opencode.ai/v2/install | bash",
		Tools:   []string{"curl", "bash"},
		Writes:  writes,
		Windows: "OpenCode documents no script for OpenCode 2 there; its packages (npm install -g @opencode/cli) are on https://opencode.ai/v2/docs/",
	},
}

// LineOf is an installation's line from `opencode --version` (`1.18.35` on
// line 1, `opencode v2.0.26` on line 2); "" when it does not tell.
func LineOf(installation oar.AvailableInstallation) string {
	if !installation.IsExecutable() || installation.Version == "" {
		return ""
	}
	version := shared.ReleaseVersion(installation.Version)
	if version == "" {
		return ""
	}
	major, _, _ := strings.Cut(version, ".")
	for _, entry := range InstallLines {
		if entry.Line == "v"+major {
			return entry.Line
		}
	}
	return ""
}

// InstallPlan is the plan for the line the caller names.
var InstallPlan = shared.LinedInstallPlan(shared.LinedInstallMethods{Lines: InstallLines, Methods: InstallMethods}, shared.ThisMachine)

// Install runs the plan unless a copy of either line is already there.
var Install = shared.PlanInstaller(Installation, InstallPlan, LineOf)
