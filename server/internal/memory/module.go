package memory

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

// Module is the package's services, each on the farm's lifecycle.
func Module(r *base.Readies) fx.Option {
	return fx.Module("memory", fx.Provide(
		base.Run[*Memories](r, newMemories),
		base.Run[*ManagerMemory](r, newManagerMemory),
	))
}
