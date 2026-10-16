package game

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

// Module is the package's services, each on the farm's lifecycle.
func Module(r *base.Readies) fx.Option {
	return fx.Module("game", fx.Provide(
		base.Run[*Ledger](r, newLedger),
		base.Run[*Commits](r, newCommits),
	))
}
