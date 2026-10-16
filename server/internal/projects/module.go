package projects

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

func Module(r *base.Readies) fx.Option {
	return fx.Module("projects", fx.Provide(
		base.Run[*Projects](r, newProjects),
		base.Run[*Codebase](r, newCodebase),
	))
}
