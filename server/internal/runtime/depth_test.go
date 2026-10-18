package runtime

import (
	"context"
	"os"
	"sync/atomic"
	"testing"

	"vibevalley/internal/agent"
	"vibevalley/internal/core"
	"vibevalley/internal/protocol"
	"vibevalley/internal/setting"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/smith/oar"
)

func observing(t *testing.T, adapter oar.Runtime) *Service {
	t.Helper()
	cfg := fixture.Config(t.TempDir(), t.TempDir(), ":memory:")
	store, err := agent.New(cfg.Home)
	if err != nil {
		t.Fatal(err)
	}
	c := core.New(cfg.Home)
	t.Cleanup(c.Close)
	r, err := newService(cfg, nil, c, store, setting.New(cfg))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.OnStop)
	r.Registry, err = oar.NewRuntimeRegistry(adapter)
	if err != nil {
		t.Fatal(err)
	}
	r.Probe = nil
	r.usageOf = func(context.Context, string, oar.Runtime, oar.AvailableInstallation, protocol.RuntimeSettings) protocol.AccountUsage {
		return protocol.AccountUsage{}
	}
	return r
}

func TestAcceptedObservationOwnsInstallationForUsage(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var n atomic.Int64
	r := observing(t, oar.Runtime{ID: "pi", Installation: func(context.Context, oar.InstallationOptions) (oar.InstallationSnapshot, error) {
		command := "new"
		if n.Add(1) == 1 {
			close(entered)
			<-release
			command = "old"
		}
		return oar.InstallationSnapshot{Kind: "available", Available: oar.AvailableInstallation{Via: "executable", Command: command}}, nil
	}})
	slow := make(chan struct{})
	go func() { r.Refresh(context.Background(), "pi"); close(slow) }()
	<-entered
	r.Refresh(context.Background(), "pi")
	close(release)
	<-slow
	got := r.Info(context.Background(), "pi")
	if got.Installation.Value.(protocol.InstallationAvailable).Command != "new" {
		t.Fatal("stale public installation")
	}
	used := ""
	r.usageOf = func(_ context.Context, _ string, _ oar.Runtime, found oar.AvailableInstallation, _ protocol.RuntimeSettings) protocol.AccountUsage {
		used = found.Command
		return protocol.AccountUsage{}
	}
	r.refreshUsage(context.Background(), "pi")
	if used != "new" {
		t.Fatalf("usage used a different observation: %q", used)
	}
}

func TestAssessmentUsesTheAdvertisedAdapterRestrictions(t *testing.T) {
	r := observing(t, oar.Runtime{ID: "pi", RefusedSessionOptions: oar.RefusedSessionOptions{oar.OptionEnv: "test adapter refuses env"}})
	r.Probe = func(context.Context, string) protocol.RuntimeInfo {
		return protocol.RuntimeInfo{ID: "pi", Settings: protocol.RuntimeSettings{Enabled: true}, Installation: protocol.Installation{Value: protocol.InstallationAvailable{Command: "pi"}}}
	}
	a := protocol.Agent{ID: "worker", Name: "worker", Runtime: "pi", Enabled: true, Env: map[string]string{"TEST": "value"}}
	assessment := r.Assess(context.Background(), a)
	if assessment.Info.Refused[protocol.SessionEnv] != "test adapter refuses env" {
		t.Fatalf("refusal missing: %+v", assessment.Info.Refused)
	}
	if assessment.Usable() || len(assessment.Blocking) == 0 {
		t.Fatalf("adapter refusal not enforced: %+v", assessment)
	}
	a.Env = nil
	if !r.Assess(context.Background(), a).Usable() {
		t.Fatal("allowed profile refused")
	}
	a.Enabled = false
	if r.Assess(context.Background(), a).Usable() {
		t.Fatal("disabled profile usable")
	}
}

func TestFarmPolicyRefusalsRemainAlongsideAdapterConstraints(t *testing.T) {
	r := observing(t, oar.Runtime{ID: "opencode", RefusedSessionOptions: oar.RefusedSessionOptions{oar.OptionEnv: "test env"}})
	refused := r.refusals("opencode")
	if refused[protocol.SessionDisallowedTools] != protocol.FactsOf("opencode").Refused[protocol.SessionDisallowedTools] || refused[protocol.SessionEnv] != "test env" {
		t.Fatalf("lost policy or capability: %v", refused)
	}
}

func TestTwoRuntimeConfigurationsDoNotCommunicateThroughEnvironment(t *testing.T) {
	t.Setenv("OAR_PI_BIN", "external-default")
	adapter := oar.Runtime{ID: "pi", Installation: func(_ context.Context, options oar.InstallationOptions) (oar.InstallationSnapshot, error) {
		if options.Binary == nil {
			t.Error("configured probe omitted its binary input")
			return oar.InstallationSnapshot{Kind: "not_found"}, nil
		}
		return oar.Available(oar.AvailableInstallation{Via: "executable", Command: *options.Binary}), nil
	}}
	first, second := observing(t, adapter), observing(t, adapter)
	for _, pair := range []struct {
		r   *Service
		bin string
	}{{first, "first-bin"}, {second, "second-bin"}} {
		if _, err := pair.r.store.SaveSettings("pi", protocol.RuntimeSettings{Enabled: true, BinPath: pair.bin}); err != nil {
			t.Fatal(err)
		}
	}
	done := make(chan struct{}, 2)
	for _, r := range []*Service{first, second} {
		go func() { r.Refresh(context.Background(), "pi"); done <- struct{}{} }()
	}
	<-done
	<-done
	a, err := first.Resolve(context.Background(), protocol.Agent{Runtime: "pi"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := second.Resolve(context.Background(), protocol.Agent{Runtime: "pi"})
	if err != nil {
		t.Fatal(err)
	}
	if a.Installation == nil || a.Installation.Command != "first-bin" || b.Installation == nil || b.Installation.Command != "second-bin" {
		t.Fatalf("mixed installation identities: %+v %+v", a.Installation, b.Installation)
	}
	if os.Getenv("OAR_PI_BIN") != "external-default" {
		t.Fatal("probe changed process environment")
	}
}
