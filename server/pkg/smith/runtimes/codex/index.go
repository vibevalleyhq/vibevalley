package codex

import (
	"vibevalley/pkg/smith/brands"
	"vibevalley/pkg/smith/oar"
)

// Runtime is the codex runtime (codexRuntime, index.ts).
func Runtime() oar.Runtime {
	return oar.DefineRuntime(oar.Runtime{
		ID:         "codex",
		Brand:      brands.Of("codex"),
		Skills:     Skills,
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
