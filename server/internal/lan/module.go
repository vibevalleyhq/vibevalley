package lan

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

func Module(r *base.Readies) fx.Option {
	return fx.Module("lan", fx.Provide(base.Run[*Service](r, newService)))
}
