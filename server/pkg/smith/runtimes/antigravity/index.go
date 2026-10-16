// Package antigravity is the Antigravity runtime (packages/oar/src/runtimes/antigravity):
// Google's agy_acp_server over ACP (internal/acp).
package antigravity

import (
	"vibevalley/pkg/smith/brands"
	"vibevalley/pkg/smith/oar"
)

// Runtime is the antigravity runtime (index.ts antigravityRuntime).
func Runtime() oar.Runtime {
	return oar.DefineRuntime(oar.Runtime{
		ID:                    "antigravity",
		Brand:                 brands.Of("antigravity"),
		Installation:          Installation,
		InstallPlan:           InstallPlan,
		Install:               Install,
		Session:               Session,
		ListModels:            ListModels,
		CheckUpdate:           CheckUpdate,
		RefusedSessionOptions: RefusedSessionOptions,
	})
}
