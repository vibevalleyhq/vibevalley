package tickets

import (
	"database/sql"

	"go.uber.org/fx"

	"vibevalley/internal/base"
	"vibevalley/internal/chat"
	"vibevalley/internal/memory"
	"vibevalley/internal/projects"
	"vibevalley/internal/runs"
)

// Without the packages above it: a test reaches only what is below.
type world struct {
	*base.App
	worldServices
}

type worldServices struct {
	fx.In

	DB            *sql.DB
	Site          *base.Site
	Store         *base.Store
	Settings      *base.Settings
	Projects      *projects.Projects
	Codebase      *projects.Codebase
	Memories      *memory.Memories
	ManagerMemory *memory.ManagerMemory
	Runtimes      *runs.Runtimes
	Tokens        *runs.Tokens
	Trajectories  *runs.Trajectories
	Crew          *runs.Crew
	Chat          *chat.Chat
	FarmTools     *chat.FarmTools
	Dispatch      *Dispatch
	Merges        *Merges
	Issues        *Issues
	PlaybookLog   *PlaybookLog
	Playbooks     *Playbooks
	Schedules     *Schedules
	Heartbeat     *Heartbeat
}

func newWorld(cfg base.Config, options ...fx.Option) (*world, error) {
	return newWorldWith(cfg, nil, options...)
}

func newWorldWith(cfg base.Config, above []base.Layer, options ...fx.Option) (*world, error) {
	w := &world{}
	layers := append([]base.Layer{projects.Module, memory.Module, runs.Module, chat.Module, Module}, above...)
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
