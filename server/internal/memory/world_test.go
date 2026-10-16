package memory

import (
	"database/sql"

	"go.uber.org/fx"

	"vibevalley/internal/base"
	"vibevalley/internal/projects"
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
	Memories      *Memories
	ManagerMemory *ManagerMemory
}

func newWorld(cfg base.Config, options ...fx.Option) (*world, error) {
	w := &world{}
	app, err := base.NewApp(cfg, []base.Layer{projects.Module, Module},
		fx.Options(options...),
		fx.Invoke(func(s worldServices) { w.worldServices = s }),
	)
	if err != nil {
		return nil, err
	}
	w.App = app
	return w, nil
}
