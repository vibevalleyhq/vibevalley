package opencode

import (
	"vibevalley/pkg/smith/brands"
	"vibevalley/pkg/smith/oar"
)

// Runtime is the opencode runtime (index.ts opencodeRuntime).
func Runtime() oar.Runtime {
	return oar.DefineRuntime(oar.Runtime{
		ID:                    "opencode",
		Brand:                 brands.Of("opencode"),
		RefusedSessionOptions: RefusedSessionOptions,
		Installation:          Installation,
		InstallPlan:           InstallPlan,
		Install:               Install,
		InstallLines:          InstallLines,
		Session:               Session,
		ListModels:            ListModels,
	})
}
