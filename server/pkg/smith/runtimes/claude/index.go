package claude

import (
	"vibevalley/pkg/smith/brands"
	"vibevalley/pkg/smith/oar"
)

// Runtime is the claude runtime (claudeRuntime, index.ts).
func Runtime() oar.Runtime {
	return oar.DefineRuntime(oar.Runtime{
		ID:         "claude",
		Brand:      brands.Of("claude"),
		Skills:     Skills,
		Commands:   Commands,
		MCPServers: MCPServers,
		Tools:      Tools,

		Installation: Installation,
		InstallPlan:  InstallPlan,
		Install:      Install,
		AccountUsage: AccountUsage,
		ListModels:   ListModels,
		CheckUpdate:  CheckUpdate,
		Upgrade:      Upgrade,
		Login:        Login,
		Logout:       Logout,
		AuthStatus:   AuthStatus,
		Session:      Session,
	})
}
