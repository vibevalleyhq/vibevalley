package worker

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

func Module(r *base.Readies) fx.Option {
	return fx.Module("run",
		fx.Provide(fx.Private, newWorkers, newTrajectories, newTokens),
		fx.Provide(base.Run[*Service](r, newService)),
	)
}
