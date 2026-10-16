package runs

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

// Module is the package's services, each on the farm's lifecycle.
func Module(r *base.Readies) fx.Option {
	return fx.Module("runs", fx.Provide(
		base.Run[*Runtimes](r, newRuntimes),
		base.Run[*Crew](r, newCrew),
		base.Run[*Trajectories](r, newTrajectories),
		base.Run[*Tokens](r, newTokens),
	))
}
