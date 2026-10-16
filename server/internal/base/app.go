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

type Layer func(r *Readies) fx.Option

func Module(r *Readies) fx.Option {
	return fx.Module("base", fx.Provide(
		func(cfg Config) *Site { return NewSite(cfg.Home) },
		func(cfg Config) (*Store, error) { return NewStore(cfg.Home) },
		Run[*Settings](r, newSettings),
	))
}

// Each service is built after the services it is built from; Start starts them in that order and then readies them in the same order; Close stops
// them in reverse.
type App struct {
	Config

	app     *fx.App
	readies *Readies
	db      *sql.DB
	site    *Site
	cancel  context.CancelFunc
}

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

func (a *App) Start(ctx context.Context) error {
	ctx, a.cancel = context.WithCancel(ctx)
	return a.app.Start(ctx)
}

func (a *App) Close() {
	if a.cancel != nil {
		a.cancel()
	}
	_ = a.app.Stop(context.Background())
	a.site.Close()
	a.db.Close()
}

func (a *App) Readied() []Readier {
	a.readies.mu.Lock()
	defer a.readies.mu.Unlock()
	return slices.Clone(a.readies.all)
}
