package memory

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

func Module(r *base.Readies) fx.Option {
	return fx.Module("memory", fx.Provide(
		base.Run[*Memories](r, newMemories),
		base.Run[*ManagerMemory](r, newManagerMemory),
	))
}
