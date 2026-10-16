// Package pi is the pi runtime (packages/oar/src/runtimes/pi). The TS
// package embeds pi's SDK in process; the Go port runs that same SDK in a
// small Node host (host/pi-host.mjs) loaded from the pi the user installed.
package pi

import (
	"vibevalley/pkg/smith/brands"
	"vibevalley/pkg/smith/oar"
)

// Runtime is the pi runtime. Account usage is absent: pi runs on provider
// API keys and has no subscription usage surface to observe.
func Runtime() oar.Runtime {
	return oar.DefineRuntime(oar.Runtime{
		ID:                    "pi",
		Brand:                 brands.Of("pi"),
		RefusedSessionOptions: RefusedSessionOptions,
		Skills:                Skills,
		Commands:              Commands,
		Tools:                 Tools,
		Installation:          Installation,
		ListModels:            ListModels,
		Session:               Session,
	})
}
