package game

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

func Module(r *base.Readies) fx.Option {
	return fx.Module("game",
		fx.Provide(fx.Private, newLedger, newCommits, newStations),
		fx.Provide(base.Run[*Service](r, newService)),
	)
}
