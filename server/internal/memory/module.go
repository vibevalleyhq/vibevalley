package memory

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

func Module(r *base.Readies) fx.Option {
	return fx.Module("memory",
		fx.Provide(fx.Private, newMemories, newManagerMemory),
		fx.Provide(base.Run[*Service](r, newService)),
	)
}
