package manager

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

func Module(r *base.Readies) fx.Option {
	return fx.Module("manager", fx.Provide(base.Run[*Foreman](r, newForeman)))
}
