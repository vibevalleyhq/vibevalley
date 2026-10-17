package session

import (
	"context"
	"testing"

	"go.uber.org/fx"

	"vibevalley/internal/agent"
	"vibevalley/internal/base"
	"vibevalley/internal/core"
	"vibevalley/internal/memory"
	"vibevalley/internal/project"
	"vibevalley/internal/protocol"
	"vibevalley/internal/runtime"
	"vibevalley/internal/setting"
	"vibevalley/internal/testkit/fixture"
)

func TestPendingTurnReservesCapacityUntilWorkingFact(t *testing.T) {
	cfg := fixture.Config(t.TempDir(), t.TempDir(), ":memory:")
	cfg.Project.MaxSessions = 1
	var c *Service
	app, err := base.NewApp(cfg, []base.Layer{core.Module, setting.Module, agent.Module, project.Module, memory.Module, runtime.Module, Module}, fx.Populate(&c))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.sessions.core.Close(); app.Close() })
	name := "demo"
	c.sessions.core.Apply(protocol.FactHired{Session: protocol.Session{ID: "w1", Agent: "lab", Runtime: "pi", Project: &name, Phase: protocol.Phase{Value: protocol.PhaseRipe{}}}})
	h := &hand{id: "w1"}
	c.hands[h.id] = h
	c.expect(h, protocol.RunTrigger{Kind: protocol.RunTriggerKindComment})
	if why := c.NoRoom("pi", name); why == "" {
		t.Fatal("pending turn did not reserve capacity")
	}
	if current := c.sessions.core.Session(h.id); current == nil {
		t.Fatal("capacity check removed the session")
	} else if _, ripe := current.Phase.Value.(protocol.PhaseRipe); !ripe {
		t.Fatalf("capacity projection changed the core phase: %T", current.Phase.Value)
	}
	if _, err := c.Merge(h.id); err == nil {
		t.Fatal("pending turn accepted for harvest before its working fact")
	}
	for _, phase := range []string{"pending", "started"} {
		if phase == "started" {
			c.sessions.core.Apply(protocol.FactRun{ID: h.id})
			c.unexpect(h)
		}
		got := c.Send(context.Background(), fixture.Lab(t), "another", name, HireOptions{})
		if got.Session != nil || got.Refused == "" {
			t.Fatalf("%s turn did not reserve capacity: %+v", phase, got)
		}
		if c.hired != 0 {
			t.Fatalf("%s admission touched allocation before refusing", phase)
		}
	}
	c.sessions.core.Apply(protocol.FactReport{ID: h.id, Outcome: protocol.OutcomeCompleted})
	if why := c.NoRoom("pi", name); why != "" {
		t.Fatalf("ended turn kept its slot: %s", why)
	}
}
