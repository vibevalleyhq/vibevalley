package playbook

import (
	"database/sql"

	"go.uber.org/fx"

	"vibevalley/internal/agent"
	"vibevalley/internal/base"
	"vibevalley/internal/channel"
	"vibevalley/internal/core"
	"vibevalley/internal/issue"
	"vibevalley/internal/memory"
	"vibevalley/internal/project"
	"vibevalley/internal/runtime"
	"vibevalley/internal/schedule"
	"vibevalley/internal/setting"
	"vibevalley/internal/worker"
)

// Without the packages above it: a test reaches only what is below.
type world struct {
	*base.App
	worldServices
}

type worldServices struct {
	fx.In

	DB       *sql.DB
	Core     *core.Service
	Agent    *agent.Service
	Setting  *setting.Service
	Project  *project.Service
	Memory   *memory.Service
	Runtime  *runtime.Service
	Worker   *worker.Service
	Channel  *channel.Service
	Issue    *issue.Service
	Playbook *Service
	Schedule *schedule.Service
}

func newWorldWith(cfg base.Config, above []base.Layer, options ...fx.Option) (*world, error) {
	w := &world{}
	layers := append([]base.Layer{core.Module, setting.Module, agent.Module, project.Module, memory.Module, runtime.Module, worker.Module, channel.Module, schedule.Module, issue.Module, Module}, above...)
	app, err := base.NewApp(cfg, layers,
		fx.Options(options...),
		fx.Invoke(func(s worldServices) { w.worldServices = s }),
	)
	if err != nil {
		return nil, err
	}
	w.App = app
	return w, nil
}
