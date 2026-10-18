package channel

import (
	"database/sql"

	"go.uber.org/fx"

	"vibevalley/internal/agent"
	"vibevalley/internal/base"
	"vibevalley/internal/core"
	"vibevalley/internal/memory"
	"vibevalley/internal/project"
	"vibevalley/internal/runtime"
	"vibevalley/internal/session"
	"vibevalley/internal/setting"
	"vibevalley/internal/testkit/fixture"
)

// Without the packages above it: a test reaches only what is below.
type world struct {
	*base.App
	worldServices
}

type worldServices struct {
	fx.In

	DB      *sql.DB
	Core    *core.Service
	Agent   *agent.Service
	Setting *setting.Service
	Project *project.Service
	Memory  *memory.Service
	Runtime *runtime.Service
	Session *session.Service
	Channel *Service
}

func newWorld(cfg base.Config, options ...fx.Option) (*world, error) {
	w := &world{}
	app, err := base.NewApp(cfg, []base.Layer{core.Module, setting.Module, agent.Module, project.Module, memory.Module, runtime.Module, session.Module, Module},
		fx.Options(options...),
		fx.Invoke(func(p *project.Service) { p.GitHubProbe = fixture.NoGitHub }),
		fx.Invoke(func(s worldServices) { w.worldServices = s }),
	)
	if err != nil {
		return nil, err
	}
	w.App = app
	return w, nil
}
