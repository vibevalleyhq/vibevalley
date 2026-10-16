// Package farm is the vibevalley server (ported from the TypeScript server, removed): every package of services,
// assembled on one lifecycle (base.App), and the HTTP layer that answers for them.
//
// The services are in packages by what they are about (docs/concepts.md): the work itself first, the game drawn over
// it last. A package calls only into the packages above it in this list; what goes the other way is news on a
// base.Hub (the state's facts, the runs' activity, the chat's and the plans' news for the manager):
//
//	base      the database, Site (the state and its facts), Store (config.json: agent profiles, runtime settings,
//	          skills), Settings (keys, voice); the lifecycle (App, Run) and what every service shares
//	projects  Projects (the repositories, their worktrees, how many may work in each), Codebase
//	memory    Memories, ManagerMemory: what the agent profiles and the manager remember
//	runs      Runtimes, Crew (the sessions working tickets), Trajectories (their steps, the tickets' heads), Tokens
//	chat      Chat (the square, channels, tickets' threads), FarmTools (/mcp: how a run speaks in it)
//	tickets   Issues (the issue book: 工单), Dispatch (who goes, the queue, reopening), Merges (changes, harvests),
//	          Playbooks and PlaybookLog (plans), Schedules, Heartbeat (the patrol)
//	manager   Foreman
//	channels  VoiceLine, Voice, Connectors (WeChat, Feishu, QQ), Lan (the yard gate)
//	game      Ledger (coins, streaks, achievements), Commits (the level): it follows the others' facts; no service
//	          calls it, only the HTTP layer, for what the person does in the app
//
// The HTTP layer (package handler) answers through Farm, which holds them all.
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

// Farm is every service on one lifecycle; its fields are theirs.
type Farm struct {
	*base.App
	services
}

// services is every service, as fx hands them over; Farm's fields are theirs. The order is the order they are built in
// where nothing else decides it.
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

// layers is every package of services but base (which every App has), in the package's order.
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

// New builds the farm: every service, each after the services it is built from. options go after the farm's own (a
// test's fx.Decorate, fx.Replace).
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

// Start starts every service's background work (watching helpers, timers, connectors) on a context Close cancels.
func (f *Farm) Start(ctx context.Context) error {
	if err := f.App.Start(ctx); err != nil {
		return err
	}
	log.Printf("vibevalley server %s: helpers work under %s; settings in %s", f.Version, f.WorkRoot, f.Home)
	return nil
}
