package protocol

import (
	"testing"

	"vibevalley/internal/testkit"
)

func TestStationOnlyToAFreeBed(t *testing.T) {
	state := EmptyCoreState()
	for _, id := range []string{"w1", "w2"} {
		state, _ = Reduce(state, Fact{FactHired{At: 1, Session: Session{ID: id, Name: id, Phase: Phase{PhaseArriving{}}}}})
	}
	stationOf := func(s CoreState, id string) int64 { return PlayOf(*SessionOf(s, id)).Station }
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

// A plot is an issue being worked: the view keys it by the issue, so another session on the same issue is the same plot.
func TestPlotsAreKeyedByTheirIssue(t *testing.T) {
	issue := "i1"
	first := Session{ID: "w1", Issue: &issue, Phase: Phase{Value: PhaseRipe{}}}
	loose := Session{ID: "w2", Phase: Phase{Value: PhaseArriving{}}}
	plots := ViewOf(CoreState{Sessions: []Session{first, loose}}).Plots
	if _, ok := plots["i1"]; !ok {
		t.Fatalf("the issue's plot: %v", plots)
	}
	if _, ok := plots["w2"]; !ok {
		t.Fatalf("a session with no issue is its own plot: %v", plots)
	}
	again := Session{ID: "w3", Issue: &issue, Phase: Phase{Value: PhaseArriving{}}}
	if got := ViewOf(CoreState{Sessions: []Session{again}}).Plots["i1"].Crop; got != CropSeeded {
		t.Fatalf("the next session on it draws on the same plot: %v", got)
	}
}
