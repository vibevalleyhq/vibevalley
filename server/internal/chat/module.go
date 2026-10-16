package chat

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

func Module(r *base.Readies) fx.Option {
	return fx.Module("chat", fx.Provide(
		base.Run[*Chat](r, newChat),
		base.Run[*FarmTools](r, newFarmTools),
	))
}
