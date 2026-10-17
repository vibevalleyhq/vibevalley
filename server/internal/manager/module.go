package manager

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

func Module(r *base.Readies) fx.Option {
	return fx.Module("manager",
		fx.Provide(fx.Private, newPatrol, newManager),
		fx.Provide(base.Run[*Service](r, newService)),
	)
}
