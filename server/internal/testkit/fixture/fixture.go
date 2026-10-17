// Package fixture is what the tests start from: a config in temporary folders, the seed agent (lab) and runtime (pi) they
// hire. Only tests import it.
package fixture

import (
	"testing"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
)

// The defaults, in home and work, with the database at db (":memory:" or a file).
func Config(home, work, db string) base.Config {
	c := base.Defaults()
	c.Home, c.WorkRoot, c.DBPath = home, work, db
	return c
}

func Pi() protocol.RuntimeInfo {
	return protocol.RuntimeInfo{
		ID:           "pi",
		Installation: protocol.Installation{Value: protocol.InstallationAvailable{Via: protocol.ViaBundled, Command: "pi"}},
		Settings:     protocol.RuntimeSettings{Enabled: true, Env: map[string]string{}},
	}
}

// A scripted runtime has no models, so no effort levels: smith would refuse 'medium'.
func Lab(t testing.TB) protocol.Agent {
	for _, a := range protocol.SeedAgents() {
		if a.ID == "lab" {
			a.Effort = ""
			return a
		}
	}
	t.Fatal("the seeds have the pi agent")
	return protocol.Agent{}
}
