package farm

import (
	"context"
	"sync"
	"testing"

	"vibevalley/internal/base"
	"vibevalley/internal/farmtest"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/oartest"
)

// Where helpers reach the farm: as the TypeScript server did (crew.ts's FarmUrl).

func TestCrewSessionsReachTheFarmWhereItAnswers(t *testing.T) {
	t.Setenv("HOST", "")
	t.Setenv("PORT", "")
	home, work := crewDirs(t)
	w := crewOpen(t, home, work)
	var mu sync.Mutex
	var urls []string
	registry, _ := oar.NewRuntimeRegistry(oartest.Runtime(oartest.Options{ID: "pi", Turn: func(turn *oartest.Turn) error {
		mu.Lock()
		for _, s := range turn.Options.MCPServers {
			if s.Name == "farm" {
				urls = append(urls, s.URL)
			}
		}
		mu.Unlock()
		turn.Say("好")
		return nil
	}}))
	w.f.Runtimes.Registry = registry

	// HOST and PORT unset: the server's defaults, 127.0.0.1:8787.
	first := crewHired(t, w.f.Dispatch.Hire(context.Background(), farmtest.Lab(t), "看看", "reach", base.HireOptions{}))
	w.nextReport(t)
	// A farm on a port of its own (PORT=0, or a host that picks a free one) says where it is.
	w.f.Crew.SetAddress("127.0.0.1:54321")
	crewHired(t, w.f.Dispatch.Hire(context.Background(), farmtest.Lab(t), "再看看", "reach", base.HireOptions{}))
	w.nextReport(t)
	w.f.Crew.Dismiss(first.ID)

	mu.Lock()
	defer mu.Unlock()
	farmtest.Eq(t, urls, []string{"http://127.0.0.1:8787/mcp", "http://127.0.0.1:54321/mcp"}, "the farm's tools")
}

func TestCrewFarmURLFollowsHostAndPort(t *testing.T) {
	t.Setenv("HOST", "localhost")
	t.Setenv("PORT", "9100")
	f, err := New(base.Config{Home: t.TempDir(), WorkRoot: t.TempDir(), DBPath: ":memory:"})
	if err != nil {
		t.Fatal(err)
	}
	defer f.DB.Close()
	farmtest.Eq(t, f.Crew.FarmURL(), "http://localhost:9100/mcp", "HOST and PORT")
}
