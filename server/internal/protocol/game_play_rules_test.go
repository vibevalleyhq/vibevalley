package protocol

import (
	"testing"

	"vibevalley/internal/testkit"
)

func TestStationOnlyToAFreeBed(t *testing.T) {
	state := EmptyCoreState()
	for _, id := range []string{"w1", "w2"} {
		state, _ = Reduce(state, Fact{FactHired{At: 1, Worker: Worker{ID: id, Name: id, Phase: Phase{PhaseArriving{}}}}})
	}
	stationOf := func(s CoreState, id string) int64 { return PlayOf(*WorkerOf(s, id)).Station }
	testkit.Eq(t, stationOf(state, "w1"), int64(0))
	testkit.Eq(t, stationOf(state, "w2"), int64(1))

	moved, changed := Reduce(state, Fact{FactStation{At: 2, ID: "w2", Station: 4}})
	testkit.Eq(t, changed, true)
	testkit.Eq(t, stationOf(moved, "w2"), int64(4))

	for _, f := range []FactStation{{ID: "w2", Station: 0}, {ID: "w2", Station: 1}, {ID: "w2", Station: MaxRunning}, {ID: "w2", Station: -1}, {ID: "w9", Station: 3}} {
		if _, changed := Reduce(state, Fact{f}); changed {
			t.Fatalf("%+v changed the farm", f)
		}
	}
}
