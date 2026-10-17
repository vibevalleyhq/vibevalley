package game

import (
	"context"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
)

func TestBedsTheNextWorkerTakesThePlantedBed(t *testing.T) {
	f := gameOpen(t, t.TempDir())
	defer f.Close()
	if err := f.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	stationOf := func(id string) int64 {
		h := protocol.WorkerOf(f.Core.State(), id)
		if h == nil {
			return -2
		}
		return protocol.PlayOf(*h).Station
	}
	hire := func(id string) {
		f.Core.Apply(protocol.FactHired{Worker: protocol.Worker{ID: id, Name: id, Agent: "lab", Runtime: "pi", Phase: protocol.Phase{Value: protocol.PhaseArriving{}}}})
	}

	f.Game.Want(4)
	hire("w1")
	testkit.Until(t, "w1 on bed 4", func() bool { return stationOf("w1") == 4 })

	hire("w2")
	testkit.Until(t, "w2 on the first free bed", func() bool { return stationOf("w2") == 0 })

	f.Game.Want(4)
	hire("w3")
	testkit.Until(t, "w3 hired", func() bool { return stationOf("w3") >= 0 })
	hire("w4")
	testkit.Until(t, "w4 hired", func() bool { return stationOf("w4") >= 0 })
	testkit.Eq(t, stationOf("w1"), int64(4), "w1 keeps its bed")
	testkit.Eq(t, stationOf("w3"), int64(1), "a taken bed is not given again")
	testkit.Eq(t, stationOf("w4"), int64(2), "the wish is used once")
}
