package base

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"slices"

	"go.uber.org/fx"
)

// Layer is a package's services, each on the farm's lifecycle (Run with the Readies it is handed): every package of
// services has one, its Module.
type Layer func(r *Readies) fx.Option

// Module is base's services: Site, Store, Settings. NewApp always has them, with the config and the database.
func Module(r *Readies) fx.Option {
	return fx.Module("base", fx.Provide(
		func(cfg Config) *Site { return NewSite(cfg.Home) },
		func(cfg Config) (*Store, error) { return NewStore(cfg.Home) },
		Run[*Settings](r, newSettings),
	))
}

// App is services on one lifecycle, assembled by fx (go.uber.org/fx): the config, the database, base's services and
// the layers' services, each built after the services it is built from. Start starts them in that order and then
// readies them in the same order; Close stops them in the reverse order. The farm is an App with every layer; a test
// builds one with the layers below what it tests.
type App struct {
	Config

	app     *fx.App
	readies *Readies
	db      *sql.DB
	site    *Site
	cancel  context.CancelFunc
}

// NewApp builds the services; options go after the layers (an fx.Invoke taking the services, a test's fx.Decorate or
// fx.Replace).
func NewApp(cfg Config, layers []Layer, options ...fx.Option) (*App, error) {
	if cfg.Home == "" || cfg.WorkRoot == "" {
		return nil, errors.New("farm: Home and WorkRoot are required")
	}
	if err := os.MkdirAll(cfg.Home, 0o755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(cfg.WorkRoot, 0o755); err != nil {
		return nil, err
	}
	if cfg.DBPath == "" {
		cfg.DBPath = filepath.Join(cfg.Home, "farm.db")
	}
	a := &App{Config: cfg, readies: &Readies{}}
	all := []fx.Option{Module(a.readies)}
	for _, layer := range layers {
		all = append(all, layer(a.readies))
	}
	a.app = fx.New(
		fx.NopLogger,
		fx.Supply(cfg),
		fx.Provide(func() (*sql.DB, error) {
			var err error
			// Kept as soon as it is open: closed again when a service cannot be built.
			a.db, err = OpenDB(cfg.DBPath)
			return a.db, err
		}),
		fx.Options(all...),
		fx.Invoke(func(s *Site) { a.site = s }),
		fx.Options(options...),
		// Last, so its hook runs once every service has started.
		fx.Invoke(a.readies.hook),
	)
	if err := a.app.Err(); err != nil {
		if a.db != nil {
			a.db.Close()
		}
		return nil, err
	}
	return a, nil
}

// Start starts every service's background work (watching helpers, timers, connectors) on a context Close cancels.
func (a *App) Start(ctx context.Context) error {
	ctx, a.cancel = context.WithCancel(ctx)
	return a.app.Start(ctx)
}

// Close stops the services in the reverse order, saves the state and closes the database.
func (a *App) Close() {
	if a.cancel != nil {
		a.cancel()
	}
	_ = a.app.Stop(context.Background())
	a.site.Close()
	a.db.Close()
}

// Readied is the services readied at Start, in the order they were.
func (a *App) Readied() []Readier {
	a.readies.mu.Lock()
	defer a.readies.mu.Unlock()
	return slices.Clone(a.readies.all)
}
