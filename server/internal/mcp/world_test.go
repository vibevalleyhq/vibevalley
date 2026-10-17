package mcp

import (
	"context"
	"strings"
	"sync"
	"testing"

	"go.uber.org/fx"

	"vibevalley/internal/agent"
	"vibevalley/internal/base"
	"vibevalley/internal/channel"
	"vibevalley/internal/core"
	"vibevalley/internal/issue"
	"vibevalley/internal/memory"
	"vibevalley/internal/project"
	"vibevalley/internal/protocol"
	"vibevalley/internal/runtime"
	"vibevalley/internal/schedule"
	"vibevalley/internal/session"
	"vibevalley/internal/setting"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/oartest"
)

// Without the packages above it: a test reaches only what is below. Sessions run on a scripted pi that keeps the token each session is handed.
type world struct {
	*base.App
	worldServices
	ctx context.Context

	mu     sync.Mutex
	tokens map[string]string
}

type worldServices struct {
	fx.In

	Core    *core.Service
	Agent   *agent.Service
	Runtime *runtime.Service
	Channel *channel.Service
	Issue   *issue.Service
	MCP     *Service
}

func open(t *testing.T) *world {
	t.Helper()
	w := &world{ctx: context.Background(), tokens: map[string]string{}}
	cfg := fixture.Config(t.TempDir(), t.TempDir(), ":memory:")
	cfg.Patrol.HeartbeatMinutes = 0
	app, err := base.NewApp(cfg, []base.Layer{core.Module, setting.Module, agent.Module, project.Module, memory.Module, runtime.Module, session.Module, channel.Module, schedule.Module, issue.Module, Module},
		fx.Invoke(func(s worldServices) { w.worldServices = s }),
	)
	if err != nil {
		t.Fatal(err)
	}
	w.App = app
	pi := oartest.Runtime(oartest.Options{ID: "pi", Turn: func(turn *oartest.Turn) error {
		for _, s := range turn.Options.MCPServers {
			if s.Name == "vibevalley" {
				w.mu.Lock()
				w.tokens[turn.Options.Cwd] = strings.TrimPrefix(s.Headers["authorization"], "Bearer ")
				w.mu.Unlock()
			}
		}
		turn.Say("做完了")
		return nil
	}})
	registry, err := oar.NewRuntimeRegistry(pi)
	if err != nil {
		t.Fatal(err)
	}
	w.Runtime.Registry = registry
	w.Runtime.Probe = func(_ context.Context, id string) protocol.RuntimeInfo {
		if id != "pi" {
			return protocol.RuntimeInfo{ID: id, Installation: protocol.Installation{Value: protocol.InstallationNotFound{}}, Settings: w.Agent.Settings(id)}
		}
		return fixture.Pi()
	}
	lab := fixture.Lab(t)
	lab.Enabled = true
	if _, err := w.Agent.SaveAgent(lab); err != nil {
		t.Fatal(err)
	}
	if err := w.Start(w.ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	return w
}
