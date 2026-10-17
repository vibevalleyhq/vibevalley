// A package calls only into the packages before it in layers; what goes the other way is news on a base.Hub.
package workspace

import (
	"context"
	"database/sql"
	"log"

	"go.uber.org/fx"

	"vibevalley/internal/agent"
	"vibevalley/internal/base"
	"vibevalley/internal/channel"
	"vibevalley/internal/connector"
	"vibevalley/internal/core"
	"vibevalley/internal/game"
	"vibevalley/internal/gate"
	"vibevalley/internal/issue"
	"vibevalley/internal/manager"
	"vibevalley/internal/mcp"
	"vibevalley/internal/memory"
	"vibevalley/internal/playbook"
	"vibevalley/internal/project"
	"vibevalley/internal/runtime"
	"vibevalley/internal/schedule"
	"vibevalley/internal/setting"
	"vibevalley/internal/voice"
	"vibevalley/internal/worker"
)

type Workspace struct {
	*base.App
	services
}

// The order is the order they are built in where nothing else decides it.
type services struct {
	fx.In

	DB        *sql.DB
	Core      *core.Service
	Agent     *agent.Service
	Setting   *setting.Service
	Project   *project.Service
	Memory    *memory.Service
	Runtime   *runtime.Service
	Game      *game.Service
	Worker    *worker.Service
	Issue     *issue.Service
	Channel   *channel.Service
	Playbook  *playbook.Service
	Schedule  *schedule.Service
	Manager   *manager.Service
	Voice     *voice.Service
	Connector *connector.Service
	Gate      *gate.Service
	MCP       *mcp.Service
}

var layers = []base.Layer{
	core.Module, setting.Module, agent.Module,
	project.Module,
	memory.Module,
	runtime.Module,
	worker.Module,
	channel.Module,
	schedule.Module,
	issue.Module,
	playbook.Module,
	manager.Module,
	gate.Module,
	voice.Module,
	connector.Module,
	game.Module,
	mcp.Module,
}

// options go after the farm's own (a test's fx.Decorate, fx.Replace).
func New(cfg base.Config, options ...fx.Option) (*Workspace, error) {
	f := &Workspace{}
	app, err := base.NewApp(cfg, layers,
		fx.Options(options...),
		fx.Invoke(func(s services) { f.services = s }),
	)
	if err != nil {
		return nil, err
	}
	f.App = app
	return f, nil
}

func (f *Workspace) Start(ctx context.Context) error {
	if err := f.App.Start(ctx); err != nil {
		return err
	}
	log.Printf("vibevalley server %s: workers work under %s; settings in %s", f.Version, f.WorkRoot, f.Home)
	return nil
}
