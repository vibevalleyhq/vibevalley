// Package kimi is the Kimi Code runtime (packages/oar/src/runtimes/kimi):
// `kimi acp` driven through the shared ACP layer (internal/acp), with its
// installation probe, installer, account usage, model listing and updater.
package kimi

import (
	"vibevalley/pkg/smith/brands"
	"vibevalley/pkg/smith/oar"
)

// Runtime is the kimi runtime (index.ts kimiRuntime).
func Runtime() oar.Runtime {
	return oar.DefineRuntime(oar.Runtime{
		ID:                    "kimi",
		Brand:                 brands.Of("kimi"),
		Installation:          Installation,
		InstallPlan:           InstallPlan,
		Install:               Install,
		AccountUsage:          AccountUsage,
		ListModels:            ListModels,
		CheckUpdate:           CheckUpdate,
		Upgrade:               Upgrade,
		Session:               Session,
		RefusedSessionOptions: RefusedSessionOptions,
	})
}
