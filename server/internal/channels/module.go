package channels

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

func Module(r *base.Readies) fx.Option {
	return fx.Module("channels", fx.Provide(
		base.Run[*VoiceLine](r, newVoiceLine),
		base.Run[*Voice](r, newVoice),
		base.Run[*Connectors](r, newConnectors),
		base.Run[*Lan](r, newLan),
	))
}
