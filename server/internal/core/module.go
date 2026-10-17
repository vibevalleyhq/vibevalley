package core

import (
	"go.uber.org/fx"

	"vibevalley/internal/base"
)

// Built first and closed last: state.json is written once every service has stopped.
func Module(*base.Readies) fx.Option {
	return fx.Module("core",
		fx.Provide(func(cfg base.Config, lc fx.Lifecycle) *Service {
			s := New(cfg.Home)
			lc.Append(fx.StopHook(s.Close))
			return s
		}),
		fx.Invoke(func(*Service) {}),
	)
}
