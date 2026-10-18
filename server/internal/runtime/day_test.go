package runtime

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"vibevalley/internal/agent"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/ptr"
)

func TestCachedBudgetResetsWithTheDay(t *testing.T) {
	info := protocol.RuntimeInfo{ID: "pi", Settings: protocol.RuntimeSettings{DailyBudget: ptr.To(10.0)}, SpentToday: ptr.To(12.0), Stop: "yesterday's budget"}
	r := &Service{cache: map[string]observation{"pi": {Info: info}}, spent: spend{Day: "2000-01-01", ByRuntime: map[string]float64{"pi": 12}}}
	got := r.Info(context.Background(), "pi")
	if got.SpentToday != nil || got.Stop != "" {
		t.Fatalf("yesterday still blocks dispatch: %+v", got)
	}
	r.spent.ByRuntime["pi"] = 3
	got = r.Info(context.Background(), "pi")
	if got.SpentToday == nil || *got.SpentToday != 3 {
		t.Fatalf("cache hides today's spending: %+v", got)
	}
}

func TestUpdateReportsPersistenceFailureWithoutProbing(t *testing.T) {
	home := t.TempDir()
	store, err := agent.New(home)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(home, "config.json")
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(file, 0700); err != nil {
		t.Fatal(err)
	}
	r := &Service{store: store, Probe: func(context.Context, string) protocol.RuntimeInfo {
		t.Fatal("probed after failed save")
		return protocol.RuntimeInfo{}
	}}
	info, err := r.Update(context.Background(), "pi", protocol.RuntimeSettings{DefaultModel: "unsaved"})
	if err == nil || info != nil {
		t.Fatalf("failed update returned success: %v %v", info, err)
	}
	if store.Settings("pi").DefaultModel == "unsaved" {
		t.Fatal("failed setting is visible")
	}
}
