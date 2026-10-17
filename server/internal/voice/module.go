package voice

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

func Module(r *base.Readies) fx.Option {
	return fx.Module("voice",
		fx.Provide(fx.Private, newVoiceLine, newVoice),
		fx.Provide(base.Run[*Service](r, newService)),
	)
}
