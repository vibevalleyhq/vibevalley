package task

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

func Module(r *base.Readies) fx.Option {
	return fx.Module("task",
		fx.Provide(fx.Private, newTaskLog, newTasks),
		fx.Provide(base.Run[*Service](r, newService)),
	)
}
