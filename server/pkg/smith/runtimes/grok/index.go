// Package grok is the Grok runtime (packages/oar/src/runtimes/grok): xAI's
// `grok agent stdio` over the shared ACP session (internal/acp), with its
// installation probe, installer, inventory, account usage, model listing
// and updater.
package grok

import (
	"vibevalley/pkg/smith/brands"
	"vibevalley/pkg/smith/oar"
)

// Runtime is the grok runtime (index.ts grokRuntime).
func Runtime() oar.Runtime {
	return oar.DefineRuntime(oar.Runtime{
		ID:                    "grok",
		Brand:                 brands.Of("grok"),
		RefusedSessionOptions: RefusedSessionOptions,
		Skills:                Skills,
		MCPServers:            MCPServers,

		Installation: Installation,
		InstallPlan:  InstallPlan,
		Install:      Install,
		AccountUsage: AccountUsage,
		ListModels:   ListModels,
		CheckUpdate:  CheckUpdate,
		Upgrade:      Upgrade,
		Session:      Session,
	})
}
