package session

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

func Module(r *base.Readies) fx.Option {
	return fx.Module("run",
		fx.Provide(fx.Private, newSessions, newTrajectories, newTokens),
		fx.Provide(base.Run[*Service](r, newService)),
	)
}
