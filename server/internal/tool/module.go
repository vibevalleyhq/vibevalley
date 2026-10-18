package tool

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

func Module(r *base.Readies) fx.Option {
	return fx.Module("tool", fx.Provide(base.Run[*Service](r, newService)))
}
