package workspace

import (
	"context"
	"sync"
	"testing"

	"vibevalley/internal/session"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/oartest"
)

func TestSessionsReachTheFarmWhereItAnswers(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	var mu sync.Mutex
	var urls []string
	registry, _ := oar.NewRuntimeRegistry(oartest.Runtime(oartest.Options{ID: "pi", Turn: func(turn *oartest.Turn) error {
		mu.Lock()
		for _, s := range turn.Options.MCPServers {
			if s.Name == "vibevalley" {
				urls = append(urls, s.URL)
			}
		}
		mu.Unlock()
		turn.Say("好")
		return nil
	}}))
	w.f.Runtime.Registry = registry

	first := mustHire(t, w.f.Issue.Hire(context.Background(), fixture.Lab(t), "看看", "reach", session.HireOptions{}))
	w.nextReport(t)
	w.f.Session.SetAddress("127.0.0.1:54321")
	mustHire(t, w.f.Issue.Hire(context.Background(), fixture.Lab(t), "再看看", "reach", session.HireOptions{}))
	w.nextReport(t)
	w.f.Session.Dismiss(first.ID)

	mu.Lock()
	defer mu.Unlock()
	testkit.Eq(t, urls, []string{"http://127.0.0.1:8787/mcp", "http://127.0.0.1:54321/mcp"}, "the farm's tools")
}

func TestFarmURLFollowsHostAndPort(t *testing.T) {
	cfg := fixture.Config(t.TempDir(), t.TempDir(), ":memory:")
	cfg.Host, cfg.Port = "localhost", 9100
	f, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer f.DB.Close()
	testkit.Eq(t, f.Session.FarmURL(), "http://localhost:9100/mcp", "host and port")
}
