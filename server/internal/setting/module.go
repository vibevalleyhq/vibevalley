package setting

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

func Module(*base.Readies) fx.Option {
	return fx.Module("setting", fx.Provide(New))
}
