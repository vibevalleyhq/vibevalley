package game

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

func Module(r *base.Readies) fx.Option {
	return fx.Module("game", fx.Provide(
		base.Run[*Ledger](r, newLedger),
		base.Run[*Commits](r, newCommits),
	))
}
