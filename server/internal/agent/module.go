package agent

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

func Module(*base.Readies) fx.Option {
	return fx.Module("agent", fx.Provide(func(cfg base.Config) (*Service, error) { return New(cfg.Home) }))
}
