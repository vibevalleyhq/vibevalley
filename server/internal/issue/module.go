package issue

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

func Module(r *base.Readies) fx.Option {
	return fx.Module("issue",
		fx.Provide(fx.Private, newIssues, newDispatch, newMerges, newDrafts),
		fx.Provide(base.Run[*Service](r, newService)),
	)
}
