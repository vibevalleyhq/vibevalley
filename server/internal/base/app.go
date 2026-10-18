package base

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"os"
	"slices"
	"sync"

	"go.uber.org/fx"
)

type Layer func(r *Readies) fx.Option

// Each service is built after the services it is built from; Start starts them in that order and then readies them in the same order; Close stops
// them in reverse.
type App struct {
	Config

	app       *fx.App
	readies   *Readies
	db        *sql.DB
	cancel    context.CancelFunc
	homeLease *os.File
	closing   sync.Once
}

func NewApp(cfg Config, layers []Layer, options ...fx.Option) (*App, error) {
	if cfg.Home == "" || cfg.WorkRoot == "" {
		return nil, errors.New("farm: Home and WorkRoot are required")
	}
	if err := os.MkdirAll(cfg.Home, 0o755); err != nil {
		return nil, err
	}
	lease, err := leaseHome(cfg.Home)
	if err != nil {
		return nil, err
	}
	constructed := false
	defer func() {
		if !constructed {
			lease.Close()
		}
	}()
	if err := os.MkdirAll(cfg.ProjectsDir(), 0o755); err != nil {
		return nil, err
	}
	cfg.DBPath = cfg.DB()
	a := &App{Config: cfg, readies: &Readies{}, homeLease: lease}
	var all []fx.Option
	for _, layer := range layers {
		all = append(all, layer(a.readies))
	}
	a.app = fx.New(
		fx.NopLogger,
		fx.Supply(cfg),
		fx.Supply(a.readies),
		fx.Provide(func() (*sql.DB, error) {
			var err error
			// Kept as soon as it is open: closed again when a service cannot be built.
			a.db, err = OpenDB(cfg.DBPath)
			return a.db, err
		}),
		fx.Options(all...),
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
	constructed = true
	return a, nil
}

func (a *App) Start(ctx context.Context) error {
	ctx, a.cancel = context.WithCancel(ctx)
	if err := a.app.Start(ctx); err != nil {
		a.cancel()
		return err
	}
	return nil
}

func (a *App) Close() {
	a.closing.Do(func() {
		if a.cancel != nil {
			a.cancel()
		}
		if err := a.app.Stop(context.Background()); err != nil {
			log.Printf("vibevalley: stopping: %v", err)
		}
		if a.db != nil {
			a.db.Close()
		}
		// Every service's final write and the database close happen before another farm can open this home.
		a.homeLease.Close()
	})
}

func (a *App) Readied() []Readier {
	a.readies.mu.Lock()
	defer a.readies.mu.Unlock()
	return slices.Clone(a.readies.all)
}
