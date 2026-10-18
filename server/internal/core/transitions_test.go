package core

import (
	"testing"

	"vibevalley/internal/protocol"
)

func TestBatchPublishesFinalStateWithPerFactTransitions(t *testing.T) {
	c := New(t.TempDir())
	defer c.Close()
	snapshot, changes, stop := c.Transitions()
	defer stop()
	_, events, stopEvents := c.Events()
	defer stopEvents()
	if len(snapshot.Sessions) != 0 {
		t.Fatal("snapshot not empty")
	}
	c.ApplyBatch(
		protocol.FactHired{Session: protocol.Session{ID: "first", Phase: protocol.Phase{Value: protocol.PhaseArriving{}}}},
		protocol.FactHired{Session: protocol.Session{ID: "second", Phase: protocol.Phase{Value: protocol.PhaseArriving{}}}},
	)
	for i := range 2 {
		change := <-changes
		if len(change.Before.Sessions) != i || len(change.After.Sessions) != i+1 {
			t.Fatalf("transition %d: before %d after %d", i, len(change.Before.Sessions), len(change.After.Sessions))
		}
		if len(c.State().Sessions) != 2 {
			t.Fatal("observer saw a partial commit")
		}
		if _, ok := (<-events).Value.(protocol.FactHired); !ok {
			t.Fatal("wire fact missing")
		}
	}
	c.Apply(protocol.FactLeft{ID: "first"})
	change := <-changes
	if len(change.Before.Sessions) != 2 || len(change.After.Sessions) != 1 || len(snapshot.Sessions) != 0 {
		t.Fatal("transition/snapshot mutated by a later apply")
	}
}
