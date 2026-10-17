package gate

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

func Module(r *base.Readies) fx.Option {
	return fx.Module("gate", fx.Provide(base.Run[*Service](r, newService)))
}
