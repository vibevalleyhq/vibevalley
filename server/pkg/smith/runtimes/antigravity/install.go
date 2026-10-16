package antigravity

import (
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// InstallPlan: Google documents installing the Antigravity agent only from
// inside an editor (Zed: agent settings, External Agents, Install from
// Registry; https://antigravity.google/docs/ide/extensions/zed), which also
// signs it in through the browser. There is no command-line installer: the
// ACP registry's zip is what the editor unpacks.
var InstallPlan = shared.UnsupportedInstallPlan(oar.InstallPlan{
	Kind:   "unsupported",
	Reason: "requires_gui",
	Detail: "Google installs the Antigravity agent from an editor's agent registry (Zed: External Agents, Install from Registry); https://antigravity.google/docs/ide/extensions/zed",
})

// Install answers the plan's refusal unless a copy is already installed.
var Install = shared.PlanInstaller(Installation, InstallPlan, nil)
