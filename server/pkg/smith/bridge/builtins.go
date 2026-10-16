package bridge

import (
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/runtimes/defaults"
)

// builtins is the built-in runtime list the bridge serves besides `scripted`.
func builtins() []oar.Runtime {
	return defaults.Runtimes()
}
