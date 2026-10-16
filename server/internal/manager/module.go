package manager

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

// Module is the package's services, each on the farm's lifecycle.
func Module(r *base.Readies) fx.Option {
	return fx.Module("manager", fx.Provide(base.Run[*Foreman](r, newForeman)))
}
