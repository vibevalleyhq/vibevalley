package protocol

import (
	"testing"

	"vibevalley/internal/testkit"
)

func TestTheFrameSaysTheWordsOnACopy(t *testing.T) {
	state := EmptyCoreState()
	state.Workers = []Worker{{ID: "w1", Phase: Phase{PhaseRipe{}}}}
	state.Schedules = []Schedule{scheduleMake()}
	frame := FrameOf(state, nil)
	testkit.Eq(t, frame.State.Workers[0].PhaseText, PhaseWords(state.Workers[0]), "the worker's words")
	testkit.Eq(t, frame.State.Schedules[0].WhenText, "每天 09:00", "the schedule's")
	testkit.Eq(t, [2]string{state.Workers[0].PhaseText, state.Schedules[0].WhenText}, [2]string{"", ""}, "the state itself keeps none")
	testkit.Eq(t, frame.Effects, []GameEffect{}, "no effects is []")
	testkit.Eq(t, len(frame.Inbox), 1, "a ripe worker asks for you")
}
