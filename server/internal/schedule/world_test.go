package schedule

import (
	"database/sql"
	"testing"

	"go.uber.org/fx"

	"vibevalley/internal/agent"
	"vibevalley/internal/base"
	"vibevalley/internal/channel"
	"vibevalley/internal/core"
	"vibevalley/internal/memory"
	"vibevalley/internal/project"
	"vibevalley/internal/runtime"
	"vibevalley/internal/session"
	"vibevalley/internal/setting"
	"vibevalley/internal/testkit/fixture"
)

// Without the packages above it: a test reaches only what is below.
type world struct {
	*base.App
	worldServices
}

type worldServices struct {
	fx.In

	DB       *sql.DB
	Core     *core.Service
	Channel  *channel.Service
	Schedule *Service
}

func open(t *testing.T, home string) *world {
	t.Helper()
	w := &world{}
	app, err := base.NewApp(fixture.Config(home, t.TempDir(), ""), []base.Layer{core.Module, setting.Module, agent.Module, project.Module, memory.Module, runtime.Module, session.Module, channel.Module, Module},
		fx.Invoke(func(p *project.Service) { p.GitHubProbe = fixture.NoGitHub }),
		fx.Invoke(func(s worldServices) { w.worldServices = s }),
	)
	if err != nil {
		t.Fatal(err)
	}
	w.App = app
	return w
}
