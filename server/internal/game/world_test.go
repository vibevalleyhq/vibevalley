package game

import (
	"database/sql"

	"go.uber.org/fx"

	"vibevalley/internal/base"
	"vibevalley/internal/channels"
	"vibevalley/internal/chat"
	"vibevalley/internal/manager"
	"vibevalley/internal/memory"
	"vibevalley/internal/projects"
	"vibevalley/internal/runs"
	"vibevalley/internal/tickets"
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
	Dispatch      *tickets.Dispatch
	Merges        *tickets.Merges
	Issues        *tickets.Issues
	PlaybookLog   *tickets.PlaybookLog
	Playbooks     *tickets.Playbooks
	Schedules     *tickets.Schedules
	Heartbeat     *tickets.Heartbeat
	Foreman       *manager.Foreman
	VoiceLine     *channels.VoiceLine
	Voice         *channels.Voice
	Connectors    *channels.Connectors
	Lan           *channels.Lan
	Ledger        *Ledger
	Commits       *Commits
}

func newWorld(cfg base.Config, options ...fx.Option) (*world, error) {
	w := &world{}
	app, err := base.NewApp(cfg, []base.Layer{projects.Module, memory.Module, runs.Module, chat.Module, tickets.Module, manager.Module, channels.Module, Module},
		fx.Options(options...),
		fx.Invoke(func(s worldServices) { w.worldServices = s }),
	)
	if err != nil {
		return nil, err
	}
	w.App = app
	return w, nil
}
