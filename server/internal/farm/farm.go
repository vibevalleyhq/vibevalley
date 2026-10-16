// A package calls only into the packages before it in layers; what goes the other way is news on a base.Hub.
package farm

import (
	"context"
	"database/sql"
	"log"

	"go.uber.org/fx"

	"vibevalley/internal/base"
	"vibevalley/internal/channels"
	"vibevalley/internal/chat"
	"vibevalley/internal/game"
	"vibevalley/internal/manager"
	"vibevalley/internal/memory"
	"vibevalley/internal/projects"
	"vibevalley/internal/runs"
	"vibevalley/internal/tickets"
)

type Farm struct {
	*base.App
	services
}

// The order is the order they are built in where nothing else decides it.
type services struct {
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
	Ledger        *game.Ledger
	Commits       *game.Commits
	Crew          *runs.Crew
	Dispatch      *tickets.Dispatch
	Merges        *tickets.Merges
	Chat          *chat.Chat
	FarmTools     *chat.FarmTools
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
}

var layers = []base.Layer{
	projects.Module,
	memory.Module,
	runs.Module,
	chat.Module,
	tickets.Module,
	manager.Module,
	channels.Module,
	game.Module,
}

// options go after the farm's own (a test's fx.Decorate, fx.Replace).
func New(cfg base.Config, options ...fx.Option) (*Farm, error) {
	f := &Farm{}
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

func (f *Farm) Start(ctx context.Context) error {
	if err := f.App.Start(ctx); err != nil {
		return err
	}
	log.Printf("vibevalley server %s: helpers work under %s; settings in %s", f.Version, f.WorkRoot, f.Home)
	return nil
}
