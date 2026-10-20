package doc

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

func Module(r *base.Readies) fx.Option {
	return fx.Module("doc", fx.Provide(base.Run[*Service](r, newService)))
}
