package playbook

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

func Module(r *base.Readies) fx.Option {
	return fx.Module("playbook",
		fx.Provide(fx.Private, newPlaybookLog, newPlaybooks),
		fx.Provide(base.Run[*Service](r, newService)),
	)
}
