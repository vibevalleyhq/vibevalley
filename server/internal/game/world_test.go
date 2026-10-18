package game

import (
	"database/sql"

	"go.uber.org/fx"

	"vibevalley/internal/agent"
	"vibevalley/internal/base"
	"vibevalley/internal/channel"
	"vibevalley/internal/connector"
	"vibevalley/internal/core"
	"vibevalley/internal/gate"
	"vibevalley/internal/issue"
	"vibevalley/internal/manager"
	"vibevalley/internal/memory"
	"vibevalley/internal/project"
	"vibevalley/internal/runtime"
	"vibevalley/internal/schedule"
	"vibevalley/internal/session"
	"vibevalley/internal/setting"
	"vibevalley/internal/task"
	"vibevalley/internal/tool"
	"vibevalley/internal/voice"
)

// Without the packages above it: a test reaches only what is below.
type world struct {
	*base.App
	worldServices
}

type worldServices struct {
	fx.In

	DB        *sql.DB
	Core      *core.Service
	Agent     *agent.Service
	Setting   *setting.Service
	Project   *project.Service
	Memory    *memory.Service
	Runtime   *runtime.Service
	Session   *session.Service
	Channel   *channel.Service
	Issue     *issue.Service
	TaskGraph *task.Service
	Schedule  *schedule.Service
	Manager   *manager.Service
	Voice     *voice.Service
	Connector *connector.Service
	Gate      *gate.Service
	Game      *Service
}

func newWorld(cfg base.Config, options ...fx.Option) (*world, error) {
	w := &world{}
	app, err := base.NewApp(cfg, []base.Layer{core.Module, setting.Module, agent.Module, project.Module, memory.Module, runtime.Module, session.Module, channel.Module, schedule.Module, issue.Module, task.Module, tool.Module, manager.Module, gate.Module, voice.Module, connector.Module, Module},
		fx.Options(options...),
		fx.Invoke(func(s worldServices) { w.worldServices = s }),
	)
	if err != nil {
		return nil, err
	}
	w.App = app
	return w, nil
}
