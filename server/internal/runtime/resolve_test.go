package runtime

import (
	"context"
	"testing"

	"vibevalley/internal/agent"
	"vibevalley/internal/core"
	"vibevalley/internal/protocol"
	"vibevalley/internal/setting"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/x/ptr"
)

func TestResolveOwnsDefaultsOverridesAndModelFallback(t *testing.T) {
	cfg := fixture.Config(t.TempDir(), t.TempDir(), ":memory:")
	store, err := agent.New(cfg.Home)
	if err != nil {
		t.Fatal(err)
	}
	c := core.New(cfg.Home)
	defer c.Close()
	r, err := newService(cfg, nil, c, store, setting.New(cfg))
	if err != nil {
		t.Fatal(err)
	}
	defer r.OnStop()
	if _, err := store.SaveSettings("pi", protocol.RuntimeSettings{DefaultModel: "known", DefaultEffort: "default-effort", Env: map[string]string{"base": "kept", "override": "base"}}); err != nil {
		t.Fatal(err)
	}
	r.Probe = func(context.Context, string) protocol.RuntimeInfo {
		return protocol.RuntimeInfo{ID: "pi", Models: []protocol.ModelEntry{{ID: "known"}}}
	}
	a := protocol.Agent{ID: "a", Name: "小禾", Runtime: "pi", Env: map[string]string{"override": "profile"}}
	got, err := r.Resolve(context.Background(), a)
	if err != nil {
		t.Fatal(err)
	}
	if got.Runtime.ID != "pi" || got.Model != "known" || got.Effort != "default-effort" || *got.Env["base"] != "kept" || *got.Env["override"] != "profile" {
		t.Fatalf("resolved: %+v", got)
	}
	events, stop := c.Live()
	defer stop()
	a.Model = "unknown"
	a.Effort = "profile-effort"
	got, err = r.Resolve(context.Background(), a)
	if err != nil {
		t.Fatal(err)
	}
	if got.Model != "" || got.Effort != "profile-effort" {
		t.Fatalf("fallback: %+v", got)
	}
	if _, ok := (<-events).Value.(protocol.LiveEventNotice); !ok {
		t.Fatal("fallback did not warn")
	}
}

func TestRateOwnsCacheAccountingAndCurrency(t *testing.T) {
	rate := (Price{Input: 1, Output: 2, CacheRead: .1, CacheWrite: 1.5}).InCNY(7)
	if got := rate.Charge(oar.TokenTotals{Input: 1_000_000, CacheRead: ptr.To[int64](400_000)}); got != .64*7 {
		t.Fatalf("cache/currency: %v", got)
	}
	if got := rate.Charge(oar.TokenTotals{Input: 10, CacheRead: ptr.To[int64](20)}); got != 2.0/1_000_000*7 {
		t.Fatalf("negative uncached input: %v", got)
	}
	r := &Service{cnyPerUsd: 7}
	if r.Quote("missing", "unknown") != nil {
		t.Fatal("unknown model was priced")
	}
}
