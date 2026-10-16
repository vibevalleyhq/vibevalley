// Package defaults is the built-in runtime registry (packages/oar/src/index.ts
// defaultRuntimes): every runtime OAR builds without the host's help.
package defaults

import "vibevalley/pkg/smith/oar"

// Runtimes is the built-in runtime list, in registry order.
func Runtimes() []oar.Runtime {
	return builtins()
}

// Registry is the built-in registry.
func Registry() *oar.RuntimeRegistry {
	registry, err := oar.NewRuntimeRegistry(Runtimes()...)
	if err != nil {
		panic(err)
	}
	return registry
}
