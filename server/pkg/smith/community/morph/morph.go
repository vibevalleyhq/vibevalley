// Package morph is the Mister Morph community runtime
// (packages/oar/src/community/morph), driven through its Console Runtime
// API (docs/runtimes/morph.md). Not in the built-in registry; a host adds
// Runtime() to its own.
package morph

import (
	"vibevalley/pkg/smith/brands"
	"vibevalley/pkg/smith/oar"
)

// Runtime is the morph runtime.
func Runtime() oar.Runtime {
	return oar.DefineRuntime(oar.Runtime{
		ID:                    "morph",
		Brand:                 brands.Of("morph"),
		Installation:          Installation,
		ListModels:            ListModels,
		Session:               Session,
		RefusedSessionOptions: RefusedSessionOptions,
	})
}
